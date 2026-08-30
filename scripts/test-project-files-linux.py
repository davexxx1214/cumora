"""Run project-file checks on an isolated Linux scratch DB/Redis/filesystem.

Requires paramiko locally. Host, known-host verification and private key are
explicit. Never loads a deployment .env, changes the deployment, or resets its DB.
"""
import argparse
import io
from pathlib import Path, PurePosixPath
import shlex
import socket
import sys
import tarfile
import uuid

import paramiko

REMOTE = r'''
import json, os, pathlib, shutil, signal, socket, subprocess, tarfile, tempfile
archive = pathlib.Path(ARCHIVE)
root = pathlib.Path(tempfile.mkdtemp(prefix='cumora-project-files-test-'))
pg = None
redis = None
def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]
def run(argv, **kw):
    timeout = kw.pop('timeout', None)
    process = subprocess.Popen(argv, start_new_session=True, **kw)
    try:
        status = process.wait(timeout=timeout)
        if status: raise subprocess.CalledProcessError(status, argv)
    finally:
        # Test children can otherwise keep SSH pipes open after a timeout.
        # Only signal the process group created by this exact helper call.
        if process.poll() is None or pathlib.Path(argv[0]).name in ('node', 'nodejs'):
            try: os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError: pass
        process.wait()
try:
    repo = root / 'repo'
    repo.mkdir()
    with tarfile.open(archive) as tar:
        for member in tar.getmembers():
            target = (repo / member.name).resolve()
            if not target.is_relative_to(repo) or not (member.isfile() or member.isdir()):
                raise RuntimeError('unsafe test archive')
        tar.extractall(repo, filter='data')
    os.symlink('/workspace/cumora/node_modules', repo / 'node_modules')
    bins = sorted(pathlib.Path('/usr/lib/postgresql').glob('*/bin/initdb'))
    if not bins: raise RuntimeError('isolated PostgreSQL binaries not found')
    pg_bin = bins[-1].parent
    pgdata = root / 'pgdata'
    pgport, redisport = port(), port()
    while redisport == pgport: redisport = port()
    (root / 'socket').mkdir()
    run([str(pg_bin/'initdb'), '-D', str(pgdata), '--auth=trust', '--no-locale', '--username=cumora_test'], stdout=subprocess.DEVNULL)
    run([str(pg_bin/'pg_ctl'), '-D', str(pgdata), '-l', str(root/'postgres.log'), '-o',
        f'-h 127.0.0.1 -p {pgport} -k {root / "socket"}', '-w', 'start'], stdout=subprocess.DEVNULL)
    pg = pgdata
    run([str(pg_bin/'createdb'), '-h', '127.0.0.1', '-p', str(pgport), '-U', 'cumora_test', 'cumora_project_files_test'])
    redis = subprocess.Popen(['redis-server', '--bind', '127.0.0.1', '--port', str(redisport), '--save', '', '--appendonly', 'no', '--dir', str(root)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    node = shutil.which('node')
    env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(root), 'NODE_ENV': 'test',
        'OPENAI_API_KEY': 'isolated-test-key', 'OPENAI_BASE_URL': 'http://127.0.0.1:1/v1',
        'DATABASE_URL': f'postgresql://cumora_test@127.0.0.1:{pgport}/cumora_project_files_test',
        'REDIS_URL': f'redis://127.0.0.1:{redisport}', 'AGENT_RUNTIME_SECRET': 'isolated-project-file-test-secret',
        'CUMORA_PROJECT_FILES_ENABLED': '1', 'CUMORA_PROJECT_FILES_ROOT': str(root/'objects')}
    if (repo / 'agent-fuse/projectfs').is_dir():
        binary = root / 'project-fuse.test'
        run(['go', 'test', '-c', '-o', str(binary), './projectfs'], cwd=repo/'agent-fuse', timeout=120)
        env['CUMORA_PROJECT_FUSE_TEST_BIN'] = str(binary)
        runner = root / 'bin/project-task'
        enter = root / 'bin/task-enter'
        run(['sh', str(repo/'scripts/build-project-task.sh'), str(root/'bin')], timeout=120)
        env['CUMORA_PROJECT_TASK_BIN'] = str(runner)
        env['CUMORA_PROJECT_TASK_ENTER'] = str(enter)
    env['TMPDIR'] = str(root)
    if ENGINE_SMOKE or GROK_SMOKE:
        env['CUMORA_PROJECT_AUTH_HOME'] = str(pathlib.Path.home())
    if ENGINE_SMOKE:
        env['CUMORA_PROJECT_ENGINE_SMOKE'] = '1'
        env['CUMORA_PROJECT_ENGINE_BINARY'] = str(pathlib.Path.home() / '.local/bin/codex')
    if GROK_SMOKE:
        env['CUMORA_PROJECT_GROK_SMOKE'] = '1'
        env['CUMORA_PROJECT_GROK_BINARY'] = str((pathlib.Path.home() / '.grok/bin/grok').resolve())
    if GIT_NETWORK_SMOKE:
        env['CUMORA_PROJECT_GIT_NETWORK_SMOKE'] = '1'
    if any('project-files.test.ts' in t for t in TESTS):
        document_libs = root / 'python-documents'
        run(['python3', '-m', 'pip', 'install', '--disable-pip-version-check', '--no-cache-dir', '--quiet', '--target', str(document_libs),
             'python-docx==1.2.0', 'openpyxl==3.1.5', 'pypdf==6.0.0', 'reportlab==4.4.3'], timeout=120)
        env['CUMORA_PROJECT_DOCUMENT_LIBS'] = str(document_libs)
    print('Running in isolated PostgreSQL, Redis and file directories; deployment is unchanged.', flush=True)
    if UNIT:
        unit_env = {**env, 'CUMORA_PROJECT_FILES_ENABLED': '0'}
        run(['npm', 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', str(root/'npm-cache')],
            cwd=repo/'workers/email-gate', env=unit_env, timeout=90, stdout=subprocess.DEVNULL)
        unit_files = sorted(str(p.relative_to(repo)) for base in ['server/src/__tests__', 'workers'] for p in (repo/base).rglob('*.test.ts'))
        run([node, '--import', 'tsx', '--test', *unit_files], cwd=repo, env=unit_env, timeout=180)
    for iteration in range(REPEAT):
        for test in TESTS:
            filters = ['--test-name-pattern', MATCH] if MATCH else []
            run([node, '--import', 'tsx', '--test', *filters, test], cwd=repo, env=env, timeout=180)
finally:
    if redis is not None:
        redis.terminate()
        try: redis.wait(timeout=10)
        except subprocess.TimeoutExpired:
            redis.kill(); redis.wait(timeout=5)
    if pg is not None:
        subprocess.run([str(pg_bin/'pg_ctl'), '-D', str(pg), '-m', 'immediate', '-w', 'stop'], stdout=subprocess.DEVNULL, timeout=20)
    if root.parent == pathlib.Path(tempfile.gettempdir()) and root.name.startswith('cumora-project-files-test-'):
        shutil.rmtree(root)
    archive.unlink(missing_ok=True)
    print('Isolated test services stopped and scratch directory removed.', flush=True)
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', required=True)
    parser.add_argument('--port', type=int, default=22)
    parser.add_argument('--connect-host', default='',
                        help='Optional TCP endpoint for a pre-established SSH forward; host-key identity stays --host')
    parser.add_argument('--connect-port', type=int, default=0)
    parser.add_argument('--user', required=True)
    parser.add_argument('--key', type=Path, required=True)
    parser.add_argument('--proxy-command', default='',
                        help='Optional SSH ProxyCommand; %h and %p are replaced with host and port')
    parser.add_argument('--test', action='append', default=[])
    parser.add_argument('--unit', action='store_true', help='Also run the existing unit suite in the isolated Linux environment')
    parser.add_argument('--engine-smoke', action='store_true', help='Opt in to one real Codex task using host model authentication, isolated test files only')
    parser.add_argument('--grok-smoke', action='store_true', help='Opt in to one real Grok task using host model authentication, isolated test files only')
    parser.add_argument('--git-network-smoke', action='store_true',
                        help='Opt in to cloning a small public HTTPS repository through the project Git service')
    parser.add_argument('--match', default='', help='Only run tests matching this Node test-name pattern')
    parser.add_argument('--repeat', type=int, default=1, choices=range(1, 21))
    args = parser.parse_args()
    repo = Path(__file__).resolve().parent.parent
    tests = args.test or ['server/src/__tests__/project-files-preflight.test.ts',
                         'server/src/__tests__/project-files-workspace.test.ts',
                         'server/src/__integration__/project-files.test.ts']
    for test in tests:
        if not (repo / test).is_file() or not (repo / test).resolve().is_relative_to(repo / 'server' / 'src'):
            raise RuntimeError('test must be a repository server/src file')
    # Keep the normalized key in memory; never write or print a credential copy.
    key_text = args.key.read_text().replace('\r', '').strip() + '\n'
    key = None
    for cls in (paramiko.Ed25519Key, paramiko.RSAKey, paramiko.ECDSAKey):
        try:
            key = cls.from_private_key(io.StringIO(key_text))
            break
        except (paramiko.SSHException, ValueError):
            continue
    if key is None: raise RuntimeError('unsupported private key format')
    payload = io.BytesIO()
    with tarfile.open(fileobj=payload, mode='w:gz') as tar:
        def add_source(path, relative):
            if any(part in ('node_modules', '.env', '.git', '__pycache__') for part in PurePosixPath(relative).parts): return
            if path.is_symlink(): return
            if path.is_dir():
                for child in sorted(path.iterdir()): add_source(child, f'{relative}/{child.name}')
            elif path.is_file():
                content = path.read_bytes()
                # Match a Linux Git checkout, including LF-sensitive source
                # tests, when this runner is invoked from an autocrlf checkout.
                if path.suffix in ('.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.sh', '.go', '.c', '.md') or path.name.endswith('Dockerfile'):
                    content = content.replace(b'\r\n', b'\n')
                info = tar.gettarinfo(str(path), arcname=relative)
                info.size = len(content)
                tar.addfile(info, io.BytesIO(content))
        for relative in ['server/src', 'server/docker', 'src', 'workers', 'electron', 'agent-fuse', 'package.json',
                         'server/tsconfig.json', 'tsconfig.json', 'tsconfig.node.json', 'scripts/guard-big-brain.mjs', 'scripts/build-project-task.sh']:
            add_source(repo / relative, relative)
    remote_archive = f'/tmp/cumora-project-files-{uuid.uuid4()}.tar.gz'
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    # RejectPolicy is intentional. Do not accept an unknown/changed host key.
    proxy = None
    forwarded = None
    if args.proxy_command:
        command = args.proxy_command.replace('%h', args.host).replace('%p', str(args.port))
        proxy = paramiko.ProxyCommand(command)
    elif args.connect_host:
        forwarded = socket.create_connection((args.connect_host, args.connect_port or args.port), timeout=15)
    client.connect(args.host, port=args.port, username=args.user, pkey=key, look_for_keys=False,
                   allow_agent=False, timeout=15, sock=proxy or forwarded)
    try:
        with client.open_sftp() as sftp:
            payload.seek(0)
            sftp.putfo(payload, remote_archive)
            sftp.chmod(remote_archive, 0o600)
        code = 'ARCHIVE = ' + repr(remote_archive) + '\nTESTS = ' + repr(tests) + '\nUNIT = ' + repr(args.unit) + '\nENGINE_SMOKE = ' + repr(args.engine_smoke) + '\nGROK_SMOKE = ' + repr(args.grok_smoke) + '\nGIT_NETWORK_SMOKE = ' + repr(args.git_network_smoke) + '\nMATCH = ' + repr(args.match) + '\nREPEAT = ' + repr(args.repeat) + '\n' + REMOTE
        channel = client.get_transport().open_session()
        channel.set_combine_stderr(True)
        channel.exec_command('python3 -u -c ' + shlex.quote(code))
        with channel.makefile('rb') as output:
            while chunk := output.read(4096):
                sys.stdout.buffer.write(chunk); sys.stdout.buffer.flush()
        return channel.recv_exit_status()
    finally:
        client.close()
        if proxy is not None:
            proxy.close()
        if forwarded is not None:
            forwarded.close()


if __name__ == '__main__':
    raise SystemExit(main())

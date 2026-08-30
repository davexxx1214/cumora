#!/usr/bin/env python3
"""Small user-space supervisor for the Grok Bot validation host.

The Grok Bot container does not run systemd.  This process owns the web/API
development stack and the Cloudflare connector, and restarts either child if
it exits.  A platform routine (or an operator) must still invoke
bin/ensure-running.sh after the whole container is rebuilt.
"""

from __future__ import annotations

import fcntl
import os
import pathlib
import signal
import subprocess
import threading
import time


STACK = pathlib.Path("/workspace/cumora-stack")
RUN_DIR = STACK / "run"
CHILD_DIR = RUN_DIR / "children"
LOG_DIR = STACK / "logs"
BIN_DIR = STACK / "bin"
SECRETS_DIR = STACK / "secrets"
REPO = pathlib.Path("/workspace/cumora")
TOKEN_FILE = SECRETS_DIR / "cloudflared-token"
START_DEPS = BIN_DIR / "start-deps.sh"

for directory in (RUN_DIR, CHILD_DIR, LOG_DIR):
    directory.mkdir(parents=True, exist_ok=True)

os.umask(0o077)
lock = (RUN_DIR / "supervisor.lock").open("w")
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    raise SystemExit(0)
(RUN_DIR / "supervisor.pid").write_text(str(os.getpid()))

stopping = False
children_lock = threading.Lock()
children: dict[str, subprocess.Popen[bytes]] = {}
deps_lock = threading.Lock()


def log(message: str) -> None:
    print(f"[{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}] {message}", flush=True)


def runtime_env() -> dict[str, str]:
    env = os.environ.copy()
    parts = [part for part in env.get("PATH", "").split(":") if part]
    for extra in reversed(["/usr/bin", "/usr/local/bin", "/bin"]):
        if extra not in parts:
            parts.insert(0, extra)
    env["PATH"] = ":".join(parts)
    return env


def read_matching_pid(path: pathlib.Path, marker: str) -> int | None:
    try:
        pid = int(path.read_text().strip())
        cmdline = (pathlib.Path("/proc") / str(pid) / "cmdline").read_bytes().replace(b"\0", b" ").decode(
            "utf-8", errors="replace"
        )
    except (FileNotFoundError, PermissionError, ProcessLookupError, ValueError, OSError):
        return None
    return pid if marker in cmdline else None


def record_child(name: str, pid: int) -> pathlib.Path:
    path = CHILD_DIR / f"{name}.pid"
    path.write_text(str(pid))
    return path


def forget_child(path: pathlib.Path, pid: int) -> None:
    try:
        if int(path.read_text().strip()) == pid:
            path.unlink(missing_ok=True)
    except (FileNotFoundError, ValueError, OSError):
        pass


def ensure_dependencies() -> bool:
    with deps_lock:
        result = subprocess.run([str(START_DEPS)], check=False)
    if result.returncode:
        log(f"dependency bootstrap failed with exit {result.returncode}")
        return False
    return True


def terminate(proc: subprocess.Popen[bytes]) -> None:
    if proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        try:
            proc.terminate()
        except ProcessLookupError:
            return
    for _ in range(30):
        if proc.poll() is not None:
            return
        time.sleep(0.1)
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        try:
            proc.kill()
        except ProcessLookupError:
            pass


def stop(_signum: int, _frame: object) -> None:
    global stopping
    stopping = True
    with children_lock:
        active = list(children.values())
    for proc in active:
        terminate(proc)


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)


def supervise(name: str, command: list[str], cwd: pathlib.Path | None, log_file: pathlib.Path) -> None:
    env = runtime_env()
    while not stopping:
        if not ensure_dependencies():
            time.sleep(15)
            continue
        with log_file.open("ab", buffering=0) as output:
            log(f"starting {name}")
            proc = subprocess.Popen(
                command,
                cwd=cwd,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=output,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            with children_lock:
                children[name] = proc
            child_pid_file = record_child(name, proc.pid)
            code = proc.wait()
            with children_lock:
                children.pop(name, None)
            forget_child(child_pid_file, proc.pid)
        if not stopping:
            log(f"{name} exited with {code}; restarting in 5 seconds")
            time.sleep(5)


def supervise_project_daemon(command: list[str], log_file: pathlib.Path) -> None:
    """Run the paired daemon once, or observe an orphan left by a killed parent."""

    pid_file = RUN_DIR / "project-daemon.pid"
    observed_pid: int | None = None
    while not stopping:
        existing_pid = read_matching_pid(pid_file, "project-daemon-supervisor.py")
        if existing_pid is not None:
            if observed_pid != existing_pid:
                log(f"observing existing project-daemon {existing_pid}")
                observed_pid = existing_pid
            time.sleep(2)
            continue
        observed_pid = None
        if not ensure_dependencies():
            time.sleep(15)
            continue
        with log_file.open("ab", buffering=0) as output:
            log("starting project-daemon")
            proc = subprocess.Popen(
                command,
                env=runtime_env(),
                stdin=subprocess.DEVNULL,
                stdout=output,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            with children_lock:
                children["project-daemon"] = proc
            child_pid_file = record_child("project-daemon", proc.pid)
            code = proc.wait()
            with children_lock:
                children.pop("project-daemon", None)
            forget_child(child_pid_file, proc.pid)
        if not stopping:
            log(f"project-daemon exited with {code}; restarting in 5 seconds")
            time.sleep(5)


if not TOKEN_FILE.is_file():
    raise SystemExit(f"missing Cloudflare token file: {TOKEN_FILE}")

specs: list[tuple[str, list[str], pathlib.Path | None, pathlib.Path]] = [
    ("cumora", ["npm", "run", "dev:all"], REPO, LOG_DIR / "cumora.log"),
    (
        "cloudflared",
        [
            "/workspace/cloudflared",
            "tunnel",
            "--no-autoupdate",
            "--metrics",
            "127.0.0.1:20242",
            "run",
            "--token-file",
            str(TOKEN_FILE),
        ],
        None,
        LOG_DIR / "cloudflared.log",
    ),
]

threads = [
    threading.Thread(target=supervise, name=name, args=(name, command, cwd, log_file), daemon=False)
    for name, command, cwd, log_file in specs
]
# Pairing belongs to the current Cumora database. Enable this marker only after
# a fresh computer.json has been stored in the durable secret directory and the
# reviewed runtime settings have been written to project-daemon.env. A daemon
# orphaned by a killed main supervisor remains valid; observe that singleton
# until it exits instead of starting a lock-failing process every five seconds.
if (SECRETS_DIR / "project-daemon.enabled").exists():
    threads.append(
        threading.Thread(
            target=supervise_project_daemon,
            name="project-daemon",
            args=(
                ["/usr/bin/python3", str(BIN_DIR / "project-daemon-supervisor.py"), "daemon"],
                LOG_DIR / "project-daemon.log",
            ),
            daemon=False,
        )
    )
for thread in threads:
    thread.start()

try:
    while not stopping:
        time.sleep(0.5)
finally:
    stopping = True
    with children_lock:
        active = list(children.values())
    for proc in active:
        terminate(proc)
    for thread in threads:
        thread.join(timeout=15)

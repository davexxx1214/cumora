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
LOG_DIR = STACK / "logs"
BIN_DIR = STACK / "bin"
SECRETS_DIR = STACK / "secrets"
REPO = pathlib.Path("/workspace/cumora")
TOKEN_FILE = SECRETS_DIR / "cloudflared-token"
START_DEPS = BIN_DIR / "start-deps.sh"

for directory in (RUN_DIR, LOG_DIR):
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
            code = proc.wait()
            with children_lock:
                children.pop(name, None)
        if not stopping:
            log(f"{name} exited with {code}; restarting in 5 seconds")
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

# Pairing belongs to the current Cumora database. Enable this marker only after
# a fresh computer.json has been stored in the durable secret directory and the
# reviewed runtime settings have been written to project-daemon.env.
if (SECRETS_DIR / "project-daemon.enabled").exists():
    specs.append(
        (
            "project-daemon",
            ["/usr/bin/python3", str(BIN_DIR / "project-daemon-supervisor.py"), "daemon"],
            None,
            LOG_DIR / "project-daemon.log",
        )
    )

threads = [
    threading.Thread(target=supervise, name=name, args=(name, command, cwd, log_file), daemon=False)
    for name, command, cwd, log_file in specs
]
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

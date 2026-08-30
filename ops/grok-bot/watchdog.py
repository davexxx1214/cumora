#!/usr/bin/env python3
"""Independent liveness watchdog for the Grok Bot validation stack.

This process is deliberately not a child of ``supervise.py``. It repairs a
missing or wedged supervisor inside the current container. It cannot start
itself after the whole Grok Bot computer is rebuilt; that still needs a Grok
Routine or an operator to invoke ``ensure-running.sh``.
"""

from __future__ import annotations

import fcntl
import os
import pathlib
import signal
import subprocess
import sys
import time
import urllib.request


STACK = pathlib.Path("/workspace/cumora-stack")
RUN_DIR = STACK / "run"
LOG_DIR = STACK / "logs"
ENSURE_RUNNING = STACK / "bin" / "ensure-running.sh"
SUPERVISOR_PID_FILE = RUN_DIR / "supervisor.pid"
WATCHDOG_PID_FILE = RUN_DIR / "watchdog.pid"
CHILD_DIR = RUN_DIR / "children"

CHECK_INTERVAL_SECONDS = max(5, int(os.environ.get("CUMORA_WATCHDOG_INTERVAL_SECONDS", "15")))
FAILURE_LIMIT = max(2, int(os.environ.get("CUMORA_WATCHDOG_FAILURE_LIMIT", "4")))
HEALTH_URLS = (
    "http://127.0.0.1:5181/api/health",
    "http://127.0.0.1:20242/ready",
)
CHILD_MARKERS: dict[str, tuple[str, ...]] = {
    "cumora": ("npm", "dev:all"),
    "cloudflared": ("/workspace/cloudflared", "tunnel"),
    "project-daemon": ("project-daemon-supervisor.py",),
}

RUN_DIR.mkdir(parents=True, exist_ok=True)
LOG_DIR.mkdir(parents=True, exist_ok=True)
CHILD_DIR.mkdir(parents=True, exist_ok=True)
os.umask(0o077)


def log(message: str) -> None:
    print(f"[{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}] {message}", flush=True)


def read_pid(path: pathlib.Path) -> int | None:
    try:
        raw = path.read_text().strip()
        pid = int(raw)
        return pid if pid > 1 else None
    except (FileNotFoundError, ValueError, OSError):
        return None


def command_line(pid: int) -> str | None:
    try:
        return (pathlib.Path("/proc") / str(pid) / "cmdline").read_bytes().replace(b"\0", b" ").decode(
            "utf-8", errors="replace"
        )
    except (FileNotFoundError, PermissionError, ProcessLookupError, OSError):
        return None


def process_matches(pid: int | None, markers: tuple[str, ...]) -> bool:
    if pid is None:
        return False
    cmdline = command_line(pid)
    return cmdline is not None and all(marker in cmdline for marker in markers)


def supervisor_pid() -> int | None:
    pid = read_pid(SUPERVISOR_PID_FILE)
    return pid if process_matches(pid, ("/workspace/cumora-stack/supervise.py",)) else None


def terminate_process_group(pid: int, label: str) -> None:
    try:
        pgid = os.getpgid(pid)
    except ProcessLookupError:
        return
    if pgid != pid:
        log(f"refusing to terminate unexpected {label} process group: pid={pid}, pgid={pgid}")
        return
    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        return
    for _ in range(30):
        if command_line(pid) is None:
            return
        time.sleep(0.1)
    try:
        os.killpg(pgid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def cleanup_recorded_children() -> None:
    """Stop only children whose pid and command still match our registry."""

    for name, markers in CHILD_MARKERS.items():
        path = CHILD_DIR / f"{name}.pid"
        pid = read_pid(path)
        if process_matches(pid, markers):
            log(f"cleaning orphaned {name} process group {pid}")
            terminate_process_group(pid, name)
        path.unlink(missing_ok=True)


def endpoint_healthy(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            return response.status == 200
    except Exception:
        return False


def stop_supervisor(pid: int) -> None:
    log(f"restarting unhealthy supervisor {pid}")
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    for _ in range(100):
        if not process_matches(pid, ("/workspace/cumora-stack/supervise.py",)):
            return
        time.sleep(0.1)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def ensure_stack() -> bool:
    try:
        result = subprocess.run([str(ENSURE_RUNNING)], check=False, timeout=180)
    except (OSError, subprocess.TimeoutExpired) as exc:
        log(f"ensure-running failed: {exc}")
        return False
    if result.returncode:
        log(f"ensure-running exited with {result.returncode}")
        return False
    return True


if "--cleanup-orphans" in sys.argv[1:]:
    cleanup_recorded_children()
    raise SystemExit(0)

lock = (RUN_DIR / "watchdog.lock").open("w")
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    raise SystemExit(0)

WATCHDOG_PID_FILE.write_text(str(os.getpid()))
stopping = False


def stop(_signum: int, _frame: object) -> None:
    global stopping
    stopping = True


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)

failures = 0
log("watchdog started")
try:
    while not stopping:
        pid = supervisor_pid()
        if pid is None:
            log("supervisor is missing; recovering stack")
            cleanup_recorded_children()
            ensure_stack()
            failures = 0
        else:
            failed_urls = [url for url in HEALTH_URLS if not endpoint_healthy(url)]
            if failed_urls:
                failures += 1
                if failures == 1 or failures >= FAILURE_LIMIT:
                    log(f"health failure {failures}/{FAILURE_LIMIT}: {', '.join(failed_urls)}")
                if failures >= FAILURE_LIMIT:
                    stop_supervisor(pid)
                    cleanup_recorded_children()
                    ensure_stack()
                    failures = 0
            else:
                failures = 0

        for _ in range(CHECK_INTERVAL_SECONDS):
            if stopping:
                break
            time.sleep(1)
finally:
    if read_pid(WATCHDOG_PID_FILE) == os.getpid():
        WATCHDOG_PID_FILE.unlink(missing_ok=True)
    log("watchdog stopped")

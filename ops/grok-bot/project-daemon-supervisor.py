#!/usr/bin/env python3
"""Restart the paired Cumora computer daemon after its child exits."""

from __future__ import annotations

import fcntl
import os
import pathlib
import signal
import subprocess
import time
import urllib.request


STACK = pathlib.Path("/workspace/cumora-stack")
REPO = pathlib.Path("/workspace/cumora")
ENV_FILE = STACK / "secrets" / "project-daemon.env"
RUN_DIR = STACK / "run"
RUN_DIR.mkdir(parents=True, exist_ok=True)
lock_file = (RUN_DIR / "project-daemon.lock").open("w")
try:
    fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    raise SystemExit(0)
(RUN_DIR / "project-daemon.pid").write_text(str(os.getpid()))
stopping = False
child: subprocess.Popen[bytes] | None = None


def load_env(path: pathlib.Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator:
            raise RuntimeError(f"invalid environment line for {key}")
        result[key.strip()] = value
    return result


def api_healthy() -> bool:
    try:
        with urllib.request.urlopen("http://127.0.0.1:5181/api/health", timeout=2) as response:
            return 200 <= response.status < 300
    except Exception:
        return False


def stop(_signum: int, _frame: object) -> None:
    global stopping
    stopping = True
    if child is not None and child.poll() is None:
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)

delay = 1
while not stopping:
    while not stopping and not api_healthy():
        time.sleep(2)
    if stopping:
        break
    if not ENV_FILE.is_file():
        raise SystemExit(f"missing project daemon environment: {ENV_FILE}")
    env = os.environ.copy()
    env.update(load_env(ENV_FILE))
    env["PATH"] = "/home/box/.local/bin:/home/box/.grok/bin:" + env.get("PATH", "")
    command = [
        str(REPO / "bin" / "cumora"),
        "agent",
        "computer",
        "--server",
        "http://127.0.0.1:5181",
    ]
    child = subprocess.Popen(command, cwd=REPO, env=env, start_new_session=True)
    code = child.wait()
    child = None
    if stopping:
        break
    print(f"project daemon exited with {code}; restarting in {delay}s", flush=True)
    time.sleep(delay)
    delay = min(delay * 2, 15)

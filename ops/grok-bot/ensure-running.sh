#!/bin/bash
set -euo pipefail

STACK=/workspace/cumora-stack
RUN_DIR="$STACK/run"
LOG_DIR="$STACK/logs"
PID_FILE="$RUN_DIR/supervisor.pid"
WATCHDOG_PID_FILE="$RUN_DIR/watchdog.pid"

install -d -m 700 "$RUN_DIR" "$LOG_DIR"
exec 9>"$RUN_DIR/ensure-running.lock"
flock 9

process_matches() {
  local pid_file=$1
  local expected_arg=$2
  [ -s "$pid_file" ] || return 1
  local pid
  pid=$(cat "$pid_file")
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  [ -r "/proc/$pid/cmdline" ] || return 1
  cmdline_has_arg "$pid" "$expected_arg"
}

cmdline_has_arg() {
  local pid=$1
  local expected_arg=$2
  local arg
  while IFS= read -r -d '' arg; do
    [ "$arg" = "$expected_arg" ] && return 0
  done <"/proc/$pid/cmdline"
  return 1
}

find_process() {
  local pid_file=$1
  local expected_arg=$2
  local proc_dir pid
  for proc_dir in /proc/[0-9]*; do
    pid=${proc_dir#/proc/}
    [ "$pid" != "$$" ] || continue
    if [ -r "$proc_dir/cmdline" ] && cmdline_has_arg "$pid" "$expected_arg" 2>/dev/null; then
      printf '%s\n' "$pid" >"$pid_file"
      return 0
    fi
  done
  return 1
}

if ! process_matches "$PID_FILE" '/workspace/cumora-stack/supervise.py' \
    && ! find_process "$PID_FILE" '/workspace/cumora-stack/supervise.py'; then
  # A SIGKILL can leave independently-sessioned children alive. Clean only
  # the pid/command pairs recorded by our supervisor before replacing it.
  /usr/bin/python3 "$STACK/watchdog.py" --cleanup-orphans >>"$LOG_DIR/watchdog.log" 2>&1
  # Close fd 9 in the long-lived child so the ensure-running lock is released
  # when this short script exits.
  nohup "$STACK/bin/start-stack.sh" </dev/null >>"$LOG_DIR/supervisor.log" 2>&1 9>&- &
  pid=$!
  printf '%s\n' "$pid" >"$PID_FILE"
  sleep 2
  kill -0 "$pid"
fi

if ! process_matches "$WATCHDOG_PID_FILE" '/workspace/cumora-stack/watchdog.py' \
    && ! find_process "$WATCHDOG_PID_FILE" '/workspace/cumora-stack/watchdog.py'; then
  nohup /usr/bin/python3 "$STACK/watchdog.py" </dev/null >>"$LOG_DIR/watchdog.log" 2>&1 9>&- &
  watchdog_pid=$!
  printf '%s\n' "$watchdog_pid" >"$WATCHDOG_PID_FILE"
  sleep 1
  kill -0 "$watchdog_pid"
fi

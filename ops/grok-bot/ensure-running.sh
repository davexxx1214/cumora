#!/bin/bash
set -euo pipefail

STACK=/workspace/cumora-stack
RUN_DIR="$STACK/run"
LOG_DIR="$STACK/logs"
PID_FILE="$RUN_DIR/supervisor.pid"

install -d -m 700 "$RUN_DIR" "$LOG_DIR"
exec 9>"$RUN_DIR/ensure-running.lock"
flock 9

if [ -s "$PID_FILE" ]; then
  pid=$(cat "$PID_FILE")
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null \
      && tr '\0' ' ' <"/proc/$pid/cmdline" | grep -q '/workspace/cumora-stack/supervise.py'; then
    exit 0
  fi
fi

# Do not let the long-lived supervisor inherit this watchdog lock.  An
# inherited descriptor would make every later health check block forever.
flock -u 9
exec 9>&-
nohup "$STACK/bin/start-stack.sh" </dev/null >>"$LOG_DIR/supervisor.log" 2>&1 &
pid=$!
printf '%s\n' "$pid" >"$PID_FILE"
sleep 2
kill -0 "$pid"

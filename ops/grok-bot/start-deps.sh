#!/bin/bash
set -euo pipefail

STACK=/workspace/cumora-stack
LOG_DIR="$STACK/logs"
RUN_DIR="$STACK/run"
SECRETS_DIR="$STACK/secrets"
PGDATA=/workspace/data/postgres
REDIS_DIR=/workspace/data/redis
REPO_ENV=/workspace/cumora/.env

install -d -m 700 "$LOG_DIR" "$RUN_DIR" "$SECRETS_DIR" /workspace/data "$PGDATA" "$REDIS_DIR"

# Project objects must survive a Grok Bot computer rebuild. The /projects/<id>
# path visible inside a task is only a controlled FUSE mount; the backing store
# must resolve beneath /workspace. Fail closed instead of silently writing to a
# container-local path when the feature is enabled.
if [ -f "$REPO_ENV" ] && grep -Eq '^CUMORA_PROJECT_FILES_ENABLED=(1|true)$' "$REPO_ENV"; then
  project_root=$(sed -n 's/^CUMORA_PROJECT_FILES_ROOT=//p' "$REPO_ENV" | tail -n 1 | tr -d '\r')
  if [ -z "$project_root" ]; then
    echo "CUMORA_PROJECT_FILES_ROOT is required when project files are enabled" >&2
    exit 1
  fi
  project_root=$(realpath -m -- "$project_root")
  case "$project_root" in
    /workspace/*) ;;
    *)
      echo "project file root must resolve beneath /workspace" >&2
      exit 1
      ;;
  esac
  install -d -m 700 "$project_root"
fi

# This root holds persistent, token-free private Git objects. Visible worktree
# files live in the versioned project space and are mounted through its FUSE
# service; private .git data is never mounted. Keep both under /workspace.
if [ -f "$REPO_ENV" ] && grep -Eq '^CUMORA_PROJECT_GIT_ENABLED=(1|true)$' "$REPO_ENV"; then
  git_root=$(sed -n 's/^CUMORA_PROJECT_GIT_ROOT=//p' "$REPO_ENV" | tail -n 1 | tr -d '\r')
  if [ -z "$git_root" ]; then
    echo "CUMORA_PROJECT_GIT_ROOT is required when project Git is enabled" >&2
    exit 1
  fi
  git_root=$(realpath -m -- "$git_root")
  case "$git_root" in
    /workspace/*) ;;
    *)
      echo "project Git root must resolve beneath /workspace" >&2
      exit 1
      ;;
  esac
  install -d -m 700 "$git_root"
fi

"$STACK/bin/ensure-packages.sh"

exec 9>"$RUN_DIR/start-deps.lock"
flock 9

if ! /usr/bin/pg_isready -q -h 127.0.0.1 -p 5432; then
  /usr/lib/postgresql/17/bin/pg_ctl -D "$PGDATA" -l "$LOG_DIR/postgres.log" start
  for _ in $(seq 1 30); do
    /usr/bin/pg_isready -q -h 127.0.0.1 -p 5432 && break
    sleep 1
  done
  /usr/bin/pg_isready -q -h 127.0.0.1 -p 5432
fi

if ! redis-cli -h 127.0.0.1 -p 6379 ping 2>/dev/null | grep -qx PONG; then
  redis-server \
    --daemonize yes \
    --bind 127.0.0.1 \
    --port 6379 \
    --dir "$REDIS_DIR" \
    --dbfilename dump.rdb \
    --save 60 1 \
    --appendonly yes \
    --appendfsync everysec
fi

SSH_HOST_KEY="$SECRETS_DIR/ssh_host_ed25519_key"
AUTHORIZED_KEYS="$SECRETS_DIR/authorized_keys"
SSHD_DROPIN=/etc/ssh/sshd_config.d/99-cumora-tunnel.conf

if [ ! -f "$SSH_HOST_KEY" ]; then
  ssh-keygen -q -t ed25519 -N '' -f "$SSH_HOST_KEY"
fi
chmod 600 "$SSH_HOST_KEY" "$AUTHORIZED_KEYS"
chmod 644 "$SSH_HOST_KEY.pub"

sudo tee "$SSHD_DROPIN" >/dev/null <<EOF
Port 22
ListenAddress 127.0.0.1
HostKey $SSH_HOST_KEY
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitRootLogin no
AllowUsers box
EOF

install -d -m 700 /home/box/.ssh
install -m 600 "$AUTHORIZED_KEYS" /home/box/.ssh/authorized_keys

# The device token is minted by the current Cumora database.  Keep the paired
# client config in the durable secret directory and restore it after a computer
# rebuild before the project daemon starts.
if [ -f "$SECRETS_DIR/computer.json" ]; then
  install -d -m 700 /home/box/.cumora
  install -m 600 "$SECRETS_DIR/computer.json" /home/box/.cumora/computer.json
fi

if ! ss -ltn | grep -qE '127\.0\.0\.1:22'; then
  sudo /usr/sbin/sshd
fi

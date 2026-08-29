#!/bin/bash
set -euo pipefail

need=0
[ -x /usr/lib/postgresql/17/bin/pg_ctl ] || need=1
command -v redis-server >/dev/null 2>&1 || need=1
[ -x /usr/sbin/sshd ] || need=1
command -v fusermount3 >/dev/null 2>&1 || need=1

[ "$need" -eq 1 ] || exit 0

export DEBIAN_FRONTEND=noninteractive
sudo apt-get update
sudo apt-get install -y postgresql-17 redis-server openssh-server fuse3

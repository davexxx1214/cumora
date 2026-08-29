#!/bin/sh
# Build/install the trusted runner only. Does not enable files, alter the DB,
# restart services, or modify any existing Agent home.
set -eu
project_repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
project_install_dir=${1:-"$HOME/.local/lib/cumora-project"}
case "$project_install_dir" in /*) ;; *) printf '%s\n' 'An absolute install directory is required.' >&2; exit 1;; esac
if [ "$project_install_dir" = / ]; then exit 1; fi
umask 077
mkdir -p "$project_install_dir"
cd "$project_repo_dir/agent-fuse"
go build -trimpath -o "$project_install_dir/project-task.new" ./cmd/project-task
cc -O2 -Wall -Wextra -o "$project_install_dir/task-enter.new" sandbox/enter.c
chmod 700 "$project_install_dir/project-task.new" "$project_install_dir/task-enter.new"
mv "$project_install_dir/project-task.new" "$project_install_dir/project-task"
mv "$project_install_dir/task-enter.new" "$project_install_dir/task-enter"
printf 'Installed project-task and task-enter in %s. Services unchanged.\n' "$project_install_dir"

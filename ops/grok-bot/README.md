# Grok Bot validation-host recovery

These scripts keep the Cumora validation stack alive inside the current Grok
Bot computer. They are not a production init system.

The host uses `tini` as PID 1 and does not run systemd or a cron daemon. The
supervisor restarts child processes. A separate `watchdog.py` checks the
supervisor, the local API, and the Cloudflare connector every 15 seconds and
recovers the stack after four consecutive health failures. It also cleans up
recorded orphan process groups before replacing a killed supervisor.

Something outside the container still has to call `ensure-running.sh` after a
full computer rebuild. Use a Grok Bot routine for that platform-level wake-up,
or run the command manually:

```sh
/workspace/cumora-stack/bin/ensure-running.sh
```

The routine should call only that idempotent command and report a failure when
the public health endpoint is not HTTP 200. Grok routines can be paused after a
long period of inactivity, so this remains a validation setup. Move the service
to a normal VPS with systemd before treating it as production.

`ensure-running.sh` ensures exactly one main supervisor and one independent
watchdog. If a killed main supervisor leaves the project daemon alive, the
replacement observes that singleton instead of spawning a new process every
five seconds.

Persistent state is kept outside the container image:

- PostgreSQL: `/workspace/data/postgres`
- Redis: `/workspace/data/redis`
- project objects: `/workspace/cumora-data/project-files`
- private Git mirrors: `/workspace/cumora-data/project-git`
- host bootstrap: `/workspace/cumora-stack`

When project files are enabled, `start-deps.sh` resolves
`CUMORA_PROJECT_FILES_ROOT` and refuses to start if it is outside `/workspace`.
The `/projects/<projectId>` path seen by an Agent task is an ephemeral,
controlled FUSE mount; it is not the backing storage location.

When project Git is enabled, the same check applies to
`CUMORA_PROJECT_GIT_ROOT`. Each Cumora project owns one encrypted token shared by its repositories in
PostgreSQL. Private token-free Git objects are not mounted into Agent tasks;
normal worktree files are exposed through the shared project FUSE path and
count toward the same project quota.

`/workspace/cumora-stack/secrets` is mode 0700. It contains the Cloudflare
connector token, persistent SSH host key, SSH authorized keys, and (after a new
Cumora computer is paired) its `computer.json` plus the project-daemon
environment. Never commit or print that directory.

The project daemon is deliberately disabled after a database replacement.
Pair a new computer through Cumora, copy its generated `computer.json` to the
secret directory, put the reviewed runtime settings in
`secrets/project-daemon.env`, create `secrets/project-daemon.enabled`, and
restart the stack. An old device token must not be copied into a new database.

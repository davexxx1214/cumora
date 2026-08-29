# Cumora Grok Bot 主机连接与持久化说明

更新日期：2026-08-29

本文记录当前 Cumora 验证环境在 Grok Bot Linux 主机上的实际连接、恢复和持久化约束。不得把本文中的验证环境描述为生产级部署，也不得向仓库、日志或聊天复制私钥、Cloudflare Tunnel token、Computer token、数据库密码或完整进程环境。

## 1. 当前入口

| 用途 | 地址或命令 | 源站 |
| --- | --- | --- |
| Cumora Web | `https://cumora.myawesomeai.top` | `http://127.0.0.1:5180` |
| API 健康检查 | `https://cumora.myawesomeai.top/api/health` | `http://127.0.0.1:5181/api/health` |
| SSH | `ssh-cumora.myawesomeai.top` | `ssh://127.0.0.1:22` |
| Cloudflare 连接器状态 | 仅主机本地 `http://127.0.0.1:20242/ready` | cloudflared metrics |

Cloudflare Tunnel 名称为 `cumora`，Tunnel ID 为 `c620e3d7-d250-4337-bf4a-f7c95c8f0a2e`。两个公网域名都通过同一 Tunnel：

- `cumora.myawesomeai.top` 的 CNAME 指向 `c620e3d7-d250-4337-bf4a-f7c95c8f0a2e.cfargotunnel.com`，路由到 Web 源站。
- `ssh-cumora.myawesomeai.top` 指向同一 Tunnel，路由到本机 sshd。
- DNS 由 Cloudflare 代理。Tunnel token 只保存在主机的受控 secret 文件中，不写入 Git 或命令行。
- SSH 目前仍使用源站公钥认证，没有配置 Cloudflare Access 身份登录策略。

旧的 `bore.pub:3444` 是不稳定的临时通道，已弃用，不能再作为部署或排障的默认入口。

## 2. SSH 连接

远程用户为 `box`。当前开发机已经配置 SSH 别名：

```sh
ssh cumora-remote
```

等价的 OpenSSH 配置结构如下，`IdentityFile` 和 cloudflared 路径应使用各自开发机上的实际路径：

```sshconfig
Host cumora-remote
    HostName ssh-cumora.myawesomeai.top
    User box
    IdentityFile ~/.ssh/cumora_grok.pem
    ProxyCommand cloudflared access ssh --hostname %h
    ServerAliveInterval 30
    ServerAliveCountMax 3
```

当前 SSH 主机 ED25519 指纹：

```text
SHA256:ODp/V6n/guDjG617xFJbfxFvoZjBPxdcxEnF/UEDPOU
```

主机侧 sshd 只监听 `127.0.0.1:22`，禁止密码登录和 root 登录，只允许 `box` 使用 authorized keys。SSH 主机密钥已放到 `/workspace`，避免容器重建后再次改变指纹。

## 3. 运行栈和恢复命令

| 内容 | 路径 |
| --- | --- |
| Cumora 源码 | `/workspace/cumora` |
| 当前部署分支 | `dev` |
| 持久化恢复栈 | `/workspace/cumora-stack` |
| 恢复脚本 | `/workspace/cumora-stack/bin/ensure-running.sh` |
| 运行日志 | `/workspace/cumora-stack/logs` |
| Secret 目录 | `/workspace/cumora-stack/secrets` |

唯一的人工恢复命令是：

```sh
/workspace/cumora-stack/bin/ensure-running.sh
```

该命令是幂等的。重复执行不会创建第二个主监督器。恢复栈负责：

1. 检查并安装 PostgreSQL、Redis、OpenSSH Server 和 FUSE 依赖。
2. 拉起 `/workspace` 中的 PostgreSQL 和 Redis 数据目录。
3. 恢复持久化 SSH 主机密钥、authorized keys 和 Computer 配置。
4. 监督 Cumora Web/API、cloudflared 和项目 Agent daemon；子进程退出后自动重启。

当前容器 PID 1 是 `tini`，没有 systemd，也没有运行中的 cron daemon。因此用户态监督器只能处理子进程退出，不能自行跨越整台 Grok Bot computer 的重建。重建后仍需人工运行上述命令，或配置 Grok Routine 定时调用。

建议给 Grok Bot 的 Routine 指令：

```text
每 5 分钟运行一次 /workspace/cumora-stack/bin/ensure-running.sh，
然后检查 http://127.0.0.1:5181/api/health 和
https://cumora.myawesomeai.top/api/health。
仅失败时通知我；命令必须幂等，不要重置数据库或重新生成密钥。
```

Grok Routine 长期无活动时可能暂停，因此它不是生产级 init system。正式长期运行应迁移到带 systemd、磁盘快照和监控的 VPS。

## 4. `/workspace` 持久化规则

Grok Bot 的容器系统层和进程可能在 Update、Recover 或重建时消失。需要跨重建保存的源码、数据库、项目正文、主机身份和启动配置都必须位于 `/workspace`。

| 数据 | 必须使用的持久化路径 | 说明 |
| --- | --- | --- |
| 源码与 `.env` | `/workspace/cumora` | `.env` 含秘密，不提交 Git |
| PostgreSQL | `/workspace/data/postgres` | 保存用户、群组、消息和项目文件元数据 |
| Redis | `/workspace/data/redis` | 已开启 AOF，`appendfsync everysec` |
| 项目文件正文 | `/workspace/cumora-data/project-files` | 私有对象目录，权限 0700，不映射为静态公网目录 |
| 恢复脚本和日志 | `/workspace/cumora-stack` | 负责服务和依赖恢复 |
| Cloudflare token | `/workspace/cumora-stack/secrets/cloudflared-token` | 只允许受控用户读取 |
| SSH 主机密钥 | `/workspace/cumora-stack/secrets/ssh_host_ed25519_key` | 权限 0600，保持主机指纹稳定 |
| SSH authorized keys | `/workspace/cumora-stack/secrets/authorized_keys` | 重建后恢复到 `box` 的 home |
| Computer 配对配置 | `/workspace/cumora-stack/secrets/computer.json` | 只适用于当前 Cumora 数据库 |

`/home/box`、`/var/lib`、`/tmp` 和容器系统安装目录不能作为唯一持久化数据源。可执行工具或依赖可以在重建后重新安装，但不可恢复的数据必须放入 `/workspace`。

`/workspace` 的持久化仍不等于备份：平台 Reset、快照回退、误删、磁盘故障或账号问题仍可能造成数据丢失。当前验证阶段没有异地备份，不能承诺灾难恢复。

参考 Grok Bot 官方说明：

- [Computer and Apps](https://docs.x.ai/grok-bot/computer-and-apps)
- [Troubleshooting](https://docs.x.ai/grok-bot/troubleshooting)
- [Skills, Routines and Automations](https://docs.x.ai/grok-bot/skills-routines-and-automations)

## 5. 项目共享文件

项目文件要完整恢复，必须同时保留两部分：

1. PostgreSQL 中的项目、目录、版本、回收站和对象引用元数据：`/workspace/data/postgres`。
2. 文件正文对象：`/workspace/cumora-data/project-files`。

当前配置：

```text
CUMORA_PROJECT_FILES_ENABLED=1
CUMORA_PROJECT_FILES_ROOT=/workspace/cumora-data/project-files
```

启动脚本会解析 `CUMORA_PROJECT_FILES_ROOT` 的真实路径。项目文件功能开启时，如果该路径不在 `/workspace` 下，启动会失败，不会静默写入容器临时层。

Agent 任务看到的 `/projects/<projectId>` 是任务期间创建的受控 FUSE 挂载点，不是文件正文的持久化位置。该挂载点在任务结束或主机重建后消失是正常行为；新任务会根据当前群组挂载的项目重新建立。不得把底层对象目录直接暴露给 Agent，也不得把 `/projects` 改成指向所有项目的开放目录。

每个项目的 5GB 是逻辑最大容量，不是预分配 5GB 磁盘。当前阶段不做项目文件备份；磁盘对象缺失时只显示当前仍实际存在且有有效元数据的文件。

## 6. Secret 与权限

- `/workspace/cumora-stack/secrets` 必须保持 0700；私钥、token 和 Computer 配置保持 0600。
- `/workspace/data`、PostgreSQL、Redis 和项目文件正文目录保持 0700。
- 不要运行会打印完整环境的 `ps e`、`env` 或调试命令；排障只读取必要日志尾部。
- 不要把 secret 作为 shell 参数传递，避免出现在进程列表和命令历史中。
- 数据库重置后，旧 Computer token 不能复用；必须在新数据库重新配对并更新持久化 `computer.json`。

## 7. 重建后的检查顺序

```sh
# 1. 恢复整个栈
/workspace/cumora-stack/bin/ensure-running.sh

# 2. 本机 API
curl -fsS http://127.0.0.1:5181/api/health

# 3. Cloudflare 连接器
curl -fsS http://127.0.0.1:20242/ready

# 4. 公网 API
curl -fsS https://cumora.myawesomeai.top/api/health
```

然后从开发机执行：

```sh
ssh -o BatchMode=yes cumora-remote 'echo ssh-ok'
```

检查时还应确认：

- `/workspace/data/postgres` 是当前 PostgreSQL 的实际 `PGDATA`。
- Redis 的 `appendonly` 为 `yes`。
- `CUMORA_PROJECT_FILES_ROOT` 解析为 `/workspace/cumora-data/project-files`。
- Computer 状态为 online，项目 daemon 只有一个监督器实例。
- 本地 `dev`、`origin/dev` 和远程 `/workspace/cumora` 指向同一提交且工作区干净。

## 8. 2026-08-29 重建事故记录

Grok Bot 主机约在 UTC 07:14 发生重建。`/workspace` 中的源码、`.env`、Cloudflare token 和项目对象目录仍在，但原先放在容器系统目录的 PostgreSQL、Redis、系统包和运行进程消失。重新安装 PostgreSQL 后创建的是全新业务库，旧消息、会话、自定义成员/群组、Computer 和项目文件元数据没有迁移。

事故后完成的调整：

- PostgreSQL 和 Redis 数据目录迁移到 `/workspace/data`。
- 项目正文确认使用 `/workspace/cumora-data/project-files`，并增加路径硬校验。
- Cloudflare token、SSH 主机身份、authorized keys 和新 Computer 配置放入持久化 secret 目录。
- 新增幂等恢复脚本和用户态监督器。
- 重新配对当前 Computer；六个种子 Agent 及 `codex` Agent 使用 Codex 引擎在线。
- 验证 Web、API、SSH、Cloudflare Tunnel、服务子进程恢复和项目文件隔离测试。

旧项目对象目录中残留的文件没有对应数据库元数据，属于孤立对象，不会自动恢复为当前项目文件。后续不得仅凭磁盘文件存在就宣称业务数据已经恢复。

## 9. 最后验证状态

2026-08-29 最后一次检查：

- 公网 API：HTTP 200
- 公网登录页：HTTP 200
- 本机 API：HTTP 200
- cloudflared `/ready`：HTTP 200
- 普通 SSH：成功
- PostgreSQL、Redis、Computer 和项目 daemon：运行中
- 项目文件根：`/workspace/cumora-data/project-files`，权限 0700
- 恢复脚本对 `/tmp` 项目根的负向测试：拒绝启动

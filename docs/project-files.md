# 项目共享文件：验证版说明

更新：2026-08-29。**功能已在当前远程主机启用，仍是验证版，不是生产就绪声明。** 主机在同日重建后，旧 PostgreSQL 业务数据没有保留下来；原项目对象仍在磁盘，但元数据已经丢失，因此不会出现在当前文件列表，也不能视为已恢复。现已把 PostgreSQL、Redis、启动栈、SSH 主机密钥和新配对的 Computer 配置移到 `/workspace`，并重新通过隔离 Linux 全链路测试。完整浏览器上传→在线 Agent 修改→浏览器下载点击闭环仍待重新验收。当前检查结果及未完成项见 [实施计划](../plan.md#16-执行记录共享文件实现2026-08-29)。

## 使用规则

群聊只关联项目，文件属于项目。一个项目同时只能挂一个群；切换只改关联，不移动文件。管理员必须是当前群成员，普通群成员可以创建、上传、修改、移动、删除和恢复文件；永久清理和项目关联管理仅限管理员。

每项目最大 5,000,000,000 bytes；每文件最大 25MiB。当前版本、旧版本、回收站和待提交写入都占容量。验证阶段不备份：丢失文件不显示为当前文件，不自动以旧版本替代；消息仍保留发送时的名称，但下载必须重新鉴权。

启用后在桌面和手机群头部进入「项目文件」。管理员可选择项目、新建项目、切换/解除挂载；未挂载项目可先查看再决定是否挂载。文件支持目录浏览、上传下载、重命名、移动、发送到群聊、回收站及恢复。已存在的聊天附件可保存到当前项目；挂载群的新附件直接进入私有项目根目录，不先经过公开附件存储。同名附件另存；文件面板中明确替换时检查版本。

旧消息链接指向发送时版本，改名或移动不改变身份。管理员清理历史版本后链接失效。外部 URL 附件不会被服务端任意抓取；应先由用户下载并上传。

## Agent 目录及上下文

每次任务的真实目录为 `/projects/<projectId>`。支持 `ls/cd/cat/cp/mv/rm`、Python、二进制文件、空目录、中文目录和临时文件后 rename 保存。实际验证过 python-docx、openpyxl、pypdf、reportlab；不保证所有 POSIX 操作、数据库工作目录或构建工具兼容。符号链接、硬链接、设备文件、FIFO、socket、xattr、任意所有者/权限变更不受支持。

项目任务从私有 home 启动，不把工作目录设成共享根目录，不复用上一个项目的模型会话，不复制旧 home/全局记忆/插件或扫描共享目录。提示仅告知当前项目路径，要求用户明确点名文件或授权任务范围后再读取。不要在项目目录中运行自动 AGENTS.md/CLAUDE.md 加载流程。

任务用受限租约访问文件服务；只能通过限定 CLI 查看当前群、回复及 `cumora project-file <项目内路径> [说明]` 分享文件。通用 Agent JWT 和本地宿主机控制密钥不交给项目任务。模型服务登录信息单独放在任务私有 home；不继承模型客户端的全局 MCP、hooks、技能和历史会话。

宿主机平台/运维账号仍是受信任管理员。本方案隔离 Cumora 启动的任务，不声称阻止掌握主机权限的 Grok Bot 或运维人员读取磁盘。

## 保存、冲突和停止

文件元数据在 PostgreSQL 项目行锁内提交；不可变二进制对象使用私有目录、随机 ID、NOFOLLOW 和 fsync。元数据为有上限的 JSONB，正常只读不重写元数据；写入预留不重复扫描所有内容对象。目录列表及发布新版本时核对当前对象，安全回收没有任何版本引用的对象。

覆盖、fsync、flush、rename 会检查基准版本。陈旧写入保留冲突副本并返回 `ESTALE`；陈旧临时文件替换失败时保留临时文件。收到错误不能宣称原文件已经保存。已经打开的句柄与后续下载也持续检查权限。

一个 Agent 任务对首次观察到的版本保持保守锁定；发生冲突后，需开始新任务才能明确采用更新后的基准版本，不能在原任务中用重新打开文件静默解除冲突保护。

切换先冻结写入、撤销租约，旧任务心跳发现撤权后终止进程树；服务端收到可信监督器的退出确认后才允许完成关联切换。`TASKS_STOPPING` 表示尚未切换，可稍后重试；选择「恢复当前项目」也必须等待旧任务退出，不会恢复旧租约。

未提交到文件服务的程序内存不保证恢复；失效或被移除的身份不能继续提交。任务私有 home 保留已写入的工作草稿，权限仅给主机管理方，不自动发布或注入下次任务；不能将尚在程序/FUSE 内存中的内容称为已保存。大量私有 home 的保留/清理需要运维关注，这不属于项目 5GB 的计费口径。

API 重启生成新的服务实例标识，旧租约立即失效。租约过期不等于进程已退出；切换不会仅凭 TTL 放行。Daemon 在 `~/.cumora/project-task-leases` 保存 PID、启动时间、boot ID 和待确认退出记录。恢复时只确认已经退出的实例，不按重用 PID 杀陌生进程，也不自动复活凭证。

## 安装和启用顺序

当前环境支持非特权 user/mount/PID namespace、`/dev/fuse`、Landlock ABI 6。没有这些条件就拒绝启用，不回退到裸目录或特权容器。

1. 完成独立环境验收，检查历史关联冲突。此次只读检查的线上数据没有异常关联；迁移不会静默解除存量关系。
2. 在 Linux checkout 运行 `sh scripts/build-project-task.sh`。这一步只编译安装二进制，不启用功能。
3. 在私有运行环境中给 API 和本机 daemon 配置相同的随机 `CUMORA_PROJECT_HOST_SECRET`（至少 32 字符），不要放入前端环境或命令参数。不要打印密钥。
4. 准备与源码、`/uploads`、临时目录分开的数据根，计划为 `/workspace/cumora-data/project-files`。权限 0700，不做公网静态映射。
5. 配置下列变量。`CUMORA_PROJECT_RUNTIME_DIRS` 只包含已审核的程序安装目录，不能是 `/`、`/home`、操作员 home、原始数据根、`.cumora`、`.ssh` 或整个 `.grok`。当前 Codex 需要其 `codex-code-mode-host` 同目录配套程序；Grok 使用独立 downloads 安装目录。
6. 先停止派发任务，等待或明确结束旧 daemon 及其引擎子进程；切换到本 checkout 的 daemon 代码。不能只更新 API 然后让旧版不受控 daemon 继续运行。
7. 启用 API 文件开关，再启动受控 daemon；先用专用测试群/项目走通浏览器上传→Agent 修改→浏览器下载→撤权/切换。当前迁移、上线和进程退出恢复验证已经完成；线上写入点击闭环仍需在测试群完成。

| 环境变量 | 用途 |
| --- | --- |
| `CUMORA_PROJECT_FILES_ENABLED=1` | API 功能开关，默认关闭 |
| `CUMORA_PROJECT_FILES_ROOT` | API 私有文件根的绝对路径 |
| `CUMORA_PROJECT_GIT_ENABLED=1` | 二阶段项目 Git 功能开关，默认关闭 |
| `CUMORA_PROJECT_GIT_ROOT` | 私有 Git mirror 根；Grok Bot 使用 `/workspace/cumora-data/project-git` |
| `CUMORA_GIT_CREDENTIAL_ENCRYPTION_SECRET` | 可选的 Git token 专用加密密钥；未设时从 Agent runtime secret 做域隔离派生 |
| `CUMORA_PROJECT_HOST_SECRET` | API/可信 daemon 共享的宿主机控制密钥 |
| `CUMORA_PROJECT_TASKS_ENABLED=1` | daemon 允许受控 Linux 任务 |
| `CUMORA_PROJECT_LOCAL_API=http://127.0.0.1:5181` | 本机 API，不能填公网隧道 URL |
| `CUMORA_PROJECT_TASK_BIN` / `CUMORA_PROJECT_TASK_ENTER` | 已安装的两个绝对执行路径 |
| `CUMORA_PROJECT_RUNTIME_DIRS` | 以冒号分隔的已审核只读程序路径 |
| `CUMORA_PROJECT_AUTH_HOME` | 可选：模型登录信息来源，默认操作员 home；只复制指定认证文件 |
| `CUMORA_PROJECT_CODEX_CONFIG` | 可选：明确审核过的模型提供方配置；不自动复制全局 config |
| `CUMORA_PROJECT_PYTHON_LIBS` | 可选：独立文档处理库路径，需同时纳入只读 runtime 目录 |

测试中使用 python-docx 1.2.0、openpyxl 3.1.5、pypdf 6.0.0、reportlab 4.4.3。部署时应装进专用依赖目录，不修改系统 Python；不要把业务项目当作依赖安装目录。

## 当前远程部署

- 源码：`/workspace/cumora`，跟随 `origin/dev`。
- 私有数据根：`/workspace/cumora-data/project-files`，权限 0700；不映射到公网静态目录。
- 项目任务程序：`/home/box/.local/lib/cumora-project/project-task` 与 `task-enter`。
- 文档依赖：`/home/box/.local/lib/cumora-project-python`。
- 持久化数据库：PostgreSQL `/workspace/data/postgres`；Redis `/workspace/data/redis`，启用 AOF `everysec`。
- 启动栈：`/workspace/cumora-stack`。私密配置在 `secrets/`，目录 0700，密钥文件 0600；包含 Cloudflare token、SSH 主机密钥、authorized keys 和当前数据库配对的 Computer 配置，禁止打印或提交。
- 启动/恢复：`/workspace/cumora-stack/bin/ensure-running.sh`。命令幂等，负责依赖、PostgreSQL、Redis、sshd、Cumora、cloudflared 和项目 daemon。
- 启动脚本会解析 `CUMORA_PROJECT_FILES_ROOT`；功能开启时，真实路径不在 `/workspace` 下会拒绝启动，避免重建后误写容器临时层。Agent 看到的 `/projects/<projectId>` 只是任务期间的受控 FUSE 挂载点，不是正文存储目录。
- 日志：`/workspace/cumora-stack/logs`；排障时不得把环境、访问令牌或文件正文写入日志。
- 健康检查：本机 API `http://127.0.0.1:5181/api/health`，公网 `https://cumora.myawesomeai.top/api/health`。

当前主机 PID 1 是 `tini`，没有 systemd，也没有 cron daemon。守护器会在应用、隧道或 daemon 子进程崩溃后自动拉起，但整台主机或容器重建后仍需要 Grok Routine 或人工执行上述命令。Routine 长期无活动时也可能暂停；这是已知运维边界，不应描述为系统级开机自启。

2026-08-29 主机重建产生了全新业务库，旧消息、会话、自定义成员、群组、Computer 及项目文件元数据没有迁移。磁盘上残留的三个对象文件没有对应元数据，按既定规则不会自动恢复为当前文件。新库已重新配对一台 Computer，六个种子 Agent 及重新创建的 `codex` Agent 使用 Codex 引擎在线。功能关闭或代码回滚前，先停止新项目任务、撤销租约并保留新增表和项目数据。

重建后已用独立 PostgreSQL、Redis 和文件目录运行 Linux 验证：预检 5/5、项目文件领域测试 10/10、集成测试 20 项通过，真实 Codex/Grok 外部引擎两项按默认测试模式跳过；业务库和线上目录没有被测试修改。应用子进程退出后由守护器成功恢复，`ensure-running.sh` 重复执行保持同一监督器进程。

Grok 的私有 home、自动更新与跨会话记忆开关依据 [官方设置参考](https://docs.x.ai/build/settings/reference)。受控任务不继承原账号的全局配置。

## 验证命令

从本地调用隔离 Linux 检查：

```sh
python scripts/test-project-files-linux.py --host HOST --port PORT --user USER --key KEY
```

脚本验证 SSH known-host，在内存读取原密钥；独立创建 PostgreSQL/Redis/文件目录，完成后清理。不会读取业务 `.env`、迁移业务库或重启现有服务。`--unit` 额外跑完整单元测试；`--test <server/src/内文件>` 选择测试；`--match`/`--repeat` 用于重复检查。

`--engine-smoke` 与 `--grok-smoke` 是显式选择的真实模型验证，会使用该主机已有模型登录信息，可能消耗模型额度；仅操作隔离项目。普通测试不调用真实模型。

## 当前边界

不是完整 POSIX/协同编辑系统；不自动合并 Office 文件、不自动索引、不把 Git checkout 混入共享文档、不提供跨群共享或公开下载。FUSE 文件内容使用有上限的直接 I/O 缓冲；最大目录与版本规模的性能尚未完成测量。先前重复运行问题已经定位并完成 20 轮真实挂载复测；daemon 消失、25MiB HTTP 边界以及真实 Codex/Grok 引擎集成项已在 Linux 隔离环境通过。主机重建后旧验证项目及其文件元数据已丢失，当前列表不再展示原 `cumora-online-check.txt`。剩余验收项是新建测试群/项目后重新完成浏览器上传、Agent 修改与浏览器下载点击闭环。

## 二阶段 Git（2026-08-30）

项目 Git 与共享文档是两个独立空间。管理员在“项目文件”面板配置 HTTPS 仓库、默认分支和工作区 Git 凭据；多个凭据中同一时间只能启用一个，且凭据只用于匹配的 Git Host。服务端同步的私有 mirror 和 token 都不会挂给 Agent。

新项目任务会获得 `/home/agent/repository` 独立 checkout，并从已同步默认分支开始。用户可要求 Agent 在该任务内切换已有分支。任务 checkout 没有 token，首批不提供 fetch/push；管理员重新同步后，后续任务使用新提交。共享文档仍位于 `/projects/<projectId>`，不自动进入模型上下文，Git 仓库也不因挂载或任务启动而自动扫描。

# Agent 模型与运行设置

管理员在团队列表中编辑单个 Agent，分别设置主模型、推理强度和速度。
普通成员可以查看配置与最近的引擎回报，不能修改。

## 支持范围

| 引擎 | 主模型 | 推理强度 | 速度 | 运行值来源 |
| --- | --- | --- | --- | --- |
| Codex | 模型名称 | none / minimal / low / medium / high / xhigh / max / ultra | 标准 / Fast | exec 启动头或 app-server 的 thread/start、thread/resume 响应 |
| Claude Code / Grok / Cursor | 模型名称 | 暂不支持 | 暂不支持 | 引擎结构化事件中的实际模型；缺失时显示未回报 |
| Managed | 原有云端模型设置 | 暂不支持 | 暂不支持 | 本次未新增云端运行回报 |

实际可用的模型和推理档位由机器上的 CLI、模型及账号决定。界面保留完整档位，
应用不自动降级；不支持的组合可能由 CLI 拒绝，以引擎回报的解析值为准。Fast 是服务档位，不是轻量模型，也不降低推理强度。
Codex 参数分别是 `--model`、`-c model_reasoning_effort=...` 和 `-c service_tier=default|fast`。
Codex 可以将 Fast 回报为 `priority`，界面统一显示为 Fast。

## 默认值与生效值

- 留空表示继承，不把某个模型或档位硬编码成默认。
- 主模型保留原有优先级：运行端 `CUMORA_ENGINE_MODEL` 覆盖、Agent 配置、服务器引擎默认、CLI 自身默认；`local` 覆盖表示交给 CLI。
- 推理强度和速度只有显式选择时才传入；留空不覆盖 CLI。
- 轻量模型与速度独立。分类任务按 `CUMORA_TRIAGE_MODEL`、Agent 轻量模型、适配器默认的顺序选模型；Codex 适配器默认是 `gpt-5.4-mini`。
- 列表分别显示“已配置”“最近确认”，并附上运行端实际传入的参数及回报时间。
  最近确认是历史观察，不是当前在线或请求成功的保证。
- **Codex 0.150.1 的 exec 不回报服务档位。** 项目隔离任务目前使用 exec，因此模型和推理强度可确认，速度显示“引擎未回报”；下方仍显示实际传入的标准／Fast。
  不把传入参数伪装成引擎确认值。app-server 可以回报三项。
- 新建、修改或迁移机器后，旧回报失效，等待新运行确认。旧版 daemon 没有回报功能，需要升级。
- 沿用现有 daemon 的配置同步机制：轮询发现变更后会停止旧 runner 并建立新 runner。
  建议在 Agent 空闲时修改，避免中断正在执行的任务；同值保存不会触发版本更新。

## 权限与部署

设置仍走管理员 Agent API。回报单独使用设备令牌，并校验工作区、当前机器、Agent 是否已离开以及配置版本。
服务端只保存允许的模型／档位字段和服务器时间，不保存环境变量、凭证或完整配置。
回报失败不影响任务执行，不接受旧机器或旧版本 runner 对新配置的确认。

需要同时更新前端、API（新增兼容数据库列）以及 `agent-cli` 构建后的 daemon。
只刷新前端或重启旧版 npm daemon 不会启用新参数。部署必须包含根目录的 `shared/` 模块。
本实现不修改 Agent 任务的沙箱、项目挂载、文件权限或已有认证方式。

协议参考：[Codex 配置](https://developers.openai.com/codex/config-reference/)、[App Server](https://developers.openai.com/codex/app-server/)。

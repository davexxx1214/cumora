# 项目共享文件：P0 验证记录

日期：2026-08-28。状态：部分通过；Grok Bot 官方文档已确认 `/workspace` 的持久化用途，实际任务隔离仍待验证。用户最新决定接受文件丢失，一阶段不做备份及灾难恢复演练。

## 范围

本次新增预检工具和 Linux 内核挂载测试，未连接业务数据库，也没有给线上群组启用共享文件。测试不依赖公开附件目录，不修改现有 Agent home 或引擎进程。

预检命令：

```sh
npm run project-files:preflight -- --data-root /path/to/existing/data-directory
```

命令退出 0 仅表示环境满足原型测试的基础条件，必须继续查看 `productionReady` 和逐项结果。该工具不会自行认证持久化、挂载正确性、任务隔离或灾难恢复。

## 实际环境

| 项目 | 结果 |
| --- | --- |
| SSH 用户 / API / 当前 Agent | UID 1000，不能把当前共享 OS 用户当成文件隔离边界 |
| 运行环境 | Linux 6.12.94+，容器内 PID 1 为 tini |
| FUSE 设备 | `/dev/fuse` 为字符设备，可以打开 |
| user/mount/PID namespace | 普通用户创建成功 |
| Go | 1.24.4 |
| fusermount | 未安装；原型在独立 user namespace 中使用 DirectMountStrict，无 sudo 或权限回退 |
| `/workspace`、`/home/box` | 位于 overlay 根文件系统，未发现独立持久化数据卷 |
| 文档处理依赖 | 预检时未找到 pypdf、python-docx、openpyxl、reportlab，尚未安装或验证 |

原始、经过字段限制的报告保存在 `project-files-p0-preflight.json`。报告不包含环境变量、进程参数、凭证或宿主机 overlay backing 路径。该历史报告把 overlay 判为 `fail`，此判定已修正：overlay 或未知挂载为 `unverified`，内存或只读挂载仍为 `fail`。保留原报告，不将新判断伪装成当时的测量结果。

## Grok Bot 持久化调查

用户确认此主机由 Grok Bot 提供。2026-08-28 查阅官方文档：

- 官方指定 `/workspace` 用于持久项目文件；正常更新及恢复会保留持久状态。临时目录、手动安装的软件及未提交的应用状态不能同等对待。[计算机与应用](https://docs.x.ai/grok-bot/computer-and-apps)
- Reset 会回到最近的持久快照，可能丢失最近未同步的工作。[故障排查](https://docs.x.ai/grok-bot/troubleshooting)
- 同一账号的 Grok Bots 共用这台计算机；这不是各 Bot 之间的安全边界。[概览](https://docs.x.ai/grok-bot/overview)

据此，一阶段功能验证可以继续使用该主机，不再因 overlay 或缺少独立 volume 而阻塞。计划数据根为 `/workspace/cumora-data/project-files`，位于源码 checkout、公开 uploads 和临时目录之外；路径通过部署配置指定。本次没有创建该目录或变更线上配置。

本次未查到快照频率、零数据损失或服务可用性保证。用户接受第一阶段文件丢失，不再要求备份及灾难恢复演练；实现应验证当前文件列表、失效引用及实际容量的处理。服务进程恢复与权限仍需测试。未执行平台 Update / Recover / Reset，也未重启现有服务。

Cumora 的受控任务仍需隔离底层对象、其他项目和凭证。具有主机管理权限的 Grok Bot/运维账号属于受信任管理方，不能宣称应用内挂载可以隔离平台管理员。

## 已运行检查

1. `node --import tsx --test server/src/__tests__/project-files-preflight.test.ts`：首次 4 项通过；持久化判定修正后扩展为 5 项，复测全部通过。
2. `npm run server:typecheck`：首次及持久化判定修正后均通过。
3. 远程 Linux 编译 `agent-fuse` 测试二进制：通过。
4. 在独立 user/mount/PID 命名空间运行 `TestProjectMountConcurrentHandles`：通过。
5. 同环境运行 `TestProjectMountRevokesAnAlreadyOpenHandle`：通过。

两个挂载测试实际经过 Linux 文件系统调用、FUSE 驱动、打开文件描述符和 fsync，不是仅检查 TypeScript 配置。它们使用内存测试夹具，证明基础冲突错误和撤权错误可以经内核返回；不证明生产权限服务、磁盘事务或真实 Agent runner 已完成。

远程临时测试目录和测试进程已清理。本机 SSH 临时副本仅当前用户可读，原始密钥未修改，临时副本未进入 Git。首次清理命令被本机执行工具拒绝；本次调查时只读确认该临时密钥路径已不存在，没有再次生成副本。

## 重现 Linux 挂载测试

在具备 `/dev/fuse` 和非特权 user namespace 的 Linux 测试机运行；不要使用线上数据目录。普通测试执行会跳过这些需真实挂载的用例，跳过不能算通过。

```sh
probe_dir=$(mktemp -d /tmp/cumora-project-p0.XXXXXX)
mkdir "$probe_dir/tmp"
cd agent-fuse
go test -c -o "$probe_dir/project-mount.test"
TMPDIR="$probe_dir/tmp" CUMORA_PROJECT_FS_MOUNT_TEST=1 \
  unshare --user --map-root-user --mount --pid --fork --kill-child --mount-proc \
  "$probe_dir/project-mount.test" -test.v -test.run TestProjectMount -test.timeout 30s
```

测试使用 `nosuid,nodev,noexec` 和 direct I/O，关闭条目、属性、负缓存。测试二进制要求处于受限 user namespace；挂载失败立即失败，不回退到 sudo、特权容器或普通未受控目录。

测试退出时先关闭文件句柄再卸载；PID/mount 命名空间随后退出。保留输出后，仅清理自己创建的 `probe_dir`，不要把示例路径替换成业务数据根。

## 下一步与边界

- 按 Grok Bot 官方指定的 `/workspace` 路径继续开发；部署前配置私有数据根，验证文件丢失处理、软件重装和服务进程恢复，不做备份。
- 继续 P0 的临时文件重命名保存、回收站、额度及真实文档工具测试。
- 建设实际任务 runner，验证 Agent 看不到 backing store/其他项目、退出及切换能停掉子进程、旧上下文不会进入新项目。
- 完成上述验证后进入 P1—P4，不把此测试夹具部署为共享文件服务。

参考：[Linux FUSE 文档](https://www.kernel.org/doc/html/latest/filesystems/fuse/fuse.html)、[Linux PID namespaces 手册](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html)。懒卸载不等于撤销打开的文件连接；结束 PID namespace 的 init 可终止该命名空间中的进程，但仍需验证实际 runner 的监管方式。

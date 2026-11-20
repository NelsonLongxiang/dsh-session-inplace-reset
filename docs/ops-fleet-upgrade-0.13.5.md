# 运维行动建议：dsh-session-inplace-reset 全网升级至 0.13.5

**委托人**：插件维护方　**执行**：运维　**优先级**：高（生产崩溃类缺陷已在 0.13.4/0.13.5 封死，旧版本仍带洞）
**日期**：2026-11-24　**预计每台机器耗时**：10–15 分钟（全程热操作，**不重启 DSH**）

---

## 1. 背景（为什么升）

该插件 0.13.0–0.13.3 存在两类生产级缺陷，均已在 0.13.4/0.13.5 修复：

| 缺陷 | 触发 | 后果 | 修复版本 |
|---|---|---|---|
| 超大会话重置把宿主打到 OOM | 压缩日志 ≳10MiB（原始 ≳48MiB）时 dryRun/execute 全量物化事件数组 | 宿主进程 3.5GB 堆 core-dump（.88 实证，systemd 拉起） | 0.13.2/0.13.3 |
| 重置持锁守卫同步 throw 击穿 a2a 定时器 | 会话在 a2a 名册中执行重置，reconcile/nudge 定时回调同步调 resolveAgent/steer | 宿主进程 fatal 崩溃（#756，.43/.156 实证） | 0.13.4/0.13.5 |

参考：issue [#1](https://github.com/NelsonLongxiang/dsh-session-inplace-reset/issues/1)、dsh-open-a2a-net [#756](https://github.com/NelsonLongxiang/dsh-open-a2a-net/issues/756)。

## 2. 分机器清单

| 机器 | 现状 | 动作 |
|---|---|---|
| **.88**（jf_serve_prod） | **已完成 0.13.5**（2026-11-24，PID 3169125 未变） | 仅核对：见 §5 完成态校验 |
| **.223**（jf-longxiang-dev，Windows，3080，计划任务 dsh-web-3080） | 0.12.2 | **升级**，注意 §4.223 专条 |
| **.43**（A2A peer） | 版本未知（.43 发生过 #756 UI 重置崩溃） | 预检 → 升级 |
| **.156**（A2A peer，13080/12080） | 版本未知（.156 发生过 #756 API 重置崩溃） | 预检 → 升级 |
| 本机（Administrator） | 已完成 0.13.5 | 无 |

## 3. 升级包

- 文件：`local-dsh-session-inplace-reset-0.13.5.tgz`
- **SHA-256**：`a60d53373989f92c809be4db491cc3acba1601ae973786b452d2fc5bcde003f1`
- 取包：`.88:/home/jf_serve_prod/dsh-data/pkgs/`（已就位）或插件维护方塔包目录；传到目标机器后**必须先核哈希**。

## 4. 标准热升级流程（每台待升机器）

> 全程不重启宿主、不改配置文件、不动其他依赖。任何一步失败：**停手**，按 §6 回滚，回报现场。

### 4.1 预检（只读，先做）

1. 找到当前登录口令：
   - Linux/systemd：`journalctl --user -u dsh-web-3080.service -n 300 --no-pager | grep -oE 'token=[A-Za-z0-9_-]+' | tail -1`
   - Windows/计划任务：读 DSH 启动日志最新一条 `token=…`（`%USERPROFILE%\.dsh\logs\web-3080.log` 或计划任务重定向文件）
2. 换 cookie：`curl -s -c ck.txt "http://127.0.0.1:3080/?token=<token>"`（下文 curl 均 `-b ck.txt`）
3. `POST /api/sessionReset/sessionResetRecoveries` → `operations` 与 `issues` 必须为空数组；非空则**停手上报**（有未完成重置事务）。
4. `POST /api/pluginManager/listPlugins` → 记录 `@local/dsh-session-inplace-reset` 当前版本与 `fiberPhase`、宿主 **PID**（Linux `systemctl --user show dsh-web-3080 -p MainPID --value`；Windows 记 3080 监听进程 PID）。
5. **依赖漂移检查**：读 profile `package.json` 的 `dependencies`，逐项对比 `node_modules/<包>/package.json` 实装版本。**任何 pin≠installed 的条目先上报、不要继续**（223 的 A2A 有此雷，见 4.6）。

### 4.2 塔包就位 + 核哈希

放到该机既有 pkgs 目录（223：`C:\Users\jf-longxiang-dev\.dsh\pkgs\`；Linux 机沿用其 dsh-data/pkgs），`sha256sum`/`Get-FileHash` 比对 §3。

### 4.3 热装（禁用→安装→启用）

1. `POST /api/pluginManager/setBundleEnabled` body `{"type":"client-request","rpcId":"r1","method":"pluginManager/setBundleEnabled","payload":{"args":{"name":"@local/dsh-session-inplace-reset","enabled":false}}}` → 响应须含 `"application":"applied"`
2. 在 profile 目录（`~/.dsh/profiles/web`）执行：
   `pnpm add "file:<塔包绝对路径>/local-dsh-session-inplace-reset-0.13.5.tgz" --save-exact --ignore-scripts`
   （能用 `--offline` 就加；报离线元数据缺失再去掉，但**绝不允许 pnpm 触碰其他依赖**——装完立即复查第 4 步漂移项不变）
3. `POST /api/pluginManager/setBundleEnabled`（enabled:true）→ `"applied"`
4. 校验：`listPlugins` 中该插件 `fiberPhase: "active"`；`node_modules/@local/dsh-session-inplace-reset/package.json` 版本 = **0.13.5**；**PID 与预检一致**。

### 4.4 升级后校验

1. `sessionResetRecoveries` 仍为空；
2. 依赖漂移复查（同 4.1.5）；
3. （可选，建议 .43/.156 做）用**业务会话的 fork 副本**打一次标记演练：fork → rename 标题含 `[reset-test]` → `sessionResetDryRun`（`canReset:true`）→ `sessionResetExecute`（`phase:"DONE"`、`verified:true`）。**只允许重置标题带 `[reset-test]` 的副本，绝不碰业务源会话。**

### 4.5 完成回报（每机一行）

`机器 / 升级前版本→0.13.5 / PID(前=后) / 漂移复查 / 演练结果 / 证据文件路径`

### 4.6 专条

- **223**：
  - pnpm 不在 PATH：用 `node C:\Users\jf-longxiang-dev\AppData\Local\hermes\profiles\af-mercadolibre-profit\node.broken-20261114\node_modules\pnpm\bin\pnpm.mjs add …`
  - **A2A 已知漂移（pin=preview.25，实装=preview.24）：保持 preview.24，绝不允许 pnpm 升它**。装完必须复核实装仍为 preview.24。
  - 宿主是计划任务 `dsh-web-3080`：**不要动它**（不重启、不重注册）。
- **.43**：a2a 包里有一份 2026-11-18 的手工热修（`index.js.bak-materialize-hotfix-20261118`）。**保留现状**：插件升到 0.13.5 后该热修已冗余但无害，待 a2a 正式升级时自然覆盖，不要手工还原 .bak。
- **.156**：此前按 #756 的冷读 workaround 摘过名册；全网 ≥0.13.5 后，可先在一个 `[reset-test]` 副本上验证"名册内会话重置不崩"，通过后再恢复名册常态（见 §7）。
- **通用禁令**：
  - 不重启宿主执行任何一步；
  - 不编辑 `cordis.patch.yml`（实测会触发整服务重启）；
  - 不用业务会话做重置测试；
  - 不升级/降级 A2A 及其他依赖。

## 5. .88 完成态校验（只读）

```
systemctl --user show dsh-web-3080.service -p MainPID,ActiveState --value   # active，PID 3169125（或有正常业务重启，NRestarts 无新增 core-dump）
listPlugins → @local/dsh-session-inplace-reset fiberPhase=active
node -e "console.log(require('/home/jf_serve_prod/.dsh/profiles/web/node_modules/@local/dsh-session-inplace-reset/package.json').version)"  # 0.13.5
sessionResetRecoveries → operations=[], issues=[]
```

## 6. 回滚

各机塔包目录保留全部历史版本。回滚 = 用旧 tgz 重复 §4.3 三步（例：`local-dsh-session-inplace-reset-0.12.2.tgz`）。回滚后同样回报版本与 PID。

## 7. 收尾判定（全网 ≥0.13.5 后）

1. 在 .156（或任一 A2A 开启机）用 `[reset-test]` 副本验证：名册内会话重置全程宿主不崩、`phase DONE`；
2. 通过后，"重置前先摘 a2a 名册并冷读"的临时 ops 规可宣布退役（README 已记录该规的适用范围）；
3. a2a 侧的 materialize 防御修复（#756 建议的新 PR）仍建议排期——插件侧已封死自己这一类，但防不了未来其他同步抛出的 face。

## 8. 升级中断与求助

- `setBundleEnabled` 未返回 `applied`、pnpm 失败、PID 变化、漂移项变动：立即停手，保留现场（响应体、pnpm 输出、`~/.dsh/session-reset/operations-*.jsonl`），回报委托人。
- 恢复类操作（`sessionResetResume`/回滚）只允许对标记副本与已授权会话执行。

# repair/ — DSH v4 会话日志修复工具链

修复 DSH v4 会话日志（`session.v4.jsonl.zstd`）的结构损坏；与重置插件互补——重置是核选项，这里是外科修复。全部工具零依赖（Node ≥22.15 标准库自带 zstd），校验器直接 import 宿主同源的官方格式库，升级 dsh 后自动跟随新规则。

来源：2026-11-14 ~ 11-22 修复战役（fix-P 三轮迭代＋全舰队 8 件损坏会话＋220b6caf 七层洋葱＋446ce672 重置后返修）沉淀；2026-11-22 自独立仓 `dsh-session-repair`（`11dab07`，树 `fcbabb2d`）并入本仓。前身语料档案：`~/.ygl-trees/preset-verify/session-repair/`（零删除保留）。

## 快速开始

```bash
# oracle / preflight / fix-compaction-span 需要宿主格式库目录（一次定位，处处设置）：
DSH_FORMAT_LIB="$(node -e "const p=require('path'),d=require('path').dirname(require.resolve('@deepseek-ai/dsh/package.json'));console.log(p.join(d,'node_modules','@deepseek-ai'))")"
export DSH_FORMAT_LIB
node repair/bin/oracle.mjs <session.v4.jsonl.zstd>        # 结构层校验
node repair/bin/preflight-v4.mjs <session.v4.jsonl.zstd>  # 持久层预检（装载同源逐行）
node repair/test/smoke.mjs                               # 合成件自检（不需要 DSH_FORMAT_LIB）
```

## 工具

| 文件 | 用途 |
|---|---|
| `bin/oracle.mjs` | 官方 v4 校验器封装：header + relationships（fold 语义）+ 逐行 admission。`oracle(file,label)` 可 import |
| `bin/preflight-v4.mjs` | 持久层预检：逐行复刻 SessionLogScanner.consumeEventLine（seq 连续 / sourceEventSeqs 区间与唯一 / 行级解码）——oracle 覆盖不到的维度 |
| `bin/fix-turn-rewind.mjs` | turn 号回退修复：从首个回退点起后缀统一 +N（`check` 零改动诊断） |
| `bin/fix-surface-ranges.mjs` | `sourceEventSeqs` 区间对 `[a,b]` 原地展开＋去重 |
| `bin/fix-compaction-span.mjs` | compaction `shadowedSeqs` 按面重放重算（二分迭代至全绿） |
| `bin/prune-events.mjs` | 删指定 seq 事件＋全量重排＋引用平移（含 `targets[].seq` / `shadowedRange`）；引用恰指被删 seq 即拒修 |
| `bin/repair-v4-session.mjs` | 主管线（v9）：fold 语义 turn 重编＋system 拉平＋补合法三明治头＋seq 安全网；`check`/`fix`/`ensure-head`/`frames` |
| `guard/watch-member-sessions.mjs` | 冷会话守卫 v3（.223 计划任务每 15 分钟）：fold 体检＋CLEAN 无头自动补头；只碰冷会话，备份 `.guard-<epoch>` |
| `lib/v4-file.mjs` | 共享件：zstd 多帧遍历、逐行解析、逐行一帧写回、surface 重放 |

## 病征速查（红字 → 工具）

| 装载/校验红字 | 层 | 工具 |
|---|---|---|
| `turn/start does not open the expected turn`（NUM 支） | turn 回退 | fix-turn-rewind |
| `turn/start does not open the expected turn`（缺 turn/end） | 未闭合轮 | 人工另判（工具拒修是守卫非判据） |
| `replacement sourceEventSeqs omit a shadowed surface node` | 区间对混入 | fix-surface-ranges |
| `sourceEventSeqs ranges must contain unique earlier seqs` | 平移撞号重复 | 人工：去重后重验 |
| `released v2 row N has seq gap` | seq 跳号 | 人工：推编号代数后平移（见下） |
| `compaction/xx shadowedSeqs do not name an exact current surface span` | 撤回后面序错 | fix-compaction-span |
| `command sourceEventSeq must name an earlier event` | 前向引用 | 人工：删该可选字段或修目标 |
| `image/offload: target seq N is not a current surface node` | offload 目标错面 | 人工：面＋类型匹配重定向（语义极限） |
| `image/offload: image index 0 does not exist` | 孤儿 offload（图已不存在） | prune-events 摘除 |

## 硬约束（修复前必读）

1. **帧律**：dsh 追加写入＝每行一个独立 zstd 帧，但历史件存在**多行帧**——必须解压全部帧 concat 后按 `\n` 切行。写回必须逐行一帧（单一大帧被 `committedBytes` 断言拒绝）。
2. **seq 连续律**：事件 seq 逐行 +1 无空洞无重复（宿主 persistence 扫描器强制，oracle 不查这维，preflight 查）。
3. **sourceEventSeqs 只认扁平数字**；v0 区间对 `[a,b]` 混入即损坏。
4. **compaction `shadowedSeqs` 必须等于当前面精确 span**（shadowedRange 端点间的全部面上 seq）。
5. **v4 占位头六约束**：step≥1 turn≥1；message.id 非空；source.kind 非空≠plugin；须在打开的 turn+step 窗口；surface 空时 append 建 protectedHead；任何 seq 插入连带平移全部引用（sourceEventSeqs/headerSeq/startSeq/endSeq/messageSeqs，以及 data.sourceEventSeq/shadowedSeqs/shadowedRange/targets[].seq）。
6. **尾部 open turn 是合法形态**（进程中断残留，装载器认）——修复工具的严格拒修只是守卫，不是损坏判据。

## 换件纪律

- **双门槛缺一不可**：`oracle` PASS ＋ `preflight` PASS 才算结构完好；换入后 md5 回拉核对。
- 换入前**必备份原件**（`.bak-<层>-<日期>` 后缀，会话目录内）。
- 换入窗口选**会话闲置期**（观察文件 mtime/size 静止 ≥ 数分钟；宿主内存中若有活运行时会带旧计数器续写，再撞接缝）。
- 平移历史教训：**先推编号代数再动手**（存储值 = 原值±历史平移的叠加；逐层核对，不盲猜方向）。
- 修复顺序建议：区间对 → seq 跳号 → step 跳号 → 前向引用 → compaction 跨度 → offload（由结构层到投影层）。

## 部署（.223 守卫）

守卫从本仓运行：计划任务 a2a-session-guard 每 15 分钟 `node guard/watch-member-sessions.mjs`。环境变量：`A2A_STATE_URL`（默认 127.0.0.1:13080）、`SESSIONS_ROOT`、`SESSION_GUARD_LOG`。

## 上游缺陷链（本工具链存在的根因）

- core「撤回（withdraw）」写坏事件编号 → 全族 turn 回退/跳号/跨度错（标本 `Withdrawn seq N and everything after it`）。
- a2a `materialize()` 同步抛未捕获 × sir 守卫 → 宿主崩溃：[issue #756](https://github.com/NelsonLongxiang/dsh-open-a2a-net/issues/756)，修法 [PR #740](https://github.com/NelsonLongxiang/dsh-open-a2a-net/pull/740)。
- sir 0.13.1 复位种子 turn 计数不衔接（重置后运行时从 turn 1 重开）。
- 老版本 seq-range 编码漏进 v4 → 区间对族。

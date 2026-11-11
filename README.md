# DSH Session In-place Reset

保持会话 ID 的 DSH 重置插件：完整历史 fork 备份并核验，隔离原日志，同 ID 写入一轮交接记录。重置目标会话时不重启 DSH 实例。

正式仓库：[NelsonLongxiang/dsh-session-inplace-reset](https://github.com/NelsonLongxiang/dsh-session-inplace-reset)。

当前版本 **0.7.1**，已验证宿主为 **DSH 0.2.1-rc.2 / Cordis 4.0.5 / Node 24**。单会话释放使用有边界的宿主适配；不匹配的运行时形状会拒绝操作。

## 使用

在左侧会话行选择 **⋯ → 原地重置…**。预览绑定该行的完整会话 ID，输入八位短 ID 后才允许执行。

**重生后的 Agent 预设** 默认沿用原会话，也可从宿主当前预设列表选择另一个。列表标明默认项和不可用项；更改选择会清空已输入的确认短ID。近期采样与模型候选两种重置均支持此选择。执行前校验可用性，完成后独立读回预设ID；备份保留原预设，失败恢复原会话。

- 运行中、有后台活动或不能确认生命周期拥有者时，存储修改前停止。
- 备份按完整事件前缀独立读回核验，不以压缩大小或事件数相近判断完整性。
- 原日志、缓存和 rewind 实体放入隔离区，失败先保留失败代际再恢复原件。
- 只有同 ID、交接轮与持久化读回核验通过才显示完成。当前标签页随后刷新，清除旧历史和统计。
- 已完成的重置不提供撤销按钮；执行失败会尝试自动回退，中断事务可显式恢复。归档备份与隔离原件不会自动删除。

## 安装发行包

发行入口均为 `dist/*.js`，可在普通 `node_modules` 中加载，不依赖 Node 对依赖包内 TypeScript 的类型擦除。仓库保留 TypeScript 源码及已生成的 JavaScript。

```sh
git clone https://github.com/NelsonLongxiang/dsh-session-inplace-reset.git
cd dsh-session-inplace-reset
npm pack --ignore-scripts
dsh plugin --profile web add ./local-dsh-session-inplace-reset-0.7.1.tgz --save-exact
```

上述打包使用已提交产物。修改源码后按下方开发流程重新生成，再打包；不要只复制 `.ts` 文件作为发行入口。

## 中断恢复

侧栏底部的 **恢复重置** 打开所有待恢复事务，即使原会话因隔离暂时从列表消失也可进入。选择 **核对并恢复…**，核对完整会话 ID、操作 ID 和时间，输入八位短 ID，再点击 **恢复原日志**。仍在列表中的会话也可从原重置弹窗进入恢复。

每个事务有独立的不可变清单和事件文件。恢复按磁盘实际位置查找并校验原件，不只依赖最后一条状态；原位已有的新内容先保留到新的代际目录，再回迁原件。途中再次失败可重新进入恢复，冲突或摘要异常会停止并保留数据。未完成或不可校验的事务会阻止新的重置。

该入口用于0.4.0起的未终结事务，不撤销已验证完成的重置，也不会自动续跑旧版重启记录。验证覆盖进程终止与文件操作失败；未做断电级验证。

## 评估模型连接配置

进入 **设置 → 模型 → 评估模型**，填写 **API Base** 和 **API Key**，点击保存。

只填服务域名时自动补全 `/v4/ai/evaluation-model`；也可填完整评估接口地址。服务需要支持现有 `typesafe-ai/jev` v4 评估协议。地址不能内嵌凭证、查询参数或片段，不自动跟随重定向。

地址和 Key 通过 DSH 原生凭证服务在同一记录内原子保存，按配置档隔离。页面只读取地址和配置状态，不回显 Key。已保存时留空保留当前 Key；首次自定义或更换服务域名时需要明确填写 Key，不会把默认凭证自动发送到新服务。

保存后下一次预览使用新配置，无需重载插件。已开始的两阶段评估继续使用其开始时的连接。配置变更会清空旧缓存，缓存身份也包含连接的私有摘要。

未保存自定义连接时，沿用 `AI_GATEWAY_API_KEY` → `~/.vercel.ai-gateway.env` 的默认凭证来源。独立合成验证 CLI 使用这组默认来源，不读取宿主私有凭证记录。

## 模型筛选预览

重置弹窗中的 **模型筛选预览** 先生成候选，不触发重置、不自动填写确认 ID。预览通过后可点击 **本次使用模型候选**，查看原文及来源，再输入短ID并选择 **应用候选并重置**。也可选择 **改用近期采样**；未明确选用候选时仍使用近期采样。

候选应用使用独立执行接口。后端在会话并发闸内重新读取相同消息投影，核对报告ID、完整源摘要/游标、判据与采样版本、当前连接和体积预算。只允许当前进程缓存中完整通过的报告；灰带、失败、未送评、预算遗漏、源或连接变化、缓存失效均拒绝。执行不再次调用模型，也不会静默截断候选或退回近期采样；成功回执、事务记录和最终交接文本可对应到报告。

从宿主正式消息投影读取可见文本和文本工具回执，展开旧交接并标记历史引用。交接种子仅含原文、角色、来源与顺序；模型评分和判定只保留在报告中，不作为续聊事实写入。最多选择2048个片段，在最多64批内评估；每批来源上下文最多32片段、48KB，包含首尾和最新直接用户消息锚点；核对时仅附该批对应的候选原文，来源和引文合计也受48KB限制。每个片段只评分一次，超过预算的原文明示未送评。请求按实际批次使用，完成即停止，192是单次预览的安全上限，不是每次固定调用次数；长历史相应增加耗时和费用。先逐批判断必要程度/后续纠正，再用全部已选原文组成的交接包逐批核对约束、任务状态与事实边界，最多192次请求，无自动重试。在192次总请求上限内，初次核对不足且完整送评原文能放入预算、没有筛选或纠正灰带时，改用完整原文候选核对一次。保留原来的必要程度评分和两次核对记录，不对相同候选反复请求、不调整0.7/0.4门槛。

保留等级2/3的合计概率：≥0.7保留、≤0.4省略、中间保留原文并标记待核验。各批都须达到门槛；界面显示各批最低概率，不将其冒充全局联合概率。目标体积默认64KB。未送评、预算遗漏、概率灰带或服务不可用均不能显示完整通过。

报告写入 `~/.expert-teams/data/dsh-session-inplace-reset/runs/`，包含来源序号、源摘要、判据/采样版本和安全的评估端点，不包含 API Key。模型判断不构成新的操作授权或外部事实验证；尚无独立人工标注的真实长历史准确率基准。

## 开发与测试

新增业务实现与客户端源码使用 TypeScript。浏览器源是 `src/client.ts`，先生成 `lib/client.js`，再由 `tools/build-package.ts` 将后端和客户端生成到 `dist/`；生成物不能单独修改。TypeScript 编译器仅为开发依赖，运行包不安装额外 DSH 或 React 副本。

```sh
npm install
node --run build
node --run check:client
node --run check:runtime
node --run typecheck
node --run test
```

隔离测试使用临时目录、模拟凭证存储和本地 HTTP 服务，不调用真实模型，不修改真实会话或凭证。包含强制终止子进程、隔离/恢复中途失败、失败代际保留、损坏账本保全及普通 `node_modules` 导入检查。

集成检查前参考 `.env.example` 配置本机 `.env.local`。浏览器必须使用已经运行且已登录的 CDP，不另起浏览器、不自动登录或修改共享 cookies；只操作本轮新建的 target，先记录 ID，再导航，最后核对关闭。

```sh
node test/browser-menu.mjs
node test/browser-menu.mjs --evaluation-settings
node test/check-live-reset.mjs --inspect-only
```

默认浏览器检查模拟重置与模型响应。设置页检查执行真实安全读取，凭证写入回执被模拟，不替换现有真实 Key。

显式检查：

```sh
node test/check-install.ts --launcher /path/to/dsh/lib/bin.js --archive /path/to/local-dsh-session-inplace-reset-0.7.1.tgz
```

此检查复用已有 DSH 安装，在独立 `DSH_HOME` 中离线安装发行包、使用随机 loopback 端口启动隔离实例，验证原生凭证持久化和真实会话文件的中断恢复。只停止自己创建的隔离进程，不操作当前服务；凭证测试只使用虚构 Key。

```sh
node test/browser-menu.mjs --model-preview
node test/check-model-preview.ts --live --heldout
node test/check-live-reset.mjs --reload-only
node test/check-live-reset.mjs --prepare-model-preview
node test/check-live-reset.mjs --run
node test/check-live-reset.mjs --run --agent-preset minimal
node test/check-model-apply.ts --run
node test/check-model-apply.ts --resume /path/to/model-apply-run
node test/check-model-coverage.ts --live --session <configured-test-source> --baseline /path/to/old-report.json
```

模型预览与合成验证会调用真实评估模型。覆盖检查只读取配置中的测试来源，核对源摘要与前后状态，不请求重置。`--prepare-model-preview` 和普通 `--run` 需要明确的 `DSH_TEST_SOURCE_SESSION`，只从该来源 fork 新标记副本并重置副本。`check-model-apply.ts --run` 会创建一条短测试来源并调用一次聊天模型，再对其新fork进行真实评估、明确选择和菜单重置；来源保持原历史。测试中断时保留run目录，`--resume` 复用其中记录的来源和副本，先检查已提交事务，不重复已完成的重置。集成驱动目前按 Windows 本机3080服务核对有效PID；启用回执必须为 `applied`，不能只凭PID未变认定新接口已生效。

## 本地已安装副本的更新

正式源码在本仓库。如果运行实例仍 link 到另一个目录，可在保留旧版本快照后，将已提交源码通过 `git archive` 导出到该目录，再用 `--reload-only` 仅热加载本插件。保持安装路径可以避免路径变化带来的实例重启要求。

部署副本应有指向本仓库与具体提交的 `SOURCE.md`。不要把部署副本变成另一条源码分支，也不要将 `.env.local`、凭证或运行证据复制入库。架构与边界见 [docs/design.md](docs/design.md)。

# DSH Session In-place Reset

保持会话 ID 的 DSH 重置插件：完整历史 fork 备份并核验，隔离原日志，同 ID 写入一轮交接记录。重置目标会话时不重启 DSH 实例。

正式仓库：[NelsonLongxiang/dsh-session-inplace-reset](https://github.com/NelsonLongxiang/dsh-session-inplace-reset)。

当前版本 **0.3.0**，已验证宿主为 **DSH 0.2.1-rc.2 / Cordis 4.0.5 / Node 24**。单会话释放使用有边界的宿主适配；不匹配的运行时形状会拒绝操作。

## 使用

在左侧会话行选择 **⋯ → 原地重置…**。预览绑定该行的完整会话 ID，输入八位短 ID 后才允许执行。

- 运行中、有后台活动或不能确认生命周期拥有者时，存储修改前停止。
- 备份按完整事件前缀独立读回核验，不以压缩大小或事件数相近判断完整性。
- 原日志、缓存和 rewind 实体放入隔离区，失败先保留失败代际再恢复原件。
- 只有同 ID、交接轮与持久化读回核验通过才显示完成。当前标签页随后刷新，清除旧历史和统计。
- 当前没有手动撤销按钮；已实现的是失败自动回退。归档备份与隔离原件不会自动删除。

## 评估模型连接配置

进入 **设置 → 模型 → 评估模型**，填写 **API Base** 和 **API Key**，点击保存。

只填服务域名时自动补全 `/v4/ai/evaluation-model`；也可填完整评估接口地址。服务需要支持现有 `typesafe-ai/jev` v4 评估协议。地址不能内嵌凭证、查询参数或片段，不自动跟随重定向。

地址和 Key 通过 DSH 原生凭证服务在同一记录内原子保存，按配置档隔离。页面只读取地址和配置状态，不回显 Key。已保存时留空保留当前 Key；首次自定义或更换服务域名时需要明确填写 Key，不会把默认凭证自动发送到新服务。

保存后下一次预览使用新配置，无需重载插件。已开始的两阶段评估继续使用其开始时的连接。配置变更会清空旧缓存，缓存身份也包含连接的私有摘要。

未保存自定义连接时，沿用 `AI_GATEWAY_API_KEY` → `~/.vercel.ai-gateway.env` 的默认凭证来源。独立合成验证 CLI 使用这组默认来源，不读取宿主私有凭证记录。

## 模型筛选预览

重置弹窗中的 **模型筛选预览** 仅生成候选交接包，不触发重置，不自动填写确认 ID。实际重置仍使用上方近期采样；模型候选尚未自动替换实际交接包。

从宿主正式消息投影读取可见文本和文本工具回执，展开旧交接并标记历史引用。最多送评32个片段、48KB候选文本，首尾与最近直接用户消息优先获得预算。两次请求分别判断必要程度/后续纠正，并核对约束、任务状态与事实边界。

保留等级2/3的合计概率：≥0.7保留、≤0.4省略、中间保留原文并标记待核验。目标体积默认64KB。未送评、预算遗漏、概率灰带或服务不可用均不能显示完整通过。

报告写入 `~/.expert-teams/data/dsh-session-inplace-reset/runs/`，包含来源序号、源摘要、判据/采样版本和安全的评估端点，不包含 API Key。模型判断不构成新的操作授权或外部事实验证；尚无独立人工标注的真实长历史准确率基准。

## 开发与测试

新增业务实现与客户端源码使用 TypeScript。浏览器源是 `src/client.ts`，`lib/client.js` 是由 Node 24 内置类型擦除生成的宿主入口。

```sh
node --run build:client
node --run check:client
node --run test
```

隔离测试使用模拟凭证存储和本地 HTTP 服务，不调用真实模型，不修改真实会话或凭证。开发依赖用于 `node --run typecheck`；运行与客户端生成不需要额外编译工具。

集成检查前参考 `.env.example` 配置本机 `.env.local`。浏览器必须使用已经运行的 CDP，不另起浏览器；只操作本轮新建的 target，先记录 ID，再导航，最后关闭。

```sh
node test/browser-menu.mjs
node test/browser-menu.mjs --evaluation-settings
node test/check-live-reset.mjs --inspect-only
```

默认浏览器检查模拟重置与模型响应。设置页检查执行真实安全读取，凭证写入回执被模拟，不替换现有真实 Key。

显式检查：

```sh
node test/browser-menu.mjs --model-preview
node test/check-model-preview.ts --live --heldout
node test/check-live-reset.mjs --reload-only
node test/check-live-reset.mjs --prepare-model-preview
node test/check-live-reset.mjs --run
```

前两条会调用真实评估模型。最后两条要求明确的 `DSH_TEST_SOURCE_SESSION`，仅从指定来源 fork 新测试副本；`--run` 只重置新建并标记的副本。来源不会被重置。集成驱动目前按 Windows 本机3080服务核对有效PID；启用回执必须为 `applied`，不能只凭PID未变认定新接口已生效。

## 本地已安装副本的更新

正式源码在本仓库。如果运行实例仍 link 到另一个目录，可在保留旧版本快照后，将已提交源码通过 `git archive` 导出到该目录，再用 `--reload-only` 仅热加载本插件。保持安装路径可以避免路径变化带来的实例重启要求。

部署副本应有指向本仓库与具体提交的 `SOURCE.md`。不要把部署副本变成另一条源码分支，也不要将 `.env.local`、凭证或运行证据复制入库。架构与边界见 [docs/design.md](docs/design.md)。

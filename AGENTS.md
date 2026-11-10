# dsh-session-inplace-reset

DSH 同 ID 会话重置与评估模型采样预览插件。正式仓库：
https://github.com/NelsonLongxiang/dsh-session-inplace-reset

## 工作入口

- 新增实现使用 TypeScript。浏览器源码在 `src/client.ts`，`lib/client.js` 由 `node tools/build-client.ts` 生成，勿单独修改生成文件。
- `node --run test` 运行隔离测试；`node --run check:client` 检查生成文件。测试不依赖真实模型或凭证。
- 运行证据写入 `~/.expert-teams/data/dsh-session-inplace-reset/`，不入库。不要提交密钥、cookies、日志、真实会话内容或本机 `.env.local`。
- 评估配置使用 DSH 原生凭证服务；读接口只返回存在状态，不能回传 Key。
- 有 `SOURCE.md` 时，本目录是部署副本：先按该指针找到正式源码，不把部署副本当作另一条开发分支。

## 验证边界

- 浏览器集成测试仅创建、操作和关闭自己的 CDP target；端点由本机 `.env.local` 配置，不另起浏览器或清理共享登录态。
- 普通浏览器检查拦截重置和凭证写入。创建测试副本须显式使用 `--prepare-model-preview` 或 `--run` 并提供 `DSH_TEST_SOURCE_SESSION`；真实重置仅允许 `--run` 新建且标记的测试副本，来源不重置。
- 不重启整个 DSH 来执行单会话重置；生命周期形状不符时拒绝操作。
- 保留原件、备份、隔离与失败代际。不能用事件数相近或压缩体积相近替代逐事件备份验证。
- 同一模型的自评不是独立真值；灰带、未送评、失败和未执行的检查分别报告。

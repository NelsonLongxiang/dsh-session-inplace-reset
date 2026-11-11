# dsh-session-inplace-reset

DSH 同 ID 会话重置与评估模型采样预览插件。正式仓库：
https://github.com/NelsonLongxiang/dsh-session-inplace-reset

## 工作入口

- 新增实现使用 TypeScript。浏览器源码在 `src/client.ts`，`lib/client.js` 由 `node tools/build-client.ts` 生成；`dist/` 由 `node tools/build-package.ts` 编译并改写相对导入。勿单独修改生成文件。
- `node --run build` 生成全部发行入口，`check:client` / `check:runtime` 检查生成一致性；`node --run test` 运行隔离测试，不依赖真实模型或凭证。
- 运行证据写入 `~/.expert-teams/data/dsh-session-inplace-reset/`，不入库。不要提交密钥、cookies、日志、真实会话内容或本机 `.env.local`。
- 评估配置使用 DSH 原生凭证服务；读接口只返回存在状态，不能回传 Key。
- 有 `SOURCE.md` 时，本目录是部署副本：先按该指针找到正式源码，不把部署副本当作另一条开发分支。

## 验证边界

- 浏览器集成测试仅创建、操作和关闭自己的 CDP target；端点由本机 `.env.local` 配置，不另起浏览器或清理共享登录态。
- 普通浏览器检查拦截重置和凭证写入。创建测试副本须显式使用 `--prepare-model-preview` 或 `--run` 并提供 `DSH_TEST_SOURCE_SESSION`；真实重置仅允许 `--run` 新建且标记的测试副本，来源不重置。
- 不重启整个 DSH 来执行单会话重置；生命周期形状不符时拒绝操作。
- RPC 由插件自己的 `sessionReset` Remote service 提供，不能依赖对宿主 `workspaceRegistry` 的内存补丁或残留绑定。热升级保留旧贡献拥有者，新接口仅由本包 `/preview` 贡献注册。
- `lib/reset-journal.ts` 的清单和事件文件不可覆盖；中断恢复按实际文件位置与摘要校验，先保留新代际再回迁原件。原会话行可能已消失，恢复入口必须支持全局查找。
- 保留原件、备份、隔离与失败代际。不能用事件数相近或压缩体积相近替代逐事件备份验证。
- 模型候选只能通过独立 `sessionResetExecuteModel` 接口应用；源投影/游标、连接、判据版本、完整覆盖及原文来源均须重新核对。缓存过期、灰带或失败不能退回近期采样，更不能信任客户端传入种子。
- 长历史最多64批筛选，每批≤32片段/48KB，上限192次模型请求，按实际需要运行、完成即停止；任何未送评文本、缺失批次、灰带和输出预算遗漏都不能报告完整通过。逐批trace保留，最低批次概率不等于全局联合概率。
- 同一模型的自评不是独立真值；灰带、未送评、失败和未执行的检查分别报告。

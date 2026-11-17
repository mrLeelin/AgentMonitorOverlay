# Codex 会话底栏 Goal

状态：做完（2026-11-16）。源码已实现并在隔离环境验证，当前用户 Host 未重启加载。

## 用户决定

- 2026-11-16：在会话输入框下方、型号/思考强度/Fast/权限/MCP 所在栏增加 Goal 功能，先接 Codex 原生 Goal，不创建 `$goal` 技能，也不模拟其他 Agent 的自主循环。
- Goal 由用户明确填写目标开启；Token 预算可选，不默认添加。当前会话不会因功能上线自动启用 Goal。

## 行为与边界

- 入口在 MCP 右侧，仅本机 Codex 会话显示。面板展示原生目标、六种状态、已用 Token/预算与累计用时；预算耗尽后可增加总预算继续。
- 开启或恢复使用 `thread/goal/set`，由 Codex 自动开始空闲线程的工作，不另发 `turn/start`。暂停续跑和清除目标不打断当前回复；原有停止按钮先暂停续跑再中断当前轮，暂停同步失败仍尝试中断并报告真实错误。
- 归档前暂停整棵会话树的 Goal，恢复后读取实际状态，不自行激活；fork 不从父会话复制 Goal。只读/归档会话不允许通过面板修改。
- 目标以 CLI 为准，Host 读取并监听原生通知，SQLite 的 `Session.goal` 是最近快照。active 的轮间空档计为仍在工作，避免提前进入待审阅、切换主控或被当作可重启。
- active Goal 持续执行工作时，不切换为只读询问或通知用途。来自收件箱的这类消息保持等待，暂停/结束后再投递，保留原有验收与权限边界。
- 设置与 Goal 修改串行；开启前通过实验性 `thread/settings/update` 同步型号、思考强度、权限和 Fast。同值设置被原生 app-server 去重而不发通知，连接从 start/resume 响应和 settings 通知维护实际快照，不能只等通知或把空响应当作已经应用。停止抢先取消待开启的 Goal。
- 前端先订阅再读取，读取期间重放事件，重连重读；旧 Host/CLI 与读写失败显示具体原因，失败不清空目标草稿。尚不提供其他 Agent 或远程副本的 Goal 控制。

## 验证范围

定向单测覆盖原生请求、预算/目标校验、权限与停止竞态、持久化、状态通知和旧协议；隔离 Electron 使用真实 Codex CLI 与本机 mock 模型验证自动续轮、暂停/继续/停止/清除、刷新、预算耗尽和加预算、旧 Host 错误及非 Codex 隐藏入口。检查深浅主题和窄窗口截图 `screenshots/studio/goal-*.png`。未调用真实付费模型，未重启用户 Host，未提交或发布。

原生语义依据同版 Codex 0.167.2：[Goal RPC](https://github.com/openai/codex/blob/rust-v0.167.2/codex-rs/app-server/src/request_processors/thread_goal_processor.rs)、[Goal 自动续轮](https://github.com/openai/codex/blob/rust-v0.167.2/codex-rs/ext/goal/src/runtime.rs)、[设置通知去重](https://github.com/openai/codex/blob/rust-v0.167.2/codex-rs/app-server/src/bespoke_event_handling.rs)。

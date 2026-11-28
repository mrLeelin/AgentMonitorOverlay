# 机器人主控三阶段集成验收

2026-11-28，`feat/studio-bots` 工作区，HEAD 为 `fb3bea735c6b1842019b374ae516a0cfd0b6ec31`。对照 [冻结方案 §10](../plans/bot-topic-leads.md#10-交付顺序和验收清单) v1。本轮命令使用 BelowNormal，Vitest 最多 4 workers，Electron 单 worker。Electron 使用隔离数据库、配置、端口和临时项目。

## 逐项证据

| §10 场景 | 观察结果与范围 |
| --- | --- |
| 首次带队、模型启动前断线 | 从原 Bot 请求接单并打开正式卡。首轮前关闭隔离应用时保存 1 张正式卡和 1 个任期。重开后继续原启动。缺失 Codex 程序显示 ENOENT，恢复后同卡、同任期只建立一个会话。见 `bot-lead-local-entry.spec.ts` 的 `startup-receipt.json` 和断线回执。 |
| 已有专题、多根、同名、多项目、双窗口 | 两窗口的独立执行与带队竞争均复跑，先成功的承接有唯一回执。同名三根要求选确定目标，只投递到所选任务 ID，重开从原对话回原卡，其他两根与手工布局保留。见 `bot-lead-local-{entry,canvas}.spec.ts`。 |
| 执行任务安全升主控 | 原窗口实际旧回合阻塞时显示等待，回合安定后复用原任务和正式卡。Host 复跑同时核对原目录、交接证据、直属上级、历史会话及迟到管理工具的拒绝。 |
| 同一 Bot 跨专题、重置主聊天及迟到会话 | 原消息定向、独立任期和管理范围均已复跑。另用集成用例在重置主聊天后逐个走两树的 MCP 派工、问题和直属验收，核对各树的会话、问题及结果编号。旧任期和迟到权限单测属于 Host 证据。 |
| 并发换任与在途交付 | Host HTTP 同时换任实际 200/409，交接阶段提交的同一结果只投递一次。独立 Electron 从画布进入换任并查历史，任务和原节点不迁移。 |
| 停用、删除、全局开关、模型失效、暂停恢复 | 隔离 Electron 从旧主控绑定后验证全局隐藏及恢复。Host 覆盖单 Bot 停用、模型丢失、人工暂停优先、在途交付以及归档后删除历史负责人。 |
| 层级、跨根依赖、退回重交、共同需求换版 | Host 复跑混合等待环、跨根权限、采用冻结版本及下游按新版前置重开。Electron 实际退回子交付，子项重交并验收后下游首轮收到新版结果 ID。 |
| 隔离工作树、接入和基准漂移 | Host 实际 Git checkout 验证不接入时不启、接入对应提交后单次放行，基准漂移或文件证据变化阻止根验收。Plane 模拟服务的 Electron 用例使用真实临时 checkout 与实际文件差异。 |
| 正式卡、拖动冲突、筛选、主题、窄屏、键盘 | Host 拦截整图、单卡、批量和撤销导致的正式卡缺失。双 renderer 拖动冲突重读后合并两处坐标。集成用例用键盘独立显隐管理虚线和依赖实线，窄屏可滚动列表在深浅两色下均用 Enter 定位前置，布局版本保持 21。 |
| 两档任务卡、单支详情、首屏与重连 | 见下表。302 卡另测首屏只发两根首页摘要，首次打开一个中控分支只增加一条该根的 `parentTaskId` 查询。 |
| 进度查询、追加、待决定、原生审批、两处验收 | Host 分开验证只读查询保留交付和实际工作重开。隔离 Electron 两入口提交相反验收获得 200/409。真实 Codex 回合的原生文件读取审批从画布定位到发起会话，并保留原生审批 ID。 |
| 历史、无专题、待换任、旧归档、已验收、异常链 | Host 在旧版 schema 42 的数据库文件副本复跑迁移和布局核对，专项补验 #43 现任及历史归属。旧库验收的完整前后数量与在途记录引用阶段二交付。隔离 Electron 从原卡给总主控、中控绑定并保留原提案。 |
| 新旧 Plane、退回、账号切换、写回中断 | 隔离 Electron 复跑原独立单和新带队单。Host 验证同专题两根独立，根人工通过前零写回，账号不匹配时留待处理，响应丢失只核回对应原单和结果 ID。真实服务及业务单的边界见下节。 |

## 运行结果与留存

- 全仓 `npm run typecheck` 和 `npm run build` 通过。定向 Host、协议、UI 辅助逻辑和导航 29 文件 377 通过，1 项崩溃恢复子进程入口按条件跳过。隔离真实 Codex app-server 接模拟模型的集成、SQLite 迁移和重启脚本 4 文件 43 通过。两组日志为 `host.log` 和 `native-host.log`。
- 第一、二阶段入口、画布性能和 Plane Electron 合计 20 通过。另加窄屏双主题及主聊天重置后两树隔离 2/2。在线条目在综合组按开关跳过，单独执行 1/1。日志为 `electron.log`、`integration-verified.log` 和 `real-electron.log`。新用例见 [bot-lead-integration.spec.ts](studio/bot-lead-integration.spec.ts)。
- 深浅窄屏截图见 `studio/screenshots/studio/bot-lead-integration-narrow-{light,dark}.png`。可见画布工作区域触发任务列表模式，列表 601 px 高，内容 650 px，前置链接均用同一键盘操作验证。截图另存 Playwright 附件。
- 本机日志、步骤 JSON、截图附件和同机基线复测位于 `%TEMP%\amo-bot-lead-integrated\`。初次综合 Playwright 命令把 `--output` 交成空值，走了默认 `studio/test-results`。综合附件已复制到 `electron`。首测基线的逐轮时延和请求数仍在已验收的 [原基线](canvas-performance.md)，原路径下的逐请求 JSON 未找到。从同一冻结源码复跑的独立 JSON 在 `frozen-baseline-rerun`，保留这两次采样的区别。

### 画布性能

同机、同 fixture、同 Electron 44.7.0，50 卡和 302 卡各 1 轮预热及 5 轮计量。冻结版视口 870×705、当前版 870×701，均为 CSS px、DPR 1。下表为中位毫秒和每轮 HTTP 数。重连两版都另有 1 次 WebSocket，包含约 2 秒重连等待。

| 卡数 | 操作 | 同机冻结版 ms／HTTP | 当前版 ms／HTTP |
| ---: | --- | ---: | ---: |
| 50 | 首屏 | 66.6／59 | 60.4／9 |
| 50 | 恢复画布枝条 | 42.8／0 | 29.3／0 |
| 50 | 重连 | 2090.5／156 | 2068.8／49 |
| 302 | 首屏 | 293.2／311 | 258.2／9 |
| 302 | 恢复画布枝条 | 146.2／0 | 110.0／0 |
| 302 | 重连 | 2375.3／660 | 2242.6／49 |

冻结版逐卡 `/context` 在 50／302 卡首屏是 50／302 次，重连是 100／604 次。当前版相关请求为 0，首屏和重连各两条根摘要，断线时写入的坐标在重新连接后显示。画布恢复已有枝条的 0 请求与首次在详情展开中控支路的 1 次摘要属于两个操作。

### 在线模型、服务与业务单

- 在线 Codex 使用已有登录的临时副本、独立 `CODEX_HOME` 和临时 Git 项目，禁用模拟模型地址。主控派两项任务，执行项从原生审批 `approval-0bf6d38c-f5dd-4bb3-9c2b-35613a404d58` 读出两行清单，子交付退回后换版，下游采用新版结果 `result-06164261-9d20-41d4-b331-a475e1adfe61`；根退回后通过 Focus 定位并键盘接受 `result-79799950-c36c-4232-a451-be4d99af858a`，`reviewedBy=user`。存档在 `real-electron`。预算预加载未在 Electron 子 Host 生效，运行后用三份会话记录对账 9 个已完成回合，额度台账从 208 补记到 217，限额 300。该轮先计数步骤未完成。
- 使用现有加密连接在独立进程读真实 Plane catalog 和项目看板，HTTP 均为 200。账号 ID 两端一致，选定项目可见，服务报告可写。证据 `plane-readonly.log`。未提交指派、状态修改或评论请求。
- 服务源码的 overlay 在事务内锁定原工作项，按原单、来源、结果 ID 和实际账号对账。客户端的原生回退按原单评论读取回执，遇发送结果不明时保持待核对。三份 overlay 源文件已通过 Python AST 解析。真实部署已复核读取和身份契约。2026-11-28 用户决定以已有隔离验证完成本次交付，真实部署的完整流程、接单账号指派、实际工单的工作树接入和评论回写列为保留的业务验收项。本轮无需测试单，真实工单无写入。见 [overlay](../integrations/plane/amo_team_board.py) 和 [Host 写回](../packages/host/src/features/teamtasks/board.ts)。

## 代码位置

- 任命事务、只读任期和旧主控树见 [botleads/service.ts](../packages/host/src/features/botleads/service.ts)、[botleads/legacy.ts](../packages/host/src/features/botleads/legacy.ts) 和 [core/bot-lead-access.ts](../packages/host/src/core/bot-lead-access.ts)。
- 派工、接入门禁和逐层验收见 [taskplans/service.ts](../packages/host/src/features/taskplans/service.ts)、[taskplans/worktrees.ts](../packages/host/src/features/taskplans/worktrees.ts) 和 [orchestration/service.ts](../packages/host/src/features/orchestration/service.ts)。
- 任命、画布和根交付入口见 [LeadAppointment.tsx](../packages/ui/src/bots/LeadAppointment.tsx)、[CanvasPage.tsx](../packages/ui/src/canvas/CanvasPage.tsx) 和 [LeadWorkflow.tsx](../packages/ui/src/bots/LeadWorkflow.tsx)。
- Plane 双模式、批准版本、根证据及回写见 [PlaneBotPlan.tsx](../packages/ui/src/teamtasks/PlaneBotPlan.tsx) 和 [plane-bot-jobs.ts](../packages/host/src/features/teamtasks/plane-bot-jobs.ts)。共享接口见 [BOT-LEAD-INTEGRATION.md](../packages/protocol/BOT-LEAD-INTEGRATION.md)。

## 入口和手动加载

- 本地从 Bot 原消息「安排这条请求」选择既有主控或新带队目标，再点「打开专题画布」。也可从专题画布点「请机器人带队」，或从任务、新建页和快速开始选机器人。旧树从原任务或原画布的「绑定机器人」恢复活动任命。
- Plane 从左侧「团队任务」过原单「交给 Bot」。在 Bot 计划卡确认批准项目、基准和执行方式，带队单在根交付完成最终验收。已接单的旧独立流程沿原卡验收。
- 等当前工作区的会话都空闲，由人在 `E:\Project\Tools\AmoStudio` 双击 [restart-amo.bat](../../restart-amo.bat)。脚本保护运行中会话，构建此源码，关闭此数据目录的 Host 和外壳，然后备份 `studio/.data/studio.db*`。重新打开后数据库迁移至 45，可以从原专题查看任务、历史和负责人。数据库开始写入新版记录后，后续修复沿兼容版本；数据库回退需人决定是否导出新工作并使用与旧应用配套的备份。

## 实际采用的上游交付

| 内容 | 当前已验收的编号 |
| --- | --- |
| 共同协议 | `result-5dae3e6e-c44f-42ed-af8c-059275dc7744` |
| 冻结性能基线 | `result-23b5a46a-0c0b-4b2f-b852-24554d38f1fa` |
| 第一阶段 Host 任命 | `result-79282df5-74d1-4048-b860-911c5e2bf497` |
| 第一阶段派工和逐层验收 | `result-b19a8ee6-a8a3-4680-b69a-3b57d9b39835` |
| 第一阶段 UI 接单入口 | `result-4a5c43c8-b507-4f1a-932e-792ab545e1fc` |
| 第一阶段隔离联验 | `result-7bf5e882-5583-488d-ae19-704a03e09fff` |
| 前置交付换版重开修正 | `result-9345f2da-446c-4151-a73f-a08106ec32cf` |
| 第二阶段入口、换任及旧库演练 | `result-52b352fb-b0f2-4ce3-bef1-71c47200e27e` |
| 第三阶段 Plane，正式直接前置 | `result-4faa6a30-2369-4be5-88b9-233855402e41` |

上游阶段一的完整冻结工作区对照中，普通任务换工作区的旧 HTTP 断言期待 409，实际 200。它未计作本轮 Host 通过项。旧 `lead-mcp` 断言已由上游调整为当前任命入口并在本轮专项复跑通过。

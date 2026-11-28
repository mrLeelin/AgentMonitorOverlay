# 机器人主控公共协议与接线

实施依据为共同需求 `context-9be70e92-6b10-4d85-bdb8-4d537b4706da` v1 的 §7、§9、§10。路径相对于 `studio/`。表中的 Host、UI 路径是实施接点，阶段归属按任务分工。

## 公共协议

| 能力 | 符号及接口 | 接线约定 |
|---|---|---|
| 首次任命、追加、升级 | `bot-leads.ts` 的 `BotLeadAppointmentInput`、`BotLeadOperationReceipt`。POST `/api/bot-leads/appointments` | 用 `intent` 明确区分 `create`、`continue`、`upgrade`。`create` 指定项目、已有专题 ID 或新专题标题和 Bot；`continue` 指定任务、期望任期和工作意图；`upgrade` 沿用原任务，等安定交接。可用 `newBot` 与任命共用操作 ID。读进度和回答问题继续用现有读取、决策接口。 |
| 承接去重与恢复 | `BotRequest.acceptance`，旧 POST `/api/bot-requests/:id/worker` 可带 `operationId`，GET `/api/bot-leads/operations/:id` | 同一操作同参数返回已保存的原回执，异参报 `operation-conflict`。首次承接用来源唯一键，在旧 worker 与带队入口共用事务裁决。带队入口命中已承接时返回获胜的回执；旧 worker 在带队已获胜时可返回带原回执的 `source-already-accepted`，保持旧成功体。显式 `sourceUse: "new-goal"` 允许建立独立目标。传入真实用户消息必须查来源会话、消息和用户动作。投递的实时阶段在操作查询中读取。 |
| 任期与只读会话 | `BotLeadTermRef`、`BotLeadTerm`、`BotLeadTaskState`、`Task.botLead`、`Session.botLeadTerm`、`TaskResult.submittedByLead`。GET `/api/tasks/:id/bot-lead` 和 `/terms/:termId` | 快照通过 `GET /api/state` 的任务投影，订阅 `bot-lead.changed` 与既有任务、会话、画布和 Bot 事件。控制接口 POST `/api/tasks/:id/bot-lead/control` 校验 `expectedTerm`，支持换任、取消交接、重试、暂停和恢复。启动状态与交付阶段分别由任期与工作流记录。交付、历史会话存提交当时的身份。 |
| 中控与旧客户端 | `PlannedTask.leadBotId`、`BotLeadLegacyBindingsInput`、`HostErrorDetails` | 中控复用分工项与管理关系。POST `/api/tasks/:id/bot-lead/legacy-bindings` 按根接收绑定批次。旧 `lead` 字段继续解码。强制规则启用后，裸 `lead:true` 返回现有 409 `conflict`、可读中文提示和可选 `appointment-required` 明细；旧待办保留原提案与交接。 |
| 按根分页与证据 | `TaskWorkflowSummaryQuery/Page`、`TaskResultHeader/Page`。GET `/api/tasks/:id/workflow/summary` 和 `/workflow/results/:resultId` | `:id` 是根任务 ID。首页返回根及第一页直属任务，展开分支用 `parentTaskId`，`limit/cursor` 为 URL query。Host 校验父项仍在该树内，cursor 绑定根、分支和读取版本；过期提示重读。计数分母随根固定，待验收 ID 指向根当前有效结果。证据页 GET 以 `offset` 查询，按 UTF-16 长度拼接 JSON；读取中核对返回的结果头与版本。旧 REST workflow 和 MCP 的完整/摘要接口照常。 |
| 画布共同需求提示 | `shared-context.ts` 的 `TaskContextHint`、`projectTaskContextHint`，经 `StateSnapshot.tasks` 与 `task.upserted` 的 `Task.contextHint` 传输 | Host 复用有效绑定和匹配回执的校验。卡片沿用原来的两种提示，通过快照和增量合并取得。完整共同需求由任务详情按需读。 |
| 工作树接入 | `PlannedTask.execution`、`TaskWorktreeTarget`、`TaskWorktreeEvidence`、`WorktreeIntegrationInput/Receipt`。GET/POST `/api/tasks/:id/worktree-integrations`、POST `/api/tasks/:id/worktree-integrations/:operationId/review` | `integrateFrom` 引用同一分工的前置键或现有任务 ID。Host 先分配并持久化 checkout ID 才检查首轮门禁。登记绑定 checkout、前置任务及已验收版本；提交 SHA 机械核对，补丁或人工证据按授权验收。重试相同登记返回旧回执，登记接口记录证据，补丁应用由明确的执行操作负责。前置换版重算等待，接入变化随 `task.upserted` 使相关根页刷新。提交方可带 `worktrees`，Host 核对实际会话、目录和基准后记入 `TaskResult`。 |
| Plane 两种模式 | `team-board.ts` 的 `PlaneBotApproval`、`PlaneBotPlanChoice`、`PlaneBotJob`、`PlaneBotWriteback` | 现有 approve/decision 接收选择，省略 `execution` 保持独立模式。带队批准固定操作 ID、计划哈希、基准 SHA 与目标专题意图；计划变化要再批准。旧模式 `taskId` 指向独立执行任务；带队模式用 `rootTaskId`、逐项 `worktrees` 与可选最终集成工作树。旧 `taskId` 为 null，避免旧客户端把只读根当独立 worker。现有 `plane.bot.changed` 可带根 ID。按当前有效且已人工通过的结果 ID 回写并对账。 |

`Task.lead` 是结构标记。`taskManagement`、`managementRoot`、`sameManagementScope` 仍用于树和范围计算，实际管理写权限由 Host 在操作时根据任务、任期、指定会话和有效范围判定。权限来源使用认证后的入口主体，响应中的身份字段用于展示与审计。

第一阶段供跨服务复用的任期接点为 `currentTerm(taskId): BotLeadTerm | null` 与 `assertManagementSession(sessionId, expectedTerm?: BotLeadTermRef): BotLeadTerm`，由 Host 任命任务实现。派工和验收在异步操作前保存任期引用，事务写入前用同一引用复验。自动通知读取现任并发往其绑定会话。匿名旧树在第一阶段保留原入口，统一任务在第二阶段关闭匿名管理写入。获准自动带队的 Webhook 或值守用 Host 内部的 `automation` 来源关联稳定配置和请求 ID。工作树门禁与派工门禁共用检查，人工提前开始的依赖例外仍须有可用的实际输入。

## 画布首屏、单支展开与重连

`packages/ui/src/canvas/useContextHints.ts:25–26` 当前在串行循环中分别请求每个本地活动任务的 `GET /api/tasks/:id/context`。`CanvasPage.tsx` 同时调用它和 `useTaskFlow`，后者每根请求全量 `/workflow`。因此只换 `useTaskFlow` 仍会保留逐卡请求。阶段一 UI 在 `CanvasPage.tsx` 把 `useContextHints(link, tasks)` 换成基于 `tasks` 的纯映射。数据沿 `useHostState.applyEvent → canvas/view.tsx → CanvasPage → TaskCard` 到卡片，沿用现有标签、版本文案、悬浮说明和加载提示。

现有 `contextHint` 的最小输入是显式绑定的 `{id, taskId, contextId, version}`、Host 判定的 `validBinding`，以及任务所属会话中 `{requirementId, taskId, contextId, version, adoptedAt}` 的匹配结果。Host 的 `SharedContextFeature` 复用 `binding/valid/receipts` 与 `projectTaskContextHint`。失效绑定显示「归属待核对」；合法但无匹配采用声明时显示「需求待更新」和绑定版本；无绑定或已声明采用时返回 `null`。发布新版本、排队或送达均不改变此提示的语义。Host 一次取快照的任务、专题和会话，按 ID 复用当前管理路径、任务下会话和根的绑定版本索引，只对有绑定的任务查询所需的版本与回执。完整正文、回执列表、前置交付和根的最新发布版本留在原详情接口。

| 场景 | Host 数据 | UI 加载与刷新 |
|---|---|---|
| 首屏 | 复用已读的 `GET /api/state` 的任务、会话、`Task.contextHint` 与专题 `GET /api/topics/:id/canvas` 的布局和两类关系。每个有效根的 `GET /api/tasks/:id/workflow/summary` 一次返回根与首批直属项及树级计数、当前结果头、待人工验收 ID。旧匿名有效根也走相同摘要协议。 | `useTaskFlow` 在单一资源里并行读取需展示的不同根首页，按根缓存。即使当前布局呈现孙级卡，它也用任务快照先渲染卡片及共同需求提示。交付状态等摘要仍在加载时显示相应等待状态。 |
| 展开一支／打开详情 | 展开请求仍指向原根，用 `parentTaskId` 指定选中分支，后续用 `cursor`，只给这一支相应层级的结果头。打开具体交付时才读 `/workflow/results/:resultId?offset=…`；打开任务共同需求详情才用它的 `/context`。 | 缓存键按根、分支、页；有未失效缓存可直接展开。展现状态、计数和卡片提示无需读取完整交付、正文或历史会话。 |
| 增量与重连 | `HostService.snapshot()` 与 `task.upserted` 为本地活动任务投影同一 `Task.contextHint`。申请绑定、采用沿用 `SharedContextFeature.changed`。转交、归档、迁移或绑定失效时，重算变更前后归属中受影响的任务并发送更新，内容相同时省略额外事件。 | `useHostState` 以新 `/api/state` 替换旧投影，再接 `eventSeq` 后的事件；`useCanvas` 校正布局。`useTaskFlow` 按变更前后归属仅标记相关根，通过同一个重连加载入口刷新根首页和仍展开的分支。合并 link 更新、重连通知和同批事件触发的同页请求，丢弃过期响应和旧 cursor。已折叠页等下一次展开按新范围读取。提示取自任务快照/事件，重连无需另做提示请求。 |
| 非受管卡 | 有效的本地普通卡同样带 `Task.contextHint`。原有绑定即使已因转出管理树失效，仍投影 `invalid-binding`。归档、远程和参考卡沿用原各自的渲染范围。 | 非受管卡直接用快照投影，无需根摘要。新 Host 的 `null` 表示没有提示；老 Host 省略字段时可沿用「共同需求状态暂未加载」，用户打开任务仍可看原详情。 |

Host 接线归阶段一派工任务的 `SharedContextFeature` 投影与受影响范围，及其 `OrchestrationFeature.workflowSummary/readResult`。中央 `HostService.snapshot/publish` 的装配由阶段一任命任务协调；布局写入继续走 `CanvasFeature`。UI 接线归阶段一本地入口任务的 `useTaskFlow`、`useContextHints`、`CanvasPage` 与 `useHostState`。

并行基线 `result-23b5a46a-0c0b-4b2f-b852-24554d38f1fa` 记录 302 卡首屏 311 个 HTTP 请求，其中逐卡 context 302 个；重连 660 个，其中逐卡 context 604 个。实施后按 [同一夹具与采样口径](../../e2e/canvas-performance.md) 比较 50/302 卡的首屏、单支和重连。报告 HTTP/WS、响应体字节与耗时，单列根首页、分支页、交付证据与 `/context`。未主动打开任务详情时三项均应无逐卡 `/context`，根首页请求随展示的树数，展开请求随所选分支页数。对照卡片上的待采用和失效归属提示，以及断线后的坐标和状态校正。

## 现有 lead 写入路径

最终写入集中在 `packages/host/src/store/store.ts` 的 `Store.createTask/updateTask`。以下为现有生产入口及当前授权主体。

| 入口 | 当前授权主体 | 实际调用路径与接线 |
|---|---|---|
| POST `/api/tasks` | 本机 Host 用户凭据 | `tasks/routes.ts → TasksFeature.createTask → createTaskRecord`。UI 新建、QuickStart、草稿及画布新建共用 `submitDraft`。第二阶段在创建与副作用前统一任命门禁。 |
| PATCH `/api/tasks/:id` | 本机 Host 用户凭据 | `tasks/routes.ts → TasksFeature.patchTask → updateTask`。任务页设置或取消主控。第二阶段收口提升、撤销和变更管理关系。 |
| MCP `task_set_lead` | 自己的有效本地任务根主会话，工作台持有写权 | `tasks/lead-promotion.ts` 的 `TaskLeadPromotion.request → watch/flush/advance`，`advance` 可在冷恢复时写 flag。第一阶段复用安定交接；第二阶段旧申请转成待选 Bot，含冷恢复。 |
| MCP `task_plan_propose` | 当前主控自动采用，专题会话提案由人确认 | `taskplans/mcp.ts → TaskPlansFeature.propose → accept → createTaskRecord`。第二阶段把 `lead:true` 项与 Bot 任命同事务写入。 |
| POST `/api/task-plans/:id/accept` | 本机 Host 用户凭据 | `TaskPlansFeature.accept` 会消费分工项或接受编辑的 lead，`ui/src/taskplans/TaskPlans.tsx` 的 `PlanDialog` 原样带回旧 lead。第二阶段包括已排队提案。 |
| POST `/api/team-board/plane/work-items/:id/copy` | 本机 Host 用户凭据，另核对 Plane 来源和账号 | `teamtasks/routes.ts → TeamBoardHost.copyWorkItem → createPersonalWork → TasksFeature.createTask`。`PlanePersonalDraft.lead` 来自原生 Plane 个人副本的新建草稿。第二阶段兼容门禁在对 Plane 指派前执行。 |

上表中的 Host 功能相对 `packages/host/src/features/`。HTTP 的用户凭据检查在 `http/server.ts:startHostServer`。MCP 会话身份由 `mcp/amo-mcp.ts:handleMcpRequest` 及对应运行时注入；`task_update` 白名单只有标题、列和专题，`task_manager_set` 处理管理关系。普通 Bot worker、Bot 主聊天、旧团队看板导入、调度、值守和远程创建的现有生产调用均未传递 lead。历史迁移为旧数据增加默认 flag，从 #43 起保存 Bot 任期。

## 持久存储和公共接线

| 切入点 | 现状与复用 |
|---|---|
| `packages/host/src/store/migrations.ts` #43 | 交接时已有改动 `studio_bot_lead_terms`，包括 task/Bot/session 外键、task+generation 唯一、未结束任期按任务唯一、非空 session 唯一、现任 Bot 索引。存 `snapshot/handoff/started_at/ended_at`，未含承接、来源、启动阶段或历次替代会话映射。后续存储接线保留 #43 和 `store.test.ts` 夹具。Bot 删除当前以墓碑保留 Bot ID。 |
| Bot 常驻聊天、接单 | `features/bots/service.ts:request/requests/openHome/startChat/worker/deliver/recover`，`features/bots/routes.ts`。常驻聊天的 `studio_bots.task_id/home_session_id` 与任期独立；`studio_bot_workers.request_id` 保证旧单动作幂等。用同源承接约束补齐跨动作竞态。 |
| 持久任务与消息 | `store/kv-keys.ts` 的 `tasks.lead-promotions`、`taskplans.pending-starts`、`orchestration.outbox`，以及 `task-results:<taskId>`、`sessions.inbox`、`sessions.inbox.paused`、`sessions.peer-queue`。复用 `TaskLeadPromotion.watch/flush`、`TaskPlansFeature.watch/startReady`、`OrchestrationFeature.prepareInbox/valid/validateMessage/deliver/retry`、`sessions/inbox.ts:put/watch/checkSource`。送达以真实消息为准，处理以回合证据为准。现有按最近 main 选择的管理通知需改为指定任期会话并在发送前复验。 |
| 注册、事务、事件 | `packages/host/src/features/index.ts:FEATURES` 同时供 HTTP routes 和 MCP tools 枚举。新 Feature 同步接 `core/feature.ts:FeatureName/FeatureHost` 和 `service.ts:HostService`，受 `features/feature-deps.test.ts` 检查。复用 `HostService.transaction/publish/snapshot` 的提交后广播、全局 seq 和重连快照。 |
| 错误与页面同步 | `packages/host/src/core/shared.ts:HostError`、`http/server.ts:statusOf/fail`、`packages/ui/src/host/client.ts:call` 当前传 code/message，接入时透传可选 details。`ui/src/host/useHostState.ts:applyEvent` 消费快照和增量；`canvas/useTaskFlow.ts` 当前每根读取整份 workflow，换按根加载摘要和按需证据。 |

## 按方法划分共享文件接线

| 阶段与负责人 | 文件及方法 | 复用和验收接点 |
|---|---|---|
| 一 · Host 接单任命 | `HostService` 实例、初始化、快照和任期恢复，`FEATURES` 新路由，`BotsFeature.worker` 与任命共用来源仲裁，`TasksFeature.trackSessionStart/startPreparedSession/ensureMainSession`，`TaskLeadPromotion` 的安定交接 | 事务先保存正式卡、任期和启动意图，提交后启动。角色和运行时先支持已任命树，保留已有匿名树的阶段二切换步骤。 |
| 一 · Host 接单任命 | `core/role.ts:subjectFacts/leadsTopic/managesTask`，`mcp/tools.ts:amoToolsFor/isLeadCaller/keepLeadReadOnly`，`mcp/amo-mcp.ts:createAmoMcpServer`，`mcp/tool-kit.ts:inOwnTopic`，`SessionsFeature.sendMessage/fork/terminal` 与 Codex、Claude、DSH 的本地只读门禁 | 区分角色发现、真实管理写权限和任务级只读上限。fork/sub/terminal、被替代的主会话与旧 MCP 调用均须在实际执行边界复验。 |
| 一 · 派工、逐层验收与画布 | `TaskPlansFeature.propose/accept/startReady/waitingFor/waitingMap/checkPersonStart/checkDispatch`；`OrchestrationFeature.workflowSummary/readResult/resultHeader/submit/review/reviewByUser/answerDecision/deliver`；`SharedContextFeature.setPrerequisites/assertStartable/captureBasis/isResultCurrent` | 分工事务复用 `operationId/requestKey`、共同需求、启动队列与前置结果。摘要的结果头略去 `worktrees`，保留当前性和 ID。REST、MCP 都复用现有直属验收、根人工验收和版本检查。`HostService` 的 `router.setMessageContext`、`sessions.inbox.validateProducerMessage` 由派工和任命负责人对接各自的门禁和通知回调；`RuntimeRouter` 首次、发送、重发及 Goal 入口复用这两条接线。 |
| 一 · 派工、逐层验收与画布 | 工作树接入三个 handler，接入回执和前置结果失效复查，`TaskPlansFeature` 启动门禁 | 本地与 Plane 共用工作树接入协议。派工负责人负责领域逻辑和测试，阶段一若需数据库结构变更由 Host 任命负责人统一注册。 |
| 一 · 派工、逐层验收与画布 | `CanvasFeature.saveCanvas/mutateCanvas/setTaskOnCanvas/ensureManagementCards/layoutNewManagedCards` | 整图 PUT、单卡、批量和撤销走相同完整性条件，复用 `CanvasDoc.version` 和正式 `kind:"task"`。依赖 `from` 为前置、`to` 为后项；管理等待方向用子项到主控，合图查环并返回具体路径。 |
| 一 · 本地接单 UI | `ui/src/bots/BotRequests.tsx`、`bots/view.tsx:startWorker`、`task/Thread.tsx:useBotRequests`、`chat/Transcript.tsx:BotReply`、`canvas/CanvasPage.tsx`、`canvas/useTaskFlow.ts`、`task/TaskWorkflow.tsx`、`shell/WorkbenchShortcuts.tsx:pendingItems` | 原对话用任务/专题 ID 定位，接续、归档、断线读取同一 Host 快照。Focus、Bot、画布复用原决策、交付、原生审批 ID。隔离验收用独立数据和端口验证跨入口。 |
| 二 · 统一任命、换任与迁移 | `TasksFeature.createTask/createTaskRecord/patchTask/updateTask/setManager/checkManager`，`TaskLeadPromotion.request/advance`，`TaskPlansFeature.propose/accept` 的中控分支，`CanvasFeature.leaveCanvas/joinCanvas` 的迁移直写 | 在第一阶段方法上接旧客户端许可、旧队列和 legacy 绑定，跨树转交复核上级、后代和 Bot 防自审。与派工负责人合入分工方法；与 Plane 负责人对齐个人副本入口。 |
| 二 · 统一任命、换任与迁移 | `BotsFeature.save/patch/remove` 与全局设置，`RelaysFeature.send/deliverOnce`，任期控制接口与旧 tool guard 的强制切换 | 将旧写入和重放收口后开启强制规则。Bot 删除先检查现任任务，停用与暂停后仍保存下级结果。旧匿名根的已提交有效结果仍可人工验收。 |
| 三 · Plane 新旧模式 | `PlaneBotJobs.approve/decideForBot/approveJob/advance/resumeJobs/startWorker/publish/view`；`store/plane-bot.ts:planeBotWorkspaceId/isPlaneBotWorker/planeBotWorkerSession/inPlaneBotWorktree`；`TeamBoardHost.postPlaneBotResult`；`Store.purge` | 复用原 approve/decision 和旧工作树。扩展关联存储区分独立 worker 与专属根，按结果 ID 保存回写历史。复用原单账号校验、扩展留言或原生评论对账。沿第一阶段的 `TasksFeature.startPreparedSession`、`OrchestrationFeature.humanReviewable/reviewResult` 接工作树与根结果校验，交叉方法与原负责人合入。UI 复用 `PlaneBot.tsx` 和 `PlaneBotConversation.tsx`。 |

工作树创建已有 `features/sessions/fork-worktree.ts:createForkWorktree`，固定批准 SHA 时可复用其 detached 路径。现有 `inPlaneBotWorktree` 只校验目录字段、任务与项目，批准基准、实际 Git 接入和回写当前性仍由阶段三对应入口验证。源码取证时基线为 `feat/studio-bots` 的 `fb3bea7`，另有共享工作区中的 #43。

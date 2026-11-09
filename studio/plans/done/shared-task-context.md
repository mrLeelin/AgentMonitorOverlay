# 共同需求与任务上下文

状态：做完（2026-11-09：后台、界面及隔离集成验证完成；未提交、发布或加载用户 Host，交主控与独立验收任务复核）。

## 用户决定（2026-11-09）

- 用户只向主控说目标。已授权范围内，主控自行整理、维护、发布共同需求及选择受影响任务，不增加用户逐条确认、写摘要、选版本或点击已读的日常步骤。
- 共同需求明确属于一张管理树的根主控；具体任务必须显式绑定。同专题、画布分组、引用或普通连线不授予共同需求或管理权限。普通专题文档仍由 `topicdocs` 管理，不强制版本化。
- 草稿可编辑，已发布版本保留完整正文、变更说明、来源及性质，发布后不可修改。发布与任务升级是两个动作；回退通过新版本表达，完成的历史任务保留原依据。
- 排队、送入会话、执行者声明采用是三个事实。排队任务固定显式要求版本，不能启动时自动跟随最新发布版。停止会话不因共同需求更新自动唤醒。
- 交付继续保留摘要和验证证据，同时记录实际需求版本和具体前置 resultId。错版可以保存，接受前必须处理差异；事务内重核，依赖启动不能仅看 `done`。
- 旧未绑定任务不猜版本，保持现有入口和交付行为。不增加全聊天广播、向量检索、自动全树失效、文件写权限或部署步骤。

## 数据与权限

`packages/protocol/src/shared-context.ts` 是前后端共用契约；`features/sharedcontext` 隔离版本、绑定、采用和依据判断。全部数据保存于当前 Studio 数据目录的 `studio.db` 的既有 KV 表，不另设程序目录数据。四个键前缀已登记在 `store/kv-keys.ts`，随所属任务或会话彻底删除：

| 前缀 | 所属 | 内容 |
|---|---|---|
| `shared-context:<rootTaskId>` | 管理根任务 | 一份草稿、revision、currentVersion、不可变 versions |
| `context-binding:<taskId>` | 具体任务 | contextId/version、requirement id、完整管理路径、失效时间、操作人及时间 |
| `context-receipts:<sessionId>` | 会话 | 按 requirement id 区分的 queuedAt / deliveredAt / adoptedAt |
| `context-prerequisites:<taskId>` | 具体任务 | 本次启动固定的前置 resultId |

根主控本地主会话可写自己管理根的共同需求；领域主控可以将根的已发布版本明确应用于自己和受管下级，不得改整棵树的根需求。执行者及 fork 可以读取自己的绑定并声明采用，不能维护或发布。未分配旧任务可以读取“未绑定”；无 AMO 身份的工具调用不具有写权限。

绑定保存管理路径及授权来源 `appliedByTaskId/appliedBySessionId`；派发时重新核对来源任务仍为该路径中的有效主控，不依赖 `relayFromSessionId` 是否存在。转交、解除归属、根变化或归档导致旧绑定永久失效。转交回原树也不复活旧通知，必须重新显式绑定。根主控可选择只应用一部分任务；发布从不自动修改其他绑定。根主控自己的交付如需版本依据，也显式将自己的任务包含在 apply 中。

## HTTP 与 MCP 契约（供界面接入）

HTTP 写操作均带当前 `sessionId`，后台重新检查实际角色和范围，不以客户端提供的 root 声明授权。UI 通过现有专题文档入口展示此独立数据，不把所有 `TopicDoc` 转成发布版本。

| HTTP | MCP | 请求与结果 |
|---|---|---|
| `GET /api/tasks/:id/context` | `context_get({taskId?})` | 返回 `SharedContextView`：`context`、`binding`、`validBinding`、全部任务会话 `receipts`、`prerequisiteResultIds`。MCP 省略 taskId 为自己；指定时只能自己或受管下级。MCP 读取自己完整正文会记录 delivered，不记录 adopted；HTTP 读界面不改变执行者采用状态。 |
| `POST /api/shared-context/save` | `context_save` | `{rootTaskId,baseRevision,title,body,changeNote,sources:[{kind,source}]}` → `SharedContext`。新建 baseRevision=0；正文最多100000字，标题200字，说明10000字。kind 为 `user_requirement` / `lead_agreement` / `suggestion`。 |
| `POST /api/shared-context/publish` | `context_publish` | `{contextId,baseRevision}` → `SharedContext`。检查当前 revision，冲突返回409；每次发布完整新版本，递增 revision/currentVersion。 |
| `POST /api/shared-context/apply` | `context_apply` | `{contextId,version,taskIds}` → `TaskContextBinding[]`。最多200项，原子检查；重复同版本有效绑定返回同 requirement id；已完成任务需先明确重新开始。 |
| `POST /api/shared-context/adopt` | `context_adopt` | `{contextId,version}` → 当前会话 `ContextReceipt`。必须先收到或读取完整正文，版本须等于当前有效任务要求。重复采用幂等。 |

`SharedContext` 含 `id/rootTaskId/title/revision/draft/currentVersion/versions`。`versions[]` 含 `version/body/changeNote/sources/publishedAt/publishedBySessionId`。`binding` 为 null 表示未绑定；有绑定但 `validBinding=false` 表示归属已失效。`receipt` 保存 `taskId/rootTaskId/sessionId`、不可变版本与 requirement id；三个时间字段独立，不把 queuedAt 当 deliveredAt，也不把 deliveredAt 当 adoptedAt。首次送达及采用变化发布 `task.upserted`，界面据此重读 GET；排队条目本身沿用 item 事件。

交付及派工复用原接口：

- `PlannedTask.contextBasis?: {contextId,version}`；`task_plan_propose` 每项可明确指定。创建任务后、排队前即绑定，保持版本冻结。
- `task_submit_result` / `POST /api/tasks/:id/workflow/submit` 增加 `contextBasis?` 和 `prerequisiteResultIds?`。省略版本时优先本会话已采用的当前绑定记录，否则按明确 adoptedAt 时间选择最新采用记录，不依赖数组顺序，绝不猜 latest；省略前置时采用真实启动快照。
- `TaskResult` 新增上述实际依据、`contextMismatch?:string`、`contextResolution?:{explanation,requiredBasis?}`。待处理差异依然保存在 submitted，不丢成果。旧成果无新增字段完全可读。
- `task_review_result` / `POST /api/tasks/:id/workflow/review` 增加 `contextExplanation?`。真实且已提供版本存在版本或采用差异时，主控可退回更新，或先 apply 明确调整要求，或填写差异不影响接受的具体说明。实际旧依据始终保留，不改写为新版本。不存在、从未向该交付任务/会话提供、跨树的版本及已绑定却缺少实际版本依据均不可豁免；失效归属、缺失真实 resultId、非当前 accepted 前置也不能以说明绕过。成果可保存在 submitted 等待补正。
- 根主控正常依据的最终提交保持自动 accepted；根自身有差异时保存为 submitted，根主控可通过同一 review 工具在当前运行回合内明确处理自身结果，只排除当前调用会话，其他同任务运行会话仍阻止接受。写事务内再次检查活动会话；当前回合结束不会撤销刚接受的结果，之后另开新工作回合仍按原规则重新开始。

## 会话组装与通知

`RuntimeRouter.setMessageContext` 接入 Host 统一组装，覆盖 Codex、Claude、DSH 首次输入、恢复后的下一次消息、普通发送、收件箱和重发。角色卡和具体任务原链路保留。首次或任务绑定升级后尚未完整送达的版本提供完整正文、来源性质、变更说明、具体任务要求和前置 resultId；本会话当前绑定版本已有完整送达记录后，后续回合和新入箱消息只附轻量引用（contextId/version/rootTaskId/taskId、前置 resultId、采用状态及 `context_get` 入口），不再反复注入正文、来源和任务说明。恢复或忘记细节时，执行者用 `context_get` 重新读取完整正文；该工具返回完整版本，并直接按完整数据记录 provided/delivered，不经过可能已选择轻量引用的自动注入入口。轻量引用自身不新增正文提供、送达或采用记录。

业务正文、标题、来源、任务说明以 JSON 数据传入，明确不提高指令优先级、不改变角色或主控/工具权限；正文包含伪造标记也只作为数据字符串。选择完整或轻量是在入箱/发送时进行，已经排队的完整正文保持冻结，不因后来成功送达而改写。发布新版本不变其绑定；显式升级会提供新版本完整正文，旧 token 消息仍拒送，需按当前主控要求重发。

每份绑定使用稳定 token `[AMO_SHARED_CONTEXT:<requirementId>]`，每个会话通知 id 为 `i-context-<requirementId>-<sessionId>`。绑定本身就是持久待通知来源，无会话时不创建会话唤醒。通知进入原 SessionInbox 的 held 行，跨重建去重；排队过程中又 apply 新要求会在当前 put 结束后补排新 id。实际派发前再次检查 token 和当前归属，普通消息携带旧 token 时同样拒送。

收件箱的用户停止状态保存为 `sessions.inbox.paused`，重建 Host 后仍暂停，等人继续或显式立即发送。首次会话的初始文本由 Router 注入，创建过程不另外抢跑一个通知回合。

Codex 冷恢复先加载线程再允许发送：连接 ready 时启动的 resubscribe 与 `handleFor` 共享同一个按 RPC 连接保存的恢复 Promise。首次用户继续及收件箱派发等待该 Promise 完成，避免第二个持久线程尚未 resume 就 turn/start 报 thread not found；不靠延长等待时间、重试用户消息或丢弃通知。确定性回归以受控 resume 响应验证发送不能提前越过恢复，再由独立 C 的真实 app-server 隔离 Host 重建流程验证首次继续成功。

送达是传输证据，不是理解：Codex 以用户消息回显记录；Claude 以消息生命周期确认，旧 CLI 无该能力时以进程就绪后的输入入队记录；DSH 以 ACP prompt 派发记录。记录送达前核对当前有效 token 及完整规范版本 JSON，只给 token 不算提供过版本。失败的 enqueue 不算送达，三者都只有 `context_adopt` 才算该任务/会话声明采用；Host 验证版本存在和确实提供过，不声称证明模型理解。

## 验收与依赖有效性

review 写事务内重读最新成果、当前直属归属、任务版本、采用记录和前置结果。实际依据不符时无说明不能接受；说明记录当时明确要求版本，后续版本升级不会让旧说明无限通行。

派工队列还保存根主控快照；跨树转交后的旧排队永久撤销。自动启动检查真实 accepted、最新 resultId、当前归属和版本。已绑定任务的手动启动、恢复发送和重发也由 Router 检查，不能绕过调度器。有效前置递归核对其依据；已重新开始、换成果、换归属或错版的前置阻止继续。没有绑定的旧任务继续原有入口行为。

## 界面与日常使用

`ui/src/task/TaskContext.tsx` 在任务标题区提供可选的「共同需求」入口。执行任务显示明确要求版本、历史采用版本、当前绑定的排队/送入/声明采用状态及完整正文；HTTP 查看不写采用记录。未绑定任务明示未绑定，失效归属保留原记录并交当前主控重新明确。普通用户继续只在主控会话说目标，不需要进入这个面板。

根主控面板可查看发布历史、来源性质和明确管理范围内的任务采用情况；可选高级编辑使用实际本地主会话身份，保存草稿、发布、勾选任务应用分别调用既有接口。编辑保存固定 baseRevision，收到外部修改时保留本地未保存正文并阻止旧稿直接发布，明确重新读取后合并。已完成任务不列入应用候选，执行任务没有编辑和代点采用入口。

`TaskWorkflow` 同时显示实际交付版本和当前任务要求，具体前置 resultId 可展开；差异、主控解释和解释对照版本随记录展示。历史交付依据不因新版发布改写，界面没有跳过后端版本检查直接完成任务的入口。画布仅在原状态行提示「需求待更新」或「归属待核对」，不增加共享连线，也不依据专题、引用或最新发布版猜测要求。

## 验证边界

后台测试使用临时 SQLite 和模拟运行时；三运行时适配器验证使用 fake Codex app-server、本地 mock Anthropic 和 scripted ACP，不调用真实模型，不操作实时任务。覆盖发布冲突/版本不变、显式范围、排队冻结、送达与采用分离、跨会话去重、持久暂停、排队升级竞态、错版保存/显式接受、验收事务竞态、依赖依据及旧任务/fork兼容。轻量策略在三个运行时入口分别验证：100000字首次正文，送达后多轮发送及新入箱不含正文、无前置时引用不足1000字符；旧排队完整文本不改写；发布不升级，明确升级通知带新全文；把轻量引用送给另一个会话不能提供或采用版本，`context_get` 才返回并记录真实完整正文。

界面完整集成测试在 `e2e/studio/shared-context.spec.ts`：真实 mock MCP 派工、首次提供及声明采用；排队 v1 不跟随 v2 发布；主控显式升级任务，旧版前置即使 done/accepted 仍阻止继续，明确重新开始前置并验收新版后固定新的 resultId；旧版成果保留且不可无声接受，退回后正确 v2 交付验收；未绑定旧任务兼容；可选高级编辑保存、发布、指定任务与外部草稿冲突保留。界面截图通过隔离 Electron 的真实渲染捕获，覆盖浅色/深色更新状态、画布提示、旧版差异、正确接受、发布历史、未绑定和编辑冲突，路径为 `screenshots/studio/shared-context-*.png`。

验证命令：`npm run typecheck`；`npm run build`；`npx playwright test -c e2e/playwright.config.ts --project=studio shared-context.spec.ts --workers=1`；Host 共同需求/交付/派工/会话/管理树及画布/nav 的定向 Vitest 回归（`--maxWorkers=4`）。均用 BelowNormal 优先级、临时数据和模拟运行时，不调用真实模型。跨运行时另用 fake Codex app-server、本地 mock Anthropic 和 scripted ACP 核对首次/继续/恢复发送、正文/轻量引用及实际送达。

用户正在使用的 Host 不自动重启。源码、隔离模拟传输及真实界面截图不代表用户当前窗口已加载，也不证明真实模型理解；本轮未跑全部项目的 e2e 或全仓 verify，发布和实际 Host 加载留给用户既有流程。

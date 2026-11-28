# 交接：AMO 的当前状态

新会话先读这份。长期有效的规则在仓库根目录的 `AGENTS.md`；这里只写**现在**的状态和还开着的事，不记改动流水（2026-11-06 用户定）：改了什么看 `git log` 和各包 `CHANGELOG.md`。做完一段，只改下面受影响的行（状态变了、事做完了就删掉那一行、新开的事加一行）。

找功能在哪：`node scripts/nav.mjs --query 关键词`（导航索引，`docs/nav/`）。查某个功能当初为什么这么做：先看 `plans/` 里对应方案开头的状态和正文的决定，再在 `docs/history/`（11-06 之前的交接记录：`handoff-2026-10.md`、`handoff-2026-10-late.md`、`handoff-2026-11.md`）、`plans/done/`、`docs/archive/`（/loop 时期）里搜。文档怎么分层见 `plans/doc-architecture.md`。

## 在哪、怎么跑

| 项目 | 内容 |
|---|---|
| 开发目录 | `G:\PROJECT\AgentMonitorOverlay\studio`（桌面快捷方式「AMO Source」指这里的 `start-studio.cmd`） |
| 分支 | `master` 是主线；旧版 AMO 在标签 `amo-legacy-final` |
| 常设 worktree | 都是 master 的 detached worktree：值守目录 `G:\PROJECT\AgentMonitorOverlay-duty`（值守修问题、`release land`）、打包目录 `G:\PROJECT\AgentMonitorOverlay-release`（自动打包跑 `release auto --if-due`）。别的 worktree 是各任务自己的（`git worktree list` 看） |
| 用户在用的 Studio | 平台装的版本（`D:\TOOLS\AMO Platform\apps\studio\<版本>`），不是这个开发目录：在这里改代码、build 都不影响它；提交进 master 且写了「下一版」的会被自动打包发到测试通道，用户自己选装 |
| 开发版 | `npm start`（先 build 再开窗口），数据在 `studio\.data`。Host 常驻在 47900 端口；改了 Host 代码要先 `npm run host:stop` 再 `npm start` |
| 帮用户重启开发版 | **先问用户，而且只在没有会话运行时做**。`npm run build` → `npm run host:stop` → 结束 `electron.exe packages/app` 主进程（命令行不含 `--type=`）→ 备份 `.data\studio.db*` 到 `.data\backup-before-<名字>-<日期>` → 在 PowerShell 里先删掉匹配 `^(CLAUDE|ANTHROPIC_|AMO_STUDIO_|NO_COLOR$|FORCE_COLOR$|COLOR$|TERM$)` 的环境变量（Claude Code 工具 shell 带的，Studio 会传给维护终端）→ `Start-Process node_modules\electron\dist\electron.exe packages/app`（工作目录 `studio`）→ 用 `.data/host-token` 在 node 脚本里查 `GET /api/state` 核对任务和会话数（不打印令牌）。只改界面时让用户按 Ctrl+R 即可 |
| 验证 | `npm run verify`（typecheck + vitest + build）；`npm run e2e`（Playwright project：`studio`、`notes`、`reviewer`、`relay`、`platform`）。都用 BelowNormal 优先级、`--maxWorkers=6` |
| 发布 | 都走 `npm run release`（用法在 `scripts/release.mjs` 开头，节奏见 `plans/release.md`）。自动打包每 60 秒跑 `release auto --if-due`，只发「下一版」里有条目的工具。各工具现在的版本：`npm run release -- status` |
| AMO 中转 | 服务在 Mac mini `http://172.16.8.85:47120/`（SSH 别名 `mac`）。部署：`npm run release -- relay-service`（会重启中转几秒，先问用户）；底层命令和服务器上的位置见 `packages/relay/README.md` |

## 规则补充（`AGENTS.md` 之外的细节）

- 不改 `~/.codex/config.toml`、`~/.claude/` 设置、用户已有的凭据条目（Studio 只写用户在 设置 → 模型 加渠道时的 `channel-<id>` / `channel-<id>-access`）。
- 测试只在 `%TEMP%\amo-studio-sandbox\` 和临时目录；端口只用 47900–47999；测试窗口不抢焦点、不开终端/浏览器、不碰剪贴板。
- 不 reset --hard、不删分支。密钥不打印、不写日志/文件/命令行。
- **真实模型额度**（`budget.json`，用 `spikes/lib.mjs` 的 `countTurn(note, provider)` 先计数再调用，以文件为准）。平时测试用 mock。
- 工具坑：heredoc 里的 Python 会吃掉 `\n`、`\v` 等转义 → 有转义的改动用 Edit/Write 或 scratchpad 里的 `.py` 文件；Windows 文件名不分大小写（`Transcript.tsx` 和 `transcript.ts` 会撞）；跑完 e2e 用 `git checkout -- studio/screenshots/` 丢掉无意的截图变化；清理 `%TEMP%\amo-studio-test-*`、`amo-studio-e2e-*`。

## 还开着的事

- Orca Bots 迁移在 `feat/studio-bots`。本机 Bot、头像、主聊天与 `@` 路由、群组、值守、独立工作树和通用 Webhook 已接入。单个 Bot 的分区设置、独立资料目录、巡视和记忆整理已接入。群聊支持近期同群记录及 Bot 代用户向群成员提问。第三方连接器、移动端和跨设备 Bot 尚待补齐。见 `plans/studio-bots.md`。

- 机器人带队已接入源码版。本地可从 Bot 原对话、专题画布或任务任命，旧树从原主控卡选「绑定机器人」。等待当前工作区会话空闲后，由人双击本工作区根目录 `restart-amo.bat` 构建并加载 Host 和界面。脚本使用 `studio/.data`，先检查运行会话，关闭后备份数据库再升级。方案见 `plans/bot-topic-leads.md`。
- Plane 团队任务在 Studio 右侧工作区加载原生看板，支持创建个人任务和只读 MCP 核对原单。「高级设置 → 功能开关」可隐藏入口。新单在 Bot 计划确认中可选独立执行或机器人带队，带队工单有专属根，按根人工验收后回写原单。源码版同上手动加载，数据库迁移到第 45 版。真实测试单的接单、工作树证据与远端评论回执仍待业务验收。方案 `plans/done/plane-team-tasks.md`、`plans/studio-bots.md`、`plans/done/bot-work-loop.md`。
- Studio 接入 Unity 方案待确认：首版在会话点击 `@Prefab`，打开对应工程并选中资源。方案见 `plans/studio-unity-connection.md`。

- 画布点击与拖动已分开：未选中的卡片可直接拖动，详情只在点击松手后打开，拖完不再弹出；3 条新手势用例及既有框选、多选、平移、连线与详情流程共 12 条隔离 Electron 回归通过，类型检查、构建通过，已检查 `screenshots/studio/canvas-gestures-{drag,drag-dark,click}.png`。扩展检查的旧尺寸用例仍期待旧卡片高度（152，实际 178），已用原始画布代码确认同样失败，本次未改。刷新源码版窗口即可加载；未提交、发布或重启当前 Studio/Host。

- 设置 → 工具与自动化新增「技能展览」：全局/项目按来源浏览，支持搜索、诊断筛选、刷新、查看真实 SKILL.md 和打开目录；发现页提供 Git 仓库、ClawHub、skills.sh 外部入口，暂不提供安装/启停/删除。类型检查、构建、24 条定向测试及 5 条隔离 Electron 用例通过，已检查深浅主题和窄窗口截图 `screenshots/studio/skills-*.png`。方案 `plans/done/skills-exhibition.md`。未提交、发布或重启当前 Studio/Host；需会话空闲后由用户手动重启源码版加载目录接口。

- 主控沟通（2026-11-17，起因是 Free 专题主控卡在「等待回答」）：卡死已修，主控也少被叫醒（下级留言送进直属主控；主控自己引起的重开、和待决问题重复的本轮状态不再叫醒它；需求含义问到人）；直属主控的工作传话和决定答复直接插进下级正在跑的 Codex 回合（`plans/done/lead-instructions-mid-turn.md`）。主控精简全树核对、单份交付分页和集中取证约定已接入并重启加载，R2 复杂依赖与分层验收实测已完成。待实施：`plans/topic-task-default-lead.md`（专题里新建任务默认归主控 / 交给主控安排，用户已定；界面部分等 Goal 改动提交后再做）。

- 任务依赖已接入：画布线拦自动启动和主控新派工，人可确认提前开始，等待提示在看板、任务页和画布同步；拆任务可依赖同专题已有任务。跨主控树依赖统一启动、交付和递归验收规则，前置重开重验可继续流转；共同需求和管理权限边界保留。方案 `plans/done/task-dependencies.md`，导航「任务依赖」。已通过隔离单测及隐藏 Electron 的跨主控前置→中控链式子任务→逐层交付→用户验收，截图 `screenshots/studio/managed-dependencies-reviewed.png`。已提交，未发布或重启当前 Host，需人在空闲时手动重启加载。

- 新建任务页已增加 Goal 开关：第一句话直接作为 Codex、Claude、DSH 原生目标启动，按模型显示预算；支持草稿恢复、失败后沿用已建会话重试及画布放卡恢复。Goal 直接启动暂不带图片，文件引用可用。25 条定向单测/导航检查、类型检查、构建及 6 条隔离 mock Electron 回归通过，已检查深浅主题、窄窗口和失败恢复截图 `screenshots/studio/newtask-goal-*.png`。仅前端修改，源码版刷新窗口可加载入口；已提交，未发布或重启用户 Studio/Host。

- Goal 目标输入已接入 `@` 任务/会话/项目/文件引用及提示词模板、`/` 和 `$` 菜单补全与技能高亮；引用以真实 ID/路径传入目标，写入失败保留草稿和引用，填写时不执行命令。27 条单测/导航检查、类型检查、构建与 13 条隔离 Electron 用例通过，新增 2 条输入用例重复通过；已检查深浅主题及窄窗口截图 `screenshots/studio/goal-input-*.png`。仅前端修复，源码版刷新窗口可加载；已提交，未发布或重启用户 Studio/Host。

- Codex、Claude、DSH 原生 Goal 已接入底栏 MCP 右侧，按能力显示目标、预算/续跑轮数和状态；支持暂停/继续/清除、停止和归档联动。受管 Goal 开工前真实送达冻结共同需求，核对轮只读且不计原生预算；DSH 可写会话先用普通工作消息提供完整需求。Claude 冷恢复不残留虚假 active，暂停不再被状态读取抢占；Codex 子 agent 不独立控制 Goal，父任务归档正常。本轮 453 条定向测试通过、1 条 DSH 原生集成按开关跳过，类型检查、构建及 19 条隔离 Electron 回归通过，Claude 暂停最后修正后另单例复测通过；已检查 `screenshots/studio/managed-dependencies-reviewed.png`。方案 `plans/done/codex-goal-bar.md`、`plans/done/agent-goals.md`。已提交，未发布或重启当前 Host，需人在空闲时手动重启加载。

- 看板任务卡、画布任务卡及引用卡已显示具体型号，运行/等待中的主会话优先，多主会话汇总并提供悬浮列表，型号切换随会话事件更新；共享卡片高度和旧尺寸排布已同步。58 条定向单测/导航检查、类型检查、构建及 2 条隔离 mock Electron 回归通过，已检查深浅主题截图 `screenshots/studio/task-models-{board,canvas}-{dark,light}.png`。刷新源码版窗口可加载标签；自动排布使用的新尺寸需会话空闲后由用户手动重启 Host 加载。已提交，未发布或重启当前 Host。

- 主控进入待审阅保留下辖检查：整棵管理树全部提交交付或完成且停止实际工作后才流转。总主控自身普通追问、通知及回合收尾保留交付；人工验收后可在待审阅与完成间拖动，相同交付重试保持原验收，原始人工审核另行留存。明确重开、下级实际工作、新增或转交及依赖失效继续生效，AI 不能自审。130 条定向单测/导航检查、类型检查、构建及 6 条隔离 Electron 回归通过，已检查 `screenshots/studio/root-completion-{followup,drag-dark,drag-light}.png`。本轮修复未提交、发布或重启当前 Host，需会话空闲后由用户手动重启源码版加载；不自动恢复历史已失效交付。

- 任务栏待处理角标已实现：主窗口按 Focus 相同口径持续统计，Windows 原生数字角标在处理后清除，Focus 关闭仍更新，超过 99 显示 99+。类型检查、构建、16 条定向单测/导航检查及 2 条隔离 Electron 用例通过，已检查实际传给 Electron 的角标图片预览 `screenshots/studio/taskbar-badge-raster-preview.png`；隔离窗口隐藏，未验收真实桌面任务栏显示。当前 Studio 未重启，需下次重新打开 Studio 外壳加载，Host 无改动；已提交，未发布。

- 数据管理「全部删除」已完成：位于筛选栏右侧，确认后跨类型整批删除归档条目，合并依赖检查并复用事务及附件清理。旧 Host 缺少新接口时兼容逐项删除，依赖阻挡的条目暂缓、删除下级后重试，无法继续时显示已删除/未处理数量，刷新窗口即可加载兼容逻辑；新版整批接口仍需空闲后手动重启 Host。24 条数据管理单测、3 条导航检查、原有删除回归及 4 条批量删除隔离 Electron 用例（含三级管理关系和无法解除的依赖）、类型检查与构建通过，已检查深浅主题及旧 Host 确认框截图 `screenshots/studio/data-delete-all-*.png`。未提交或发布。

- 输入框 `/` 与 `$`：会话和新建任务第一句话均支持菜单及完整技能引用高亮，点击在查看器打开真实 `SKILL.md`；按模型和项目读取，保留原文、光标、删除与撤销，恢复草稿同样生效。首句只补全，Codex 随消息附原生技能输入，后台上下文不当作用户选择。定向单测、13 条隔离 Electron 用例、类型检查和构建通过，截图 `screenshots/studio/skill-reference-{draft,chat}-{dark,light}.png`，方案 `plans/done/composer-command-skills.md`。未加载当前用户 Host，需在会话空闲后手动重启源码版，未提交或发布。DSH 启动前受原生动态列表限制；Claude 路径不明确时提示，避免打开同名错误文件。

- 新建任务页底部操作行：开始在左侧，新增「提示词模板」直接打开并在光标处插入，「放进待办」在右下角。类型检查、构建、3 条隔离 Electron 用例及 3 条导航检查通过，已检查深浅主题和窄窗口截图 `screenshots/studio/newtask-actions-*.png`。源码版刷新窗口即可加载，未重启 Host，未提交或发布。

- 设置新增「提示词模板」统一管理全局与各项目模板，复用 @ 弹窗的编辑器；修正设置搜索抢焦点及模板编辑延迟聚焦。类型检查、构建、3 条导航检查和 3 条隔离 Electron 用例通过，已检查深浅主题与小尺寸截图 `screenshots/studio/prompt-template-settings-*.png`。源码版刷新窗口即可加载，未重启 Host，未提交或发布。

- 设置导航已整理为五类二级折叠菜单：单组展开、页面和展开状态记忆，跨分类搜索并在清空后恢复位置，支持方向键、Home/End 和 Esc；原页面 id 与外部快捷入口保留。类型检查、构建、3 条导航检查和 13 条隔离 Electron 测试通过，已检查深浅主题与小尺寸截图 `screenshots/studio/settings-groups-*.png`；方案 `plans/done/settings-navigation-groups.md`。源码版刷新窗口即可加载，未重启 Host，未提交或发布。

- DSH「Internal error」已定位为旧 `figmaMcpRelay` HTTP MCP 返回 410（服务已改用 CLI/WebSocket）；当前 Studio 已关闭该失效 MCP，真实 DSH 使用已保存 Key 回复 OK，诊断会话已归档，无需重启。源码补充具体 MCP 失败名称和操作提示，51 条相关测试及类型检查通过，待正常重启 Host 后加载；未提交或发布。

- Focus 顶栏「需要你」已可点击，在工作台打开第一个待处理项；复用机器人跳转，收起和点击穿透均可用。前端类型检查、构建及轻量浏览器验证通过（两个待处理项的首项选择、收起、穿透、非拖动区域），已检查 `screenshots/studio/focus-needs-{dark,light}.png`。完整类型检查和隔离 Electron 验证受当前系统内存不足阻止；现有 Electron 回归用例已调整，待空闲复测。未重启当前 Studio，未提交或发布。

- 子会话设置已按选定的 A 版改为渠道、型号列表和编辑器分栏，支持搜索、配置状态、Fast 三态、恢复默认与清除；保留旧型号配置和 Pi 限制，连续保存与失败恢复已验证。类型检查、构建、19 条相关单测、3 条导航检查及 5 条隔离 Electron 测试通过，深浅主题截图 `screenshots/studio/subsession-layout-a-*.png`；方案 `plans/done/subsession-settings-layout.md`。源码版刷新窗口即可加载，未重启 Host，未提交或发布。

- 维护页 CLI 更新列表：Claude Code / Codex / Pi 的版本检测、逐项后台更新、进度和失败重试已完成，按实际安装位置更新并复核版本；Pi 复用运行时定位，按实际 npm 包名和 prefix 更新，不切换安装包。安装器超时清理仅本次进程树。类型检查、构建、35 条维护与 Pi 定向单测、3 条导航检查及 4 条 CLI 列表隔离 Electron 测试通过，深浅主题及 Pi 更新结果截图 `screenshots/studio/cli-updates-*.png`。未实际升级本机 CLI，未提交、发布或重启当前 Host；待人在空闲时重启加载。

- Claude 运行中人物：已按确认的预览接入橙发八帧跑步动画，看板、画布任务卡与引用卡共用，其他模型保留原版；类型检查、15 条相关单测、构建和 2 条隔离 Electron 测试通过，截图 `screenshots/studio/claude-runner-*.png`。只需刷新当前窗口加载，未重启 Host，未提交或发布。

- Pi 已接入：本机 RPC、模型设置、消息与图片、工具结果、问答、排队/停止/恢复及 AMO MCP；仅完全访问，不能作为只读主控。方案 `plans/done/pi-runtime.md`；定向测试、类型检查、构建和隔离 Electron 验证通过，截图 `screenshots/studio/pi-*.png`。11-11 修复 `pi-mcp-adapter` 替换内置连接器导致启动失败，已用本机 Pi 离线验证适配器和原生 MCP 连接。未提交、发布或重启当前 Host，待人在空闲时重启加载。
- 看板待审阅「未查看」提示：卡片橙黄色标签与左侧细色边，打开后按本轮清除，刷新保留，再次进入待审阅重新提醒。24 条相关单测、类型检查、构建和隔离 Electron 验证通过，深浅主题截图在 `screenshots/studio/board-review-unseen-*.png`。未提交、发布或加载当前使用中的 Host。

- 共同需求：后台与界面及通知/询问修复已实现（`plans/done/shared-task-context.md`），待主控与独立验收复核；未提交、发布或加载用户 Host。通知保留永久过期或已送达历史、按当前有效业务重建并显示真实失败重试；结构化询问与工作跨真实回合，询问和自动状态保留验收，冷恢复派发前重核版本。旧未绑定任务与普通消息兼容；无法核验原只读权限的 DSH 询问及未协商用途的远程询问明确拒绝。
- 画布任务流转动画：管理线顺流执行、交付回流、退回修改与验收状态，依赖线展示等待前置及后续执行；支持本机动画开关和系统减少动态效果。类型检查、构建、41 条画布单测及 4 条隔离 mock Electron 验证通过，截图在 `screenshots/studio/canvas-flow-*.png`。仅改前端，当前窗口尚未刷新加载，未提交或发布。
- 任务自行设主控与带队初始化：`task_set_lead` 可一次带齐具体目标和 topicTitle，持久化待切换标题，安定后创建绑定缺失专题、补齐主控卡并开启只读交接；已有主控无专题可直接拆分初始化，幂等按真实回合或显式 operationKey 区分重试与再次派工。新建未分组子卡留出走线空间，已有布局、专题名和原上级不变。200 条相关回归（含 21 条新增）、类型检查、构建及 2 条隔离 mock Electron 用例通过，截图 `screenshots/studio/lead-initialization-*.png`，方案 `plans/done/lead-topic-initialization.md`。未重启当前 Host，未提交或发布，待人在空闲时重启加载。
- 画布协作点线已整项移除：界面、MCP、HTTP、协议与校验已清理，新增升级迁移仅清除旧协作线，管理/依赖与普通注释保持；定向单测、类型检查、构建及 7 条隔离 mock Electron 验证通过（`plans/done/remove-canvas-collaboration.md`）。未提交、发布或加载当前运行的 Host，待之后重启生效；本轮未启动教学实测。
- 主控带队与逐层交付：11-12 按「主控交给用户、受管任务交给直属主控」补齐最终验收；总交付保持 submitted/review，用户在交付面板明确通过才 accepted/done，AI 自审和拖动跳过最终审核被拒绝。重开/转交使旧交付失效，通知回复保留验收。164 条定向回归（含 3 条导航）、类型检查、构建与 2 条隔离 mock Electron 用例通过，已检查 `screenshots/studio/user-review-*.png`（深浅待审、退回与通过），方案 `plans/done/managed-workflow.md`。未加载当前用户 Host/Studio，需人在空闲时手动重启加载，未发布；本轮未跑全仓与真实模型验收。
- 画布讨论与变化提醒：关联卡上下文、变化标记、来源关系和讨论展开已实现；11-09 新增确认自动回传和整轮自动继续，已完成隔离 mock Electron 验证并重启开发版加载（`plans/done/canvas-review-returns.md`），待用户手动验收。本批改动在 `codex/canvas-review-workflow` 分支，未发布；连带复查和 Focus 聚合仍待推进。
- 画布连线纠错与管理树布局：本工作区已完成共享去重/防环、旧问题逐线定位修复和树形折线布局（`plans/done/canvas-relations.md`）；已做定向测试及隔离 Electron 拖线/反向/修复/布局验证，尚未提交、发布或加载用户使用中的 Studio/Host。
- 主控归属与画板关系：本工作区已完成代码、定向测试和隔离 Electron 验收（`plans/done/lead-management.md`），未提交、发布或加载用户使用中的 Host；旧任务保持未分配，需由用户或专题入口明确设置直属主控。

| 事项 | 状态（2026-11-06 核对） |
|---|---|
| 文档整理（Archify 三层） | 11-06 用户审过，合进 master：HANDOFF 瘦身、导航索引 `docs/nav/`（`node scripts/nav.mjs`）+ 锚点测试、plans 只留决定、`plans/later/` 放以后推进的。维护办法和对比实验在 `plans/doc-architecture.md`；以后每批文档改动后用里面的 3 个问题复测 |
| Host 结构 | `plans/host-structure.md`：8a–8c 已合进 master；剩一个 feature 环组 {collab、gitreview、projects、remote、review、sessions、tasks、viewpacks}，拆法写在方案里，没开工。项目梳理总表 `plans/done/cleanup-2026-11.md` |
| 全景（userlayer） | 分支 `studio/panorama`（worktree `G:\PROJECT\AgentMonitorOverlay-panorama`）比 master 多 4 个提交：全景里抽屉打开会话（`plans/userlayer/framework.md` 第 1 步）、内存测量，没合 |
| 远程会话 | 功能都在 master、已发布（`plans/done/remote-session.md`、`plans/done/remote-page-and-new-task.md`；11-06 加了远程任务页的被控端额度）。等用户用两台真电脑验收；会话级授权、模型细到型号、远程权限上限等用户 10-29 定先不做 |
| Android Studio | 工程在 `mobile/`（KMP：`shared` + `app`），调试 APK 在 `mobile/out/`。真实手机和 Tailscale 实网没测（`plans/done/android-studio.md`） |
| iOS Studio | `plans/ios.md`：签名 11-03 通了（jenkins-build 钥匙串），**等 App Store Connect API Key**（打包机 `~/.amo-ios/config` 两个 ID 空着、没有 .p8），之后 validate、问过用户再第一次上传。打包机上 LaunchAgent `com.amo.ios-build` 的残留没卸（等用户点头删 Mac 上的文件） |
| AMO 平台 | 方案 `plans/amo-lan-platform.md`。11-03 的「用完整包更新」还没在用户机器上真点过（11-04 时）。11-06 起清单带更新记录（`history`）；便签、Reviewer、中转要等各自下次发布才有完整历史。展示站统一的更新记录页没做 |
| @ 子会话 | 11-05 合进 master。没验证：真 Claude 开 Fast、真模型会不会照着带 `setup`（`plans/done/subsession-mention-2026-11-05.md`） |
| 等用户点头删的 worktree / 分支 | `G:\PROJECT\AgentMonitorOverlay-devui`（`studio/dev-ui-dir`，已全部合进 master）、`.claude/worktrees/agent-a04ca2f0eeff1a610`（展示页，已合）、`.claude/worktrees/agent-abb445f58543b0e8b`（10-30 的「环境装 Claude Code / Codex」早期版本，多 1 个提交；11-03 master 上另做了一版）。老分支 `codex/chatgpt-binding-name-sync`、`codex/task-launch-entry`、`issue/8` 各多 1 个提交 |
| 以后推进 | 谈过、现在不做的在 `plans/later/`（`README.md` 有清单）：教程第 2、5 章和产品内引导、文件快传、画布工作流，以及几件用户定了以后再说的小事 |

## 已知问题

- 画布普通连线标签经过其他卡片时可能遮住卡片点击位置（2026-11-08 隔离 Electron 验证发现）；本批讨论上下文未调整连线布局。
- `packages/host/src/runtime/codex/server-manager.test.ts` 以前偶发失败：app-server 启动后在后台 `git fetch` OpenAI 的插件市场，这个 git 继承了监听端口，`taskkill /T` 可能漏掉它。11-03 起这个测试用 `-c features.plugins=false` 启动；自动打包时还是把它排除在外（`release.mjs`），等它稳定一阵再定要不要放回去。同一个 git 也会拿着 Electron 的输出管道，让 e2e 的 `app.close()` 等到超时：11-05 起 e2e 的 `launchStudio` 在每个用例的 `codex-home` 写 `[features] plugins = false`。Studio 实际运行时照旧同步插件，碰到端口被占会换个端口重启。
- `packages/host/src/runtime/dsh/dsh-runtime.integration.test.ts` 的「session_start with write in a folder not set up」在全量 vitest 负载下偶尔超时，单独跑能过（11-05、11-06 都见过），原因没查。
- 端到端里 Claude 的 mock 配置没法向 Claude Code 要型号列表（会超时），所以测试模式给 mock 配了内置列表（`packages/host/src/bin.ts`）。
- Studio 里 agent 的命令 PATH 去掉了 WindowsApps，用不到应用商店版的 `pwsh`、`python3`、`winget`（本机 `python`、`node`、`git` 不受影响）。
- 几个测试在 `Lin/BaseBranch` 的 09931c7（2026-11-23）上就过不了，设置整理时发现、没查：e2e 的 `pi.spec.ts:44` 点「排队」后消息是 `held` 不是 `waiting`；`dsh.spec.ts` 第 61、87 行的输入框提示和排队消息文字对不上，第 222 行的模型列表对不上；`scroll-on-send.spec.ts` 第 37 行把对话滚到顶后偶尔量出 0。前几条看起来和同一天把「后续消息」默认改成等本轮结束有关。全量 vitest 有 10 个失败：`tutorial-terms`（教程里画布和输入框的 6 句话源码里已经没有了）、`kv-keys`（`settings:archived-task-retention-days` 没登记）、Host 的 `store`、`review-round`、`issues`、`dsh/session-log`、`codex/lead-mcp` 测试；它们读的文件这次都没改。
- 主控恢复流程在 Host 关闭数据库后可能还在跑，日志里出现 `bot leads recovery: Error: database is not open`（2026-11-28 dsh 集成测试收尾时看到）。不影响功能，用户定这次不修。
- 2026-11-28 在 `feat/studio-bots` 的 fb3bea7 上也过不了、与机器人带队无关的 vitest：`ios-release`（本机没有 `mobile/iosApp` 下的文件）、`tutorial-terms`、`dsh/session-log`、`issues`、`http/server`（期望 409 实得 200）；`remote/remote-tasks.test.ts` 跑到第 24 条（约第 890 行）后 worker 退出，全量里显示为 1 个 Unhandled Error。另外测试用的 `FakeServers.ensure` 没有并发保护，两个调用同时首次进来会各起一个假 app-server，`relays.test.ts` 为此在 `beforeEach` 先 `ensure`。

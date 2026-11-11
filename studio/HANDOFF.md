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
- 任务自行设主控：新增 `task_set_lead`，当前轮和任务工作安定后保留并归档旧会话，自动新开同任务只读主控并交接；停止取消、在途会话/分支和恢复去重已验证，101 条相关测试、类型检查和构建通过（`plans/done/task-self-lead.md`）。未重启当前 Host，未提交或发布。
- 画布协作点线已整项移除：界面、MCP、HTTP、协议与校验已清理，新增升级迁移仅清除旧协作线，管理/依赖与普通注释保持；定向单测、类型检查、构建及 7 条隔离 mock Electron 验证通过（`plans/done/remove-canvas-collaboration.md`）。未提交、发布或加载当前运行的 Host，待之后重启生效；本轮未启动教学实测。
- 主控带队与逐层交付：自动拆分、二级主控、依赖启动、交付验收/退回和业务问题逐层上报已实现，完成定向测试及隔离 mock Electron 验证（`plans/done/managed-workflow.md`）；尚未加载当前使用中的 Host，未提交或发布。全仓测试受资源不足中止，过程中失败的 DSH 单项与发布脚本单项独立复测通过。
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

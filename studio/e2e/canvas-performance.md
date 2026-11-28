# 专题画布性能基线

对应冻结方案 v1 §10「几十到数百张卡，只展开一个分支」。基线源码为 `feat/studio-bots` 的 `fb3bea735c6b1842019b374ae516a0cfd0b6ec31`。用该提交的源码在临时目录重新构建 UI、Host 和 Electron 入口。每种规模启动独立的隐藏 Studio，使用临时数据库、Chromium 配置、AMO 配置和系统分配的 loopback Host 端口。任务未创建模型会话。采样在共享桌面机器上进行。

## 实测结果

2026-11-28 02:13–02:14 UTC，Windows 11 Pro 10.0.26200 x64，Ryzen 9 7950X（32 逻辑处理器，系统可见内存约 63 GiB），Electron 44.7.0 / Chromium 152.0.7977.130，Playwright 1.63.0 / Node v24.12.0。画布视口 870×705 CSS px，DPR 1，浅色，缩放 100%。Electron e2e 2/2 通过，每种规模包含 1 轮预热及 5 轮计入统计的样本。

| 卡数 | 操作 | 中位数（ms） | 五轮原始值（ms） | HTTP/轮 | WebSocket/轮 | HTTP 响应体字节/轮 |
| ---: | --- | ---: | --- | ---: | ---: | ---: |
| 50 | 首屏 | 49.0 | 45.4、67.6、49.0、48.7、49.9 | 59 | 0 | 20,634 |
| 50 | 展开一支 | 31.9 | 31.9、30.5、28.5、33.4、33.4 | 0 | 0 | 0 |
| 50 | 重连 | 2,069.6 | 2080.5、2073.5、2069.4、2067.1、2069.6 | 156 | 1 | 87,884 |
| 302 | 首屏 | 350.6 | 295.6、350.6、258.6、375.7、370.3 | 311 | 0 | 138,902 |
| 302 | 展开一支 | 121.4 | 173.8、142.0、112.7、121.4、115.3 | 0 | 0 | 0 |
| 302 | 重连 | 2,344.5 | 2344.5、2370.5、2322.4、2362.0、2332.7 | 660 | 1 | 524,979 |

首屏每卡各发一次 `GET /api/tasks/:id/context`（50 / 302 次），另有 9 次 HTTP。重连每卡各发两次该请求（100 / 604 次），两种规模均另有 56 次 HTTP，其中 `/api/state` 与专题 `/canvas` 各读两次。展开按钮恢复的卡已经在首屏载入，五轮展开都只使用本地数据。这些计数和重连坐标校正由隔离 Electron 直接观察。旧版实现的相应入口可见 [useContextHints](../packages/ui/src/canvas/useContextHints.ts)、[useHostState](../packages/ui/src/host/useHostState.ts) 和 [useCanvas](../packages/ui/src/canvas/useCanvas.ts)。

原始结果保存在本机 `studio/test-results/canvas-performance-baseline/`，包括预热轮、逐请求 JSON 和各规模重连后的 PNG。[50 卡原始数据](../test-results/canvas-performance-baseline/canvas-performance-isolate-86d12-tree-event-socket-reconnect-studio/canvas-performance.json) · [302 卡原始数据](../test-results/canvas-performance-baseline/canvas-performance-isolate-d383e-tree-event-socket-reconnect-studio/canvas-performance.json)

## 复跑

从 `studio/` 运行。PowerShell 进程切到 `BelowNormal`，Playwright 固定 1 worker。`--output` 每次指定不同路径，便于保留两份数据。

```powershell
(Get-Process -Id $PID).PriorityClass = 'BelowNormal'
$env:AMO_E2E_CANVAS_PERF = '1'
$env:AMO_E2E_CANVAS_REVISION = (git rev-parse HEAD)
Remove-Item Env:AMO_E2E_APP,Env:AMO_STUDIO_DEV_URL -ErrorAction SilentlyContinue
npm run e2e -- --project=studio canvas-performance.spec.ts --workers=1 --output=test-results/canvas-performance-current
```

复跑冻结基线时，从仓库根目录导出指定版本的 `studio/`，复制本次新增的夹具和用例，再从临时副本构建。下列命令复用本机已安装的外部依赖，副本中的 `@amo-studio/*` 全部指向副本源码。

```powershell
$ErrorActionPreference = 'Stop'
$source = (Get-Location).Path
$env:AMO_E2E_CANVAS_REVISION = 'fb3bea735c6b1842019b374ae516a0cfd0b6ec31'
$sandbox = Join-Path $env:TEMP ('amo-canvas-source-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $sandbox | Out-Null
$archive = Join-Path $sandbox 'baseline.tar'
git archive --format=tar --output=$archive $env:AMO_E2E_CANVAS_REVISION studio
if ($LASTEXITCODE) { throw 'git archive failed' }
tar -xf $archive -C $sandbox
if ($LASTEXITCODE) { throw 'tar failed' }
$studio = Join-Path $sandbox 'studio'
$modules = Join-Path $studio 'node_modules'
$amoModules = Join-Path $modules '@amo-studio'
New-Item -ItemType Directory -Path $amoModules -Force | Out-Null
Get-ChildItem studio/node_modules -Directory | Where-Object { $_.Name -ne '@amo-studio' -and $_.Name -notlike '.*' } | ForEach-Object {
  New-Item -ItemType Junction -Path (Join-Path $modules $_.Name) -Target $_.FullName | Out-Null
}
Get-ChildItem studio/node_modules/@amo-studio -Directory | ForEach-Object {
  $package = Join-Path $studio ('packages/' + $_.Name)
  if (Test-Path -LiteralPath $package) {
    New-Item -ItemType Junction -Path (Join-Path $amoModules $_.Name) -Target $package | Out-Null
  }
}
Copy-Item -LiteralPath studio/e2e/support/canvas-performance.ts -Destination (Join-Path $studio 'e2e/support/')
Copy-Item -LiteralPath studio/e2e/studio/canvas-performance.spec.ts -Destination (Join-Path $studio 'e2e/studio/')
(Get-Process -Id $PID).PriorityClass = 'BelowNormal'
$env:AMO_E2E_CANVAS_PERF = '1'
Remove-Item Env:AMO_E2E_APP,Env:AMO_STUDIO_DEV_URL -ErrorAction SilentlyContinue
Set-Location $studio
node node_modules/typescript/bin/tsc -b packages/app packages/testkit
if ($LASTEXITCODE) { throw 'TypeScript build failed' }
Set-Location packages/ui
node ../../node_modules/vite/bin/vite.js build
if ($LASTEXITCODE) { throw 'UI build failed' }
Set-Location $studio
$output = Join-Path $source 'studio/test-results/canvas-performance-baseline-rerun'
node node_modules/@playwright/test/cli.js test -c e2e/playwright.config.ts --project=studio canvas-performance.spec.ts --workers=1 --output=$output
```

## 采样协议

- [数据夹具](support/canvas-performance.ts)给两棵总主控树各生成 3 个直属分支、固定的卡片 ID 与坐标、每个分支内一条依赖链。50 卡有 48 条管理线、36 条依赖线；302 卡有 300 条管理线、288 条依赖线。每棵树的实际任务 ID 由 Host 生成。每种规模先运行 1 轮预热，再记录 5 轮，使用同一专题、数据和 renderer。50 卡先跑。
- [性能用例](studio/canvas-performance.spec.ts)使用 renderer `performance.now()`。首屏从已连接的专题看板点击「画布」，到第一棵主控卡进入视口、旧版卡与关系线挂载。展开前只收起第一棵树的间接下辖，确认另一棵树的叶卡仍然存在，再点击「展开全部层级」，恢复 21 或 147 张卡。重连从原生事件 WebSocket 发起关闭，到下一次连接成功并显示断线期间写入的叶卡坐标。三项都在观测到目标 DOM 后等两个 `requestAnimationFrame`。重连计入旧版 2 秒退避，Host 始终运行。
- 从操作开始计同一 renderer 对同一 Host 的 `/api/*` HTTP 请求，单列 `/api/events` WebSocket 尝试数。网络窗口延长到 DOM 就绪后至少 500 ms，期间有请求时继续等到请求终结并安静 500 ms。JSON 保留每次请求的方法、路径、状态和响应体字节数。首屏从已连接看板出发，应用启动、静态资源、其他窗口以及驱动端布置数据和写坐标都在采样范围之外。
- 最终验收沿用卡数、固定结构、坐标与视口、相同的操作起点和网络口径。启用强制任命时改用新任命入口生成同结构的活动主控，或在迁移对照中使用旧数据库副本。新界面若延迟挂载，用实际可交互的根摘要、单支内容和重连校正作为结束标记，同时记录首屏已挂载量。旧版全量挂载量是历史观测值。

## 观测入口

以下入口便于最终验收复用。此基线只执行了大画布一行的三项采样。

| §10 场景 | 首选证据入口 |
| --- | --- |
| 首次带队、启动前断线 | Bot 原请求和定位动作、Host 任命与启动回执、重开应用前后的任务 ID、任期 ID 及正式卡数量。旧版画布补卡路径可参考 [lead-initialization](studio/lead-initialization.spec.ts)。 |
| 已有专题、多根、同名、多项目、两窗口并发 | 两窗口请求各自的目标及操作回执；对比专题 `GET /api/topics/:id/canvas` 的根卡、节点 ID、坐标及版本。 |
| 执行任务安全升主控 | 原任务/会话、后台命令状态、交接原因、工作目录与改动引用；记录切换前后的上级和历史会话 ID。 |
| 同一 Bot 跨专题、重置、旧会话迟到 | 各专题对话和事件中的收件任务 ID、独立问题及交付 ID；保存旧会话管理写入的拒绝与新会话回执。 |
| 在途交付与并发换任 | 两次换任回执、当前任期代次、下级提交的交付版本与投递计数。 |
| 停用、删除、隐藏、模型失败、暂停恢复 | Bot 设置、影响树详情、启动失败或暂停状态及恢复入口；前后对比待处理队列及投递记录。 |
| 层级管理、跨根依赖、退回重交、要求换版 | 画布管理/依赖线和待前置文字、`/workflow` 的交付版本与采用记录。可复用 [managed-dependencies](studio/managed-dependencies.spec.ts)、[shared-context](studio/shared-context.spec.ts) 的观察点。 |
| 工作树接入及基准漂移 | 任务详情的输入缺失提示，执行工作树实际提交、差异、基准和对应该版前置的接入回执。 |
| 删卡、并发拖动、筛选、窄屏、主题、键盘 | canvas GET/写入响应与页面截图，对比节点 ID、坐标、两类线和焦点顺序。可复用 [canvas-gestures](studio/canvas-gestures.spec.ts)、[canvas-relations](studio/canvas-relations.spec.ts)、[task-management](studio/task-management.spec.ts)。 |
| 大画布单支性能 | 每轮的 `canvas-performance.json`、重连后 PNG、详情和摘要路由的请求计数与响应体字节数。 |
| 查进度、追加工作、问题、原生审批、竞态验收 | Bot、Focus、画布或任务详情的相同待办 ID；实际会话原生审批 ID；对比 `/workflow` 审核前后状态。可复用 [root-completion](studio/root-completion.spec.ts)、[decisions](studio/decisions.spec.ts)、[user-review](studio/user-review.spec.ts)。 |
| 旧主控与异常链迁移 | 独立旧数据库副本迁移前后快照，核对任务与交付 ID、数量、坐标、启动中的记录和异常项。 |
| Plane 两种模式及回写重试 | 约定的真实测试工单、批准的计划版本和基准、各执行工作树、人工验收后与原单关联的根交付 ID，以及远端实际评论和本地回执。 |

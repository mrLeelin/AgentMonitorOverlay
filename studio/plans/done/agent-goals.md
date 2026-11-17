# Claude 与 DSH 原生 Goal 接入

状态：做完（2026-11-16）。沿用 Codex Goal 底栏，源码已实现并隔离验证，当前用户 Host 未重启加载。

## 用户决定

- 2026-11-16：Codex Goal 底栏完成后，继续接入 DSH 和 Claude。沿用同一入口与目标操作，不用 `/loop` 或普通消息模拟原生 Goal。

## 原生能力与接入

- Claude Code 2.1.304 提供原生 `/goal 条件`、`/goal` 读取和 `/goal clear`。Goal 通过原生 Stop evaluator 判断是否达成；SDK 虽声明 `active_goal`，实际版本还需读取原生 transcript 的结构化 `goal_status`。带 sentinel 的手动清除不能当作目标完成，不可能完成的原生评估结果映射为阻塞。
- Claude 没有独立暂停和预算接口。暂停需中断并确认原生目标 hook 已清除，同时保留 AMO 中的目标；继续重新设定该目标。面板明确暂停会中断当前回复，隐藏没有原生支持的预算与未知统计。
- DSH 有 `ctx.goals` 原生服务，但 ACP 只支持普通 prompt/cancel 等操作，不解析 `/goal`。通过 AMO 数据目录内的小型 Cordis 插件和随机命名管道桥接到原生目标服务；保留原有账号/型号 patch，不修改 DSH 安装包或用户全局配置。
- DSH 的限制是续跑轮数而非 Token。目标字段、phase、activation、revision、轮数与阻塞原因均读取原生服务；active 但 disarmed 不能显示成正在续跑。轮数用完后，只有用户显式提高上限才继续。
- 三家共用 Goal 快照与 HTTP 接口，通过 capabilities 决定面板展示。旧 Host、旧 CLI 或缺失原生接口须明确报不可用；不得把失败或未知值显示为成功/零消耗。停止、归档、接管与在途激活需要一起处理，避免被旧请求重新开启。

## 验证

定向回归覆盖原生控制与状态归一、暂停/继续/清除、完成与人为清除、预算能力、错误和竞态。Claude 使用真实 CLI/SDK 和本机 mock 模型验证原生评估器；DSH 使用真实安装版本与隔离本机 mock 验证插件加载、原生自主轮及轮数限制，界面使用 fake ACP 桥接回归。7 条隐藏 Electron 用例涵盖三家底栏及旧 Host，已检查深浅主题截图 `screenshots/studio/goal-{claude,dsh}-*.png`。未调用真实付费模型、未重启用户 Host、未提交或发布。

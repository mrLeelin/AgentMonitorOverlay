# 在 Studio 点击 `@Prefab`，跳到 Unity 选中资源

> 状态：待确认。2026-11-24 用户给出的场景是 `@ShutdownMainView.prefab`，在 Studio 打开 Unity 并选中 Prefab。本文建议把消息里的资源链接作为首版入口，先验 JellybeanUnity。

## 用户怎么用

1. 在 JellybeanUnity 的 Studio 会话输入 `@ShutdownMainView.prefab`，从现有文件候选里选中对应资源。同名候选显示各自的目录，发送后消息里显示文件名，悬停可查完整路径。
2. 点击消息里的 `@ShutdownMainView.prefab`，也可在右键菜单点「在 Unity 中定位」。Unity 已打开该工程时切到这个窗口并选中 Prefab。工程未打开时，Studio 先打开它，显示「正在打开 Unity」，等编辑器和资源导入就绪后自动定位。
3. 到 Unity 的 Project 窗口可以看到 Prefab 高亮，Inspector 显示它的内容。单击只改变选中对象，当前场景、Prefab 编辑模式、Play Mode 和未保存改动照常保留。查看源文件、在资源管理器里查看仍可从右键菜单打开。

输入 `@`、选候选、发送消息和 AI 生成回复本身都不启动 Unity。首版支持本机 Unity 6 工程的 `.prefab`，覆盖已开和未开两种情况。连接状态和 Console 可作为后续能力，在这个流程里只显示完成定位所需的进度和错误。

## Studio 怎么接

| 位置 | 做法 |
| --- | --- |
| `MessageFiles` / `FileLink` | 复用现有 `@文件` 候选、行内资源和右键菜单。仅对能解析到当前本机会话 Unity 工程的 `.prefab` 结构化引用启用单击定位。普通聊天文本、其他文件和远程副本沿用现有点击行为。 |
| 「编辑项目」 | 工作区就是 Unity 工程时直接识别。仓库包了一层时提供「Unity 工程目录」选择器。验证 `ProjectSettings/ProjectVersion.txt` 和 `Packages/manifest.json`，以 `workspaceId` 保存相对路径。 |
| `packages/host/src/features/unity/` | 用会话身份、工作目录和完整文件路径确定目标。统一处理现有 Editor 查找、工程启动、等待导入、选中和切前台。由 UI 走带会话范围的 Host 路由触发。 |
| `packages/protocol/src/unity.ts` | 声明定位请求、进度和结果。典型状态是「正在打开 Unity」「正在等待导入」「已在 Unity 中选中」，失败带具体原因和可用操作。 |

已有 `@文件` 附件保留路径，并经 `MessageFiles` 走 `FileLink`，无需新做一套文件搜索。实现时复用现有文件解析和外部打开路径，Unity 的目标匹配由 Host 按会话重新校验。[消息里的文件](../packages/ui/src/attach/MessageAttachments.tsx) · [现有文件链接](../packages/ui/src/files/FileLinks.tsx) · [Host 外部打开](../packages/host/src/features/openin/service.ts)

### 精确定位工程和资源

- Host 用项目绑定和 `Session.cwd` 得到会话实际的 Unity 工程根。独立 Git worktree 使用同样的相对目录，启动它自己的 Editor。规范化 Windows 路径和真实目录，每个请求仅允许当前工程 `Assets/` 内的已解析 Prefab。同名文件依靠完整路径区分，文件失效时提示重新引用。
- 用 `unity editors running` 查找目标进程，再用 `unity status` 判断 Pipeline 是否就绪。没有对应 Editor 时，用 `unity open <工程绝对路径>` 按项目版本启动。若目标已启动但 Pipeline 尚未连上，复用该进程并等待。冷启动状态由 Host 按工程合并，重复点击不启动多个 Editor，较新的定位请求接替同工程的旧请求。等待超过上限时可手动重试。每次操作都显式锁定项目路径，并核对返回目标，避免另一个工程先就绪时被误选。[Unity CLI 工程命令](https://docs.unity.com/en-us/unity-cli/reference/editor-project-commands)
- Editor 就绪后，调用 Pipeline 已注册的 `set_selection`，传入 `Assets/.../ShutdownMainView.prefab`。从返回结果或 `get_selection` 校验活动项的路径与 GUID，再用 `editor_focus` 把对应 Editor 切到前台。当前 Pipeline 源码通过 `AssetDatabase.LoadMainAssetAtPath` 找资源并写入 `Selection`。Project 窗口是否稳定展示高亮需实机验证。如果选择成功但窗口布局挡住资源，再评估增加一个固定的 Editor 定位命令来聚焦 Project 窗口并 `PingObject`。[Unity Pipeline](https://docs.unity.com/en-us/unity-cli/unity-pipeline/unity-pipeline-package) · [Unity PingObject](https://docs.unity.com/en-us/engine/6000.0/script-reference/unityeditor/editorguiutility/pingobject)
- 命令用可信 `unity.exe` 和固定参数数组直接启动，过滤会覆盖项目或连接目标的环境变量。检查 CLI 退出码和 JSON 结果，按能力识别不同版本的命令名。缺 Editor、缺 Pipeline、资源已移动、未导入和超时各显示可操作的提示。Studio 通过用户点击的 Host 路由启动和定位，模型可以在回复中给出引用。这个首版无需新增 MCP 工具或账号。

## 交付与验收

| 验收场景 | 通过条件 |
| --- | --- |
| 实际 Prefab，工程已开 | 在 Studio 的真实会话点击 `@ShutdownMainView.prefab`，Unity 现有窗口被激活，Project 窗口中该 Prefab 高亮，Inspector 显示正确资源。截图并核对选中路径和 GUID。 |
| 实际 Prefab，工程未开 | 用测试工程或已保存的隔离 worktree，从 Studio 点击后只启动一个正确版本的 Editor，导入后自动选中。等待中重复点击不会启动第二个 Editor。 |
| 多开和同名 | 两个 Editor 或独立 worktree 同时运行，且存在同名 Prefab，最终切前台的工程和活动资源与所点链接一致。 |
| 失败与回归 | 文件移动或删除、Editor 版本缺失、Pipeline 不可用、导入超时，以及普通文件与远程会话。失败时保留可定位的错误，原有 @ 引用、右键查看及复制路径仍可用。 |

## 已核对的能力（2026-11-24）

- JellybeanUnity 的真实项目中找到 `Assets/MagicWarrior/_Resources/Prefabs/UGUI/Shutdown/ShutdownMainView/ShutdownMainView.prefab`，Unity AssetDatabase 查询返回 GUID `4f129aabd67a1e244aa48ffabed2b913`。同名查询还返回目录、图集和脚本，定位必须使用完整资源路径。
- 本机 Unity CLI `1.0.0-beta.14`、Unity `6000.3.6f1` 与 Pipeline `0.8.0-exp.1`。实测 `editors running`、`status`、`find_assets`、`get_selection`，命令列表和包源码确认了 `set_selection` 与 `editor_focus`。本轮只做读取，Studio 的点击、Editor 前台切换、可见高亮和冷启动属于实施验收。

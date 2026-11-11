# Pi 会话接入

状态：做完（2026-11-10）。

## 用户要求

2026-11-10：在 Claude、GPT、DeepSeek 之外增加 Pi。

## 接入方式

Pi 作为独立运行时，通过本机 `pi --mode rpc` 启动；模型与登录沿用 Pi 的个人配置，Studio 不写 Pi 的凭据和全局设置。兼容旧 `@mariozechner/pi-coding-agent` 与新 `@earendil-works/pi-coding-agent` 安装布局，Windows 用 Node 入口启动 npm 安装，避免命令行 shell 转义。

会话文件在 Studio 数据目录的 `pi/sessions/`，以固定会话 ID 恢复；消息、图片、思考、工具结果、用量、压缩和扩展问答转换为 Studio 的统一会话条目。Pi 的 `agent_end` 之后仍可能自动重试，因此以 `agent_settled` 结束 Studio 回合。等待的消息保存在 Host，在真正发送前重核冻结输入和归属，停止后保留未送达条目供重发。

AMO 与额外 MCP 通过临时扩展按会话注入，凭据只经过子进程环境，固定扩展源码不含凭据；不修改项目的 `.pi/`。2026-11-11：安装 `pi-mcp-adapter` 会替换 Pi 内置连接器，因此等所有扩展加载后，通过其公开的 `pi-mcp-adapter:runtime-register:v1` 事件临时注册；没有适配器响应时使用 Pi 原生 `registerMcpServer`，两种接口均不可用才提示升级。适配器明确拒绝注册时保留失败，不回退到无人连接的原生注册；退出时释放注册。

## 能力边界

Pi 接入仅提供完全访问，不能伪装只读或工作区沙箱；主控、只读询问和更窄权限的委派明确拒绝。暂不提供终端接管和分支。Pi 原生配置负责自动压缩，Studio 提供手动压缩及过程展示。

## 验证方法

子进程 mock 验证 JSONL、并发请求、退出、消息排队、中断、重发、恢复、扩展问答和失效输入拦截；隔离 Electron 检查模型设置与会话界面。本机 Pi 的离线 RPC 探针只读取状态、模型与临时历史，不消耗真实模型额度。

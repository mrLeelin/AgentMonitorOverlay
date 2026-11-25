# AMO 团队看板服务

从 `studio/` 目录执行 `npm ci` 后，用 `npm run team-board:build` 构建 Node 服务和看板网页。运行环境需要支持 `node:sqlite` 的 Node 22.13 或更高版本。

| 设置 | 用途 |
|---|---|
| `AMO_TEAM_BOARD_RELAY` | 必填。团队 AMO 账号服务的基础地址 |
| `AMO_TEAM_BOARD_DATA_DIR` | SQLite 数据目录，默认系统用户目录下的 `AMO Team Board` |
| `AMO_TEAM_BOARD_HOST` / `AMO_TEAM_BOARD_PORT` | 监听地址，默认 `127.0.0.1:47121` |
| `AMO_TEAM_BOARD_ORIGIN` | 通过 HTTPS 反代部署时的浏览器访问地址，用于校验请求来源和设置安全 Cookie |

设置上述环境后运行 `npm run team-board:start`。在浏览器打开配置的地址。服务的健康检查在 `/health`。浏览器登录使用现有 AMO 团队账号，登录会话在服务重启时失效。原单、附件和审核通知持续保存在 `board.sqlite`。

Studio Host 默认连接 AMO 平台账号服务器的主机和 `47121` 端口。若看板另有域名或使用 HTTPS 反代，在启动 Studio Host 前配置 `AMO_TEAM_BOARD_URL` 为看板的浏览器访问地址。账号授权沿用 AMO 平台。

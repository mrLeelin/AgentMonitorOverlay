# Plane 团队任务接入

点击 Studio 左栏「团队任务」，即可在右侧工作区查看 Plane Community Edition v1.5.0 的团队看板。

## 准备 Plane

1. 从对应的 Plane v1.5.0 源码生成覆盖目录。

   ```sh
   python /path/to/amo/studio/integrations/plane/prepare_overlay.py --source /path/to/plane-v1.5.0 --output /path/to/studio-plane-overlay
   ```

2. 在 `plane.env` 里设置 `AMO_PLANE_OVERLAY_DIR` 为覆盖目录的绝对路径。新看板使用 Plane 项目权限，可读取自定义状态。
3. 将此覆盖叠加到已有 Compose 配置，更新 Plane 的 `api` 服务。沿用原工作区和数据卷。此前部署过 Studio 工作流覆盖的环境也需要重新生成整个覆盖目录，以恢复 Plane 自带的创建和状态更新行为。

   ```sh
   docker compose --env-file plane.env -f docker-compose.yml -f /path/to/amo/studio/integrations/plane/compose.studio.yml up -d --no-deps api
   ```

## 在 Studio 使用

1. 左栏没有「团队任务」时，在 Studio「设置 → 高级设置 → 功能开关」打开它。从左栏进入团队任务，输入 Plane 地址和个人访问令牌，再选择工作区和项目。可以直接连接 Plane，无需登录 AMO 平台。
2. 选好项目后，Studio 可用令牌显示工作项，无需再次登录 Plane。已有同账号网页会话时，Studio 使用 Plane 原生页面。工具栏右端齿轮可更改连接和项目。
3. 把 Plane 卡片拖到 Studio 左栏的专题或项目，松手后确认「创建个人任务」。也可右键卡片打开弹窗。Studio 保存团队单编号、原始标题、说明、提出人和链接。当前 Plane 令牌所属账号会加入执行人，已有执行人和团队单状态保持原样。
4. 在工作项选择「交给 Bot」，选定机器人和本地工程。接单后原单进入 In Progress，机器人在工单专属专题带队。每次交付由机器人通知你去工程验收，你可以在同一台机器人的工单里反馈问题或提交验收。
5. 工程验收通过后，Plane 将原单移到 Done、记录这一轮交付，并给原单发起人发送验收通知。发起人在原单单独评论「验收通过」或「验收成功」，机器人工单将提醒你可以归档。专属专题可在这张卡里点「归档工单专题」。发起人提出问题时，你可以在机器人主聊天里说「看看最新评论」或指定评论人，让它继续修改。此流程需同步更新 Plane API 覆盖层和 Studio。
6. 普通个人任务和 Plane 原单可以分别移动、归档和删除。任务页「更多」可为现有个人任务添加 Plane 原单链接，任务页也可移除链接。

Studio 将当前 Plane 连接和所选项目保存在本机数据目录的 `plane-team-board.json`。令牌使用 Windows DPAPI 加密，由 Host 发起 API 请求。Electron 按 Plane 服务器和令牌所属账号隔离保存网页会话。旧版曾按 AMO 账号保存连接，原账号已登录且旧令牌仍有效时，打开团队任务会迁移这份连接。也可直接用 Plane 令牌重新连接，原单链接仍可用。

「设置 → 高级设置 → 功能开关 → 团队任务」是本机开关。初次以当前账号的已有团队看板配置为准。关闭后收起团队入口并停用原单读取，已保存的连接和个人任务原单关联可在重新开启后继续使用。

已有关联的 Studio 任务会提示会话在开工前调用 `plane_task_get`。工具从当前任务定位原单，返回实时详情和父项，以及子项、关联项、评论、活动、文件、链接各列表。列表带 `nextOffset` 时，可用对应的 `section` 和 `offset` 继续读取。长说明用 `section: "description"` 续读。长评论用 `section: "comment"` 并带上 `commentId` 和偏移量续读。按需用 `plane_task_file` 读取原单附件或上传的内嵌图片。更新部署时需要同时更新 Plane API 覆盖文件和 Studio Host。

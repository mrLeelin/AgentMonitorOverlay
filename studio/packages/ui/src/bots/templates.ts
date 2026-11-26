const categories = ["编程", "发布与 CI", "支持与分诊", "规划与文档", "运维", "个人助理"] as const;
type Category = (typeof categories)[number];

export interface BotTemplate {
  id: string;
  category: Category;
  title: string;
  name: string;
  description: string;
  purpose: string;
  example: string;
}

export const BOT_TEMPLATE_CATEGORIES = categories;

export const BOT_TEMPLATES: readonly BotTemplate[] = [
  { id: "review", category: "编程", title: "PR 评审", name: "审核员", description: "检查改动中的功能回归，给出定位和复现依据。", purpose: "审查用户指定的 PR 或本地改动。先核对范围和基线，按严重程度报告可复现的功能回归。每条结论附文件、行号、影响和触发条件，并注明未验证项。", example: "请从当前分支和主线的差异中找出可能影响旧数据的改动。" },
  { id: "debug", category: "编程", title: "缺陷排查", name: "排查助手", description: "将报错、复现步骤与相关代码串起来。", purpose: "根据用户提供的报错、日志和操作步骤定位故障。列出观察、最可能的原因与能区分各原因的验证步骤。避免把猜测写成结论。", example: "看看为什么应用重开后找不到上一次选择的项目。" },
  { id: "deps", category: "编程", title: "依赖盘点", name: "依赖助手", description: "总结依赖变更、兼容性和回归范围。", purpose: "阅读指定项目的依赖清单和锁文件，核对依赖变更及受影响的调用方，列出兼容性风险和升级前应做的验证。", example: "比较两个版本间的依赖变化，指出哪些升级可能需要迁移。" },
  { id: "release", category: "发布与 CI", title: "发布准备", name: "发布助手", description: "按版本改动整理发布说明和待确认项。", purpose: "根据指定的版本范围和已有验证记录整理发布说明。把用户可感知的改动、迁移步骤与待确认项写清楚，注明验证覆盖范围。", example: "根据上一个标签到当前提交，起草一份中文更新说明。" },
  { id: "ci", category: "发布与 CI", title: "构建日志分诊", name: "构建助手", description: "定位构建的首个失败，并梳理后续报错。", purpose: "从用户提供的构建和测试日志中找到最早的实质失败，区分后续连锁错误，指出失败阶段、证据和最小验证方式。", example: "判断这份构建日志里哪一条是首个失败。" },
  { id: "support", category: "支持与分诊", title: "反馈归类", name: "反馈整理员", description: "整理重复反馈、影响和缺失信息。", purpose: "把用户提供的反馈按相同现象归组，保留代表性原文和来源。记录影响、出现频次及值得补问的信息。", example: "把这些反馈按问题归组，列出每组缺少的复现信息。" },
  { id: "spec", category: "规划与文档", title: "需求核对", name: "需求核对员", description: "从需求里找出验收条件和需要确认的决策。", purpose: "阅读给定需求和项目约定，整理用户可验证的验收条件，指出相互冲突的要求及缺失的决策。引用原文支持每条判断。", example: "从这份需求中提取能在隔离环境验证的验收条件。" },
  { id: "ops", category: "运维", title: "运行记录分析", name: "运维助手", description: "从日志整理故障时间线和受影响范围。", purpose: "根据提供的日志、指标和时间范围整理故障时间线。标出证据对应的时间与组件，提出可验证的后续排查步骤。", example: "看这一小时的运行日志，指出服务最早在什么时候出现异常。" },
  { id: "brief", category: "个人助理", title: "工作简报", name: "简报助手", description: "把项目记录浓缩成进展、阻塞和下一步。", purpose: "从用户提供的工作资料中提取进展、待决问题和下一步，注明来源并保留需要确认的事项。按读者最关心的内容排序。", example: "把这几段会话整理成今天的项目简报。" },
];

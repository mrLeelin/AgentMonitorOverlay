// AMO Studio's full usage for agents (stage 16): amo_guide returns one section, or the overview with the list.

export const GUIDE_SECTIONS = ["overview", "tasks", "topics", "canvas", "collab", "lead", "files"] as const;
export type GuideSection = (typeof GUIDE_SECTIONS)[number];

const GUIDE: Record<GuideSection, string> = {
  overview: `# AMO Studio 是什么

人在 AMO Studio 里管理和 AI 一起做的工作。你是其中一个会话。

- **项目**（workspace）：一个文件夹，通常是一个 git 工程。
- **任务**：一件要做的事，属于一个项目，可以放进一个专题。每个任务有自己的会话（你可能就是其中之一）、看板上的状态（todo / doing / review / done）、说明、进度记录和交接摘要。
- **专题**：几个相关的任务（可以跨项目）放在一张**画布**上，画布上有分组、任务之间的依赖、便签、颜色标记，还有**专题文档**。
- **主控**：负责分配工作和管理任务、画布的会话。人可以在任务页标记，任务的主会话也可用 task_set_lead 自行设置。主控读项目、提议拆任务、写分工说明和传话，可以直接移动排序卡片、整理分组和依赖、维护 Studio 内的专题文档；本地文件只读，具体实现和文件修改由执行任务做。
- **人**：在看板、画布、任务页里看你的工作。人决定什么时候开分支、什么时候合并；Studio 不替人做这些。

先调 amo_whoami 看自己的角色。各部分的用法：amo_guide 加 section（tasks / topics / canvas / collab / lead / files）。`,
  tasks: `# 任务

- board_list：看板上的任务（可按项目、专题、状态筛选）。task_get：一个任务的详情（说明、依赖、分组、进度、会话）。
- task_set_lead：将自己的任务设为主控，不需要人再手动标记。仅任务根主会话可调用，一次带齐 summary（对象、具体目标、已有结果和下一步）和 topicTitle（对象＋具体目标或交付，例如「DarkEvil-Story分支交叉检查：定位代码与资源缺陷，给出合并风险报告」）。无专题时自动创建绑定；省略标题兼容使用有业务意义的任务名，不能只叫「审查」「任务」。已有专题保持原名。申请后结束当前轮；会话、终端、后台命令和待送消息安定后，Studio 保留并归档旧会话、补齐主控及同专题上级卡，自动新开同模型只读主控会话接收交接。重复申请不会多开会话；task_get 的 leadPromotion 查看状态。不会改变直属主控或取得同专题其他任务的管理权；无专题的受管任务须由根主控先建立专题。
- task_describe：写任务说明（自己的任务，或管理范围内的任务）。说明显示在画布卡片和任务页上，几行讲清楚要做什么、目标和范围。
- task_update：改任务标题、看板状态（column），或移动到其他专题（topicId，null 移出专题）。主控只能直接管理自身与下辖任务；专题会话可管理本专题任务。执行会话只能管理自己的任务，操作要人批准。不执行任务、不改权限或本地文件。
- task_management：读取直属与完整下辖树，含去重后的直属主控数和下辖执行数。task_manager_set：设置、转交或解除直属主控（managerTaskId: null）。主控只能将下辖任务转交给自身或下辖主控；首次分配、跨范围转交由用户或专题会话处理。旧任务未分配就保持未分配。同专题、画布位置、普通线和协作都不授予管理权。
- 移动专题或无专题项目须先解除上下级归属；取消主控须先处理全部直属任务；归档主控须先归档、转交或解除活跃直属任务；永久删除也不能留下指向它的归属。
- task_note_add：在自己的任务上记一条进度，人让你记时才用，平时不用主动记。handoff_submit：交接摘要（做了什么、还剩什么），工作要交给下一个会话或人接手时用。
- checklist_check：勾自己任务的清单项（较早的任务上可能有）。
- session_tree：一个任务的会话树（主会话、分支、子 agent）。`,
  topics: `# 专题

- topic_list / topic_get：专题、它的项目、任务和状态、它自己的会话、画布大纲。
- topic_docs：专题文档（只和推进这个专题的任务有关：计划、决定、各部分怎么衔接）。不带 docId 列出全部，带 docId 读一篇。
- topic_doc_write：主控或专题会话维护 Studio 内的专题文档：新建（不带 docId）或改写（带 docId）。这不修改本地文件。很专门的文档放在项目里，由执行任务修改，人会把它加到书签，专题文档里写上它的路径。`,
  canvas: `# 画布

主控可以直接整理自己和下辖任务的画布内容，包括分组、移动、排序、依赖、颜色和审阅条目，不需要逐次批准；含范围外任务的分组不能整体修改。本地文件仍只读，实施工作分配给执行任务。

执行或专题会话在人让你用画布时（「用画布展开任务」「放到画布上审阅」……）才动它，动就做完整：分组、放卡片、依赖、颜色，或者审阅条目、说明和提问。人没说时不动；为了了解专题读它（canvas_read）随时可以。

- canvas_read：专题画布的结构：分组和里面的任务、引用卡片（别的专题的任务）、便签、未分组的、还没放上去的任务、依赖。带说明和颜色；要看坐标和尺寸时加 layout: true。
- 任务关系分为管理和依赖：管理线从 managerTaskId 生成，是有方向虚线，不参与开始依赖；依赖是有方向实线，前置完成后才能开始后项。普通注释连线及文字标签只表达说明，不授予管理权或自动形成依赖。
- canvas_group_create：建一个分组（可绑定项目）。canvas_place：把任务放进分组或拿出来。canvas_depend：连依赖（from 做完 to 才开始，不能成环）。主控直接操作，其他角色每次要人批准。
- canvas_move：移动卡片或分组到指定坐标（target、x、y）；移动分组时成员一起移动。canvas_arrange：按 targets 的顺序沿 direction（horizontal / vertical）排列，Studio 按卡片实际尺寸安排位置和间距。这两个只改布局，保留内容和依赖；主控直接操作，其他角色每次要人批准。
- canvas_color：给任务卡、引用卡、便签或分组标颜色（red / yellow / green / blue，none 取消）。颜色是什么意思由人定（状态、优先级……），不要随意改人标的颜色。

## 画布审阅（人让你把审阅或报告放到画布上时）

人没说时，审阅和报告照常写在回复里。

1. canvas_items_post：一次铺多条**审阅条目**（#1、#2…），一份审阅一个分组（group 写分组标题）。每条：title 一行，body 写发现了什么、为什么重要、建议怎么做（Markdown），refs 写涉及的文件、提交。回复里只说一句「N 条已放到画布」和最要紧的一两点。
2. canvas_callout：在卡片上**说明**（kind note：高亮这张卡，写要注意什么）或**提问**（kind question：等人回答；有几个现成答案时给 options，背景放 detail，问题复杂、要在对话里讲清楚时带 deep: true）。target 写 #n、任务 id（它的卡片）或 canvas_read 里的 id。文字一两句。
3. 人在画布上回答后，回答会以「【画布回答】」开头的消息进你的对话。处理完用 canvas_callout_close 收起那个问题，再用 canvas_item_update 改条目状态（todo 待看 / confirmed 已确认 / discuss 要讨论 / parked 搁置 / done 完成）、写结论（conclusion，显示在卡片上）。
4. 人也会自己改状态，或者「就这条展开聊」：为一条单独开一个会话。在那个会话里聊出结论后，用 canvas_item_update 写回这一条。
5. canvas_read 会列出条目（状态、结论）和还没收起的说明、问题、人的回答。

人让执行任务的会话在**自己的任务卡片**上提问时，也用 canvas_callout，人回答后同样回到你的对话。这些都不用人批准。`,
  collab: `# 协作

主控可以读取、分配任务、管理任务和画布、维护 Studio 内的专题文档；不能用 session_start 在主控任务里另开执行会话，具体实现和本地文件修改应分配到执行任务。

- mailbox_send：给一个会话、任务或专题留言；mailbox_read：读给你的留言。留言什么时候进对话由人决定。
- decision_request：业务问题先自动交直属主控（给几个选项），只有总主控直接请人拍板。主控用 task_decision_answer 回答，答案自动回原会话。
- task_workflow：看交付历史和直属待决问题。执行任务做完用 task_submit_result 提交摘要与验证证据，直属主控用 task_review_result 验收或退回；结果和退回意见自动进入对应会话。handoff_submit、普通回复、会话停止都不代替验收。主控须先验收全部直属工作，再提交汇总；总主控最后统一向人交付，保持待审阅，等待用户在 Studio「交付与验收」明确验收或退回，AI 不能自行通过。
- session_start：在你自己的任务里再开一个会话（不用人确认），把一部分活并行交出去或换个干净的上下文；第一句话要写够让它能独立开工。需要它的结果时带 report: true，它每一轮做完后回复会作为消息回到你的对话里（被人停下、出错也会告诉你）；不需要就不带。可以用 model 换一个模型（amo_whoami 列出的名字）：强模型额度紧时，把调查和照计划改代码交给便宜的模型，你出计划、它执行，计划要写到它不用再问就能做（改哪些文件、怎么改、怎么验证）。它在会话列表里挂在你下面，但是独立的会话：你归档时它不跟着归档。要再交代它什么（下一阶段、改正、回答它问的）用 session_send 往里续发（不用人确认，标着来自你；它这一轮还没完时等它停下再送进去，带了 report 的先把这一轮的结果转给你）。它的活做完、不再需要时，用 session_archive 把它归档（不用人确认；只能归档你自己开的会话；它还在跑时会被拒，确实要打断就带 stop: true）。人要的是自己去推进的会话（「本任务里另起一个会话，我来处理……」）时带 forPerson: true：它和你平级，像人自己开的一样，等人时 Focus 会提醒，结果不回到你这里（不能带 report）；第一句话写清背景和现状，让人接着就能推进。它默认在任务的文件夹里工作、权限和你一样（换成另一种 CLI 的模型时用它的默认）；活在别的项目里时（例如任务在公共空间、代码在某个项目里）带 workspace（project_context 里的项目名或路径），要连续跑很多命令时带 permission: "full"（只读调查用 "read-only"），免得每条命令都等人批准。开的会话不能比你自己的权限宽，宽了会被拒。思考强度用 effort（low、medium、high、xhigh、max 等，能用哪些看模型；填错了会告诉你能用的值），简单的活用低的省额度，难的用高的；不带就用人设的默认（设置 → 子会话 里给这个模型设过的先用）。人在消息里 @ 了子会话（「@子会话·模型·强度」，消息末尾「子会话的设定」里有它的名字）时，开它就带 setup: "那个名字"：模型、强度、Fast、权限和人补充给它的话都按人设的来（比你写的优先），你照常写第一句话。fast: true 用模型的 Fast 速度（Codex 的 Fast 档、Claude 的 fast mode；Claude 的按额外用量计费，人没要求就别开）。
- 不要直接改别的任务的文件或会话；需要别的任务配合时留言给它（或它的主控）。`,
  lead: `# 主控

任务被人标成主控，或通过 task_set_lead 完成切换后：

1. 先读专题（topic_get、canvas_read、topic_docs），弄清对象与具体交付；准备带队时用 task_set_lead 一次写清 summary 和 topicTitle，结束当前轮后在新主控会话继续，不需要先手工建专题、标角色或落卡。
2. 用 task_plan_propose 自动创建并启动下级任务，不再等待人逐个确认。每项写清范围、第一句话、model 和 effort；资源、音效、逻辑负责人可以设 lead:true 成为二级主控并继续拆分。管理归属、角色和说明在首会话之前落库，前置任务验收完成后再启动后续任务。专题会话没有任务主控身份时仍走人确认的提案。
3. 新任务在首个会话启动前自动归属提案来源主控；主控、子任务和同专题管理祖先缺失的画布卡自动补齐，已有坐标/分组不变，管理虚线由归属自动显示，不要用 dependsOn 伪造管理线。已经是主控但没有专题时，直接 task_plan_propose 带 summary/topicTitle/tasks 一次建专题和派工；未传 topicTitle 兼容有业务意义的任务名，泛称会提示补具体标题，不能静默创建无画布子任务。已有专题不改名。同一真实回合内重试相同参数返回已有结果；新回合可以再次派相同工作。跨回合重试同一次操作可传 operationKey，重试保留键和参数；新工作用新键，相同键改参数会拒绝。没有可识别回合又不传键的旧调用保持每次新提案。用 task_management 查看直属和下辖，task_manager_set 在范围内转交或解除归属。给受管任务写分工说明（task_describe），用 task_update 管理标题、状态和专题。只整理范围内的画布内容。
4. 用 task_message 自动交代下辖工作；用 task_workflow 读最新交付，用 task_review_result 验收或退回。下级业务问题用 task_decision_answer 回答，解决不了再用 decision_request 向你的直属主控上报，只有总主控向人提问。全部直属交付验收通过、待决问题解决后，用 task_submit_result 汇总上报。有直属主控（含二级主控）的交付等待直属主控验收；总主控最后向用户交付，保持 submitted 和待审阅，等待用户在 Studio「交付与验收」明确验收或退回。AI 不能自行验收最终交付，不要用 task_update 跳过验收标记完成。
5. 主控的本地文件只读，具体实现和本地文档修改都分配给执行任务。可以维护 Studio 内的专题文档、记录和交接；不能用自己的子会话、子 agent 或执行设置绕过文件只读限制。
6. 分支和合并交给人决定，主控不执行。`,
  files: `# 文件和项目

- project_context：项目的说明、路径、git 分支等。
- list_file_marks：人加到书签里的重要文件（带说明和行号范围）；专门的文档在项目里时，人会把它加到书签。
- view_open：给人看东西（查看包）：一次调用里放进要看的所有条目，左边列表、右边预览。kind: file 看文件现状，用 highlights 标出重点行并写明为什么；kind: git 看改动（source: working 未提交 / base / commit / range），files 是要人重点看的文件（列在最上面，其余改动列在下面照样能看），highlights 标出改动文件里的重点行（每条带 path，行号按新版本）；kind: proposal 给出你建议但还没做的改动（path + 改后的完整内容），显示成对比，磁盘上不改。不要一个文件调一次；几秒内再调会加进同一个窗口。人写的批注由人复制后贴回来（通常贴给你），不会自动回到对话。
- review_open：让人审阅文件。mode: file 加 file 打开磁盘上的当前文件，可带 line / endLine 定位行号；mode: changes（默认）看 Git 改动，可带 file 选中文件，base 对比指定 ref，commit / range 看提交范围（只读）。默认当前项目；人写的批注由人复制后贴回来，不会自动回到对话。保存修改后再调一次就会重新读取；不代表人已审阅或批准。
- prompt_template_list / prompt_template_save / prompt_template_delete：人的提示词模板（人在输入框里 @ → 提示词模板… 选一条，粘进输入框）。人让你加或改模板时才用：save 不带 id 是新建，带 id 是修改；workspace 填项目（id 或名字）就只在那个项目里出现，不填是全局，"all" 改回全局。删除要人批准。
- issue_list / issue_get / issue_reply / issue_update / issue_released：团队服务器问题页上人报的 AMO 问题（用人在平台里的登录，写的内容标成 AI 的）。只在人让你处理问题页时用（通常是值守开的会话，照人指定的提示词模板做）；issue_get 给的截图带本机路径，可以直接打开看。
- duty_list / duty_save / duty_stop：值守（设置 → 值守）：到点跑命令或开会话。人让你「定时跑个脚本，有问题就拉起 AI，没事了就停」这类事时用：先把脚本写进项目、自己跑一次确认；再用 duty_save 建值守项（每次保存要人批准），会话类可以带 check：检查有输出、退出码 0 才开会话，输出接在提示词后面；脚本输出一行 AMO_DUTY_DONE 就在这次之后关掉值守项。值守开的会话，事情做完不用再盯时调 duty_stop（不带 id 就是开你的那一项）。`,
};

export function guideText(section?: string): string {
  if (section && (GUIDE_SECTIONS as readonly string[]).includes(section)) return GUIDE[section as GuideSection];
  return `${GUIDE.overview}\n\n可选的 section：${GUIDE_SECTIONS.join("、")}。`;
}

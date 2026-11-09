import { z } from "zod";
import { TASK_PLAN_MAX_TASKS } from "@amo-studio/protocol";
import { writeAsync, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";

/** The AMO MCP tools of this feature (gathered in mcp/tools.ts). */
export function taskPlansTools({ service, caller }: ToolContext): AmoTool[] {
  return [
    {
      name: "task_plan_propose",
      title: "拆任务提案",
      description: `主控 splits work into managed tasks (at most ${TASK_PLAN_MAX_TASKS}) and starts them automatically; no repeated human confirmation. A topic session without a lead still proposes for the person to confirm. Tasks are placed on the canvas and bound to the proposing lead before their first session. Per task: key, title, project (default yours), description, firstMessage (enough to work independently), lead (true for a domain coordinator who may split its own work), model, effort, dependsOn (keys that must be accepted/done before this task starts). Root tasks start at once; dependent tasks start automatically after their prerequisites finish. New task ids are returned in created.`,
      inputSchema: {
        summary: z.string(),
        tasks: z.array(
          z.object({
            key: z.string().optional(),
            title: z.string(),
            project: z.string().optional(),
            description: z.string().optional(),
            lead: z.boolean().optional(),
            firstMessage: z.string().optional(),
            model: z.string().optional(),
            effort: z.string().optional(),
            dependsOn: z.array(z.string()).optional(),
          }),
        ),
      },
      readOnly: false,
      autoApprove: true,
      run: (args) =>
        writeAsync(caller, async (c) => {
          const plan = await service.taskPlans.propose(c.sessionId, args);
          return { proposalId: plan.id, tasks: plan.tasks.length, state: plan.state, created: plan.created, note: plan.state === "accepted" ? "已自动建立受管任务，无前置依赖的已启动，其余等前置任务验收后自动启动。" : "专题提案已交给人确认。" };
        }),
    },
  ];
}

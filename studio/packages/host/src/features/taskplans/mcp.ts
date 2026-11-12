import { z } from "zod";
import { TASK_PLAN_MAX_TASKS } from "@amo-studio/protocol";
import { writeAsync, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";

/** The AMO MCP tools of this feature (gathered in mcp/tools.ts). */
export function taskPlansTools({ service, caller }: ToolContext): AmoTool[] {
  return [
    {
      name: "task_plan_propose",
      title: "拆任务提案",
      description: `主控 splits work into managed tasks (at most ${TASK_PLAN_MAX_TASKS}) and starts them automatically; no repeated human confirmation. Give summary with the concrete goal; topicTitle names the object plus goal/deliverable for a new topic. An already-lead root without a topic creates and binds that topic atomically with the split (omitted topicTitle uses a meaningful task title; generic labels such as 审查/任务 are refused); existing topics are never renamed. The lead, children and same-topic management ancestors receive missing canvas cards, preserving existing layout; management lines derive from ownership, never invented dependencies. Identical parameters retried in the same actual turn return the existing proposal and created ids, including after restart. A new turn may dispatch identical work again. Optional operationKey explicitly identifies one operation across turns; keep it and the parameters for a retry, use a new key for new work. Reusing a key with changed parameters is refused. Without a recorded turn or operationKey, legacy calls remain separate requests. A topic session without a lead still proposes for the person to confirm. Per task: key, title, project (default yours), description, firstMessage (enough to work independently), lead (true for a domain coordinator), model, effort, contextBasis ({contextId,version}, explicit frozen shared requirement; omitted stays unbound), dependsOn (keys whose actual current delivery must be accepted before this task starts). Tasks without prerequisites start at once; dependent tasks retain their specified version while queued. New task ids are returned in created.`,
      inputSchema: {
        summary: z.string(),
        topicTitle: z.string().min(1).max(100).optional(),
        operationKey: z.string().min(1).max(200).optional(),
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
            contextBasis: z.object({ contextId: z.string(), version: z.number().int().positive() }).optional(),
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

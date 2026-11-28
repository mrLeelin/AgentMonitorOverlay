import type { BotLeadOperationReceipt, CanvasDoc, CanvasEdge, CanvasNode, Task, Topic, Workspace } from "@amo-studio/protocol";
import { createBot } from "./bot-lead-local.js";
import type { Studio } from "./studio.js";

export const canvasScenarios = [
  { cards: 50, leavesPerBranch: 7 },
  { cards: 302, leavesPerBranch: 49 },
] as const;

export const measuredRootNode = "perf-root-0";
export const measuredLeafNode = "perf-leaf-0-0-0";

/** Same two roots, six child leads, layouts and per-branch dependency chains for both versions of Studio. */
export async function seedCanvasPerformance(studio: Studio, leavesPerBranch: number) {
  const workspace = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("canvas-performance") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "性能基线专题", workspaceIds: [workspace.id] });
  const path = `/api/topics/${topic.id}/canvas`;
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  let bots: [string, string] | undefined;

  const create = async (id: string, title: string, x: number, y: number, lead: boolean, managerTaskId?: string) => {
    const description = "用于隔离验收的固定画布任务。";
    let taskId: string | undefined;
    if (!lead || !bots) {
      try {
        const { task } = await studio.api<{ task: Task }>("POST", "/api/tasks", { title, workspaceId: workspace.id, topicId: topic.id, lead, managerTaskId, description });
        taskId = task.id;
      } catch (error) {
        if (!lead || !(error instanceof Error) || !error.message.includes("appointment-required")) throw error;
        bots = [(await createBot(studio, workspace, "性能总主控")).id, (await createBot(studio, workspace, "性能中控")).id];
      }
    }
    if (!taskId && bots) {
      const receipt = await studio.api<BotLeadOperationReceipt>("POST", "/api/bot-leads/appointments", {
        operationId: id, intent: "create", source: { kind: "manual" }, workspaceId: workspace.id, topic: { topicId: topic.id },
        botId: bots[managerTaskId ? 1 : 0], title, description, firstMessage: description, start: false,
      });
      taskId = receipt.taskId;
      if (managerTaskId) await studio.api("PATCH", `/api/tasks/${taskId}`, { managerTaskId });
    }
    if (!taskId) throw new Error("Missing performance fixture task");
    nodes.push({ id, kind: "task", taskId, groupId: null, pos: { x, y } });
    return taskId;
  };

  for (let root = 0; root < 2; root++) {
    const x = 80 + root * 1_200;
    const rootId = await create(`perf-root-${root}`, `性能主控 ${root + 1}`, x, 110, true);
    for (let branch = 0; branch < 3; branch++) {
      const branchKey = `${root}-${branch}`;
      const branchX = x + branch * 340;
      const leadId = await create(`perf-branch-${branchKey}`, `性能分支 ${branchKey}`, branchX, 350, true, rootId);
      let previous: string | undefined;
      for (let leaf = 0; leaf < leavesPerBranch; leaf++) {
        const leafKey = `${branchKey}-${leaf}`;
        const taskId = await create(`perf-leaf-${leafKey}`, `性能执行 ${leafKey}`, branchX, 590 + leaf * 218, false, leadId);
        if (previous) edges.push({ id: `perf-dep-${leafKey}`, kind: "depends", from: previous, to: taskId });
        previous = taskId;
      }
    }
  }

  const readCanvas = () => studio.api<CanvasDoc>("GET", path);
  const writeCanvas = (doc: CanvasDoc) => studio.api<CanvasDoc>("PUT", path, doc);
  const saved = await writeCanvas({ ...await readCanvas(), nodes, edges });
  return { topic, saved, readCanvas, writeCanvas, collapsedCards: nodes.length - 3 * leavesPerBranch };
}

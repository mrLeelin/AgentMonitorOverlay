import { expect, test } from "@playwright/test";
import type { Session, SessionGoalState, SessionItem, SharedContext, SharedContextView, StateSnapshot, Task, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
let workerSessionId: string | undefined;
test.afterEach(async () => {
  if (workerSessionId) {
    await studio?.api("POST", `/api/sessions/${workerSessionId}/interrupt`).catch(() => undefined);
    await studio?.api("DELETE", `/api/sessions/${workerSessionId}/goal`).catch(() => undefined);
  }
  await studio?.close(); studio = undefined; workerSessionId = undefined;
});

for (const profileId of ["codex-mock", "claude-mock", "dsh-mock"]) {
  test(`${profileId}: a managed Goal receives the full frozen requirement before autonomous work`, async () => {
    studio = await launchStudio({ dsh: profileId === "dsh-mock" });
    const state = () => studio!.api<StateSnapshot>("GET", "/api/state");
    const settled = async (id: string) => {
      await expect.poll(async () => (await state()).sessions.find((s) => s.id === id)?.status, { timeout: 60_000 }).toMatch(/idle|completed/);
    };
    const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("managed-goal-context") });
    const topic = await studio.api<Topic>("POST", "/api/topics", { title: "中控 Goal 共同需求验证" });
    const lead = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "需求总主控", workspaceId: ws.id, topicId: topic.id, lead: true, firstSession: { profileId: "codex-mock", text: "维护冻结需求并等待下级交付。" } });
    await settled(lead.session.id);
    const { task } = await studio.api<{ task: Task }>("POST", "/api/tasks", { title: "直接以 Goal 开始的子任务", workspaceId: ws.id, topicId: topic.id, managerTaskId: lead.task.id });
    const body = "完整冻结需求：初始余额5枚，归零禁用，重置恢复5枚并清除成功提示；只根据真实验证交付。".repeat(120);
    expect(body.length).toBeGreaterThan(4000);
    const draft = await studio.api<SharedContext>("POST", "/api/shared-context/save", { sessionId: lead.session.id, rootTaskId: lead.task.id, baseRevision: 0, title: "子任务冻结依据", body, changeNote: "隔离验证完整正文先送达", sources: [{ kind: "user_requirement", source: "测试用户明确要求" }] });
    const published = await studio.api<SharedContext>("POST", "/api/shared-context/publish", { sessionId: lead.session.id, contextId: draft.id, baseRevision: draft.revision });
    await studio.api("POST", "/api/shared-context/apply", { sessionId: lead.session.id, contextId: published.id, version: 1, taskIds: [task.id] });
    const session = await studio.api<Session>("POST", `/api/tasks/${task.id}/sessions`, { profileId });
    workerSessionId = session.id;
    const context = () => studio!.api<SharedContextView>("GET", `/api/tasks/${task.id}/context`);
    expect((await context()).receipts.some((r) => r.sessionId === session.id && r.deliveredAt)).toBe(false);
    const objective = "根据已冻结需求核对业务规则，核对后报告证据。";
    const path = `/api/sessions/${session.id}/goal`;
    if (profileId === "dsh-mock") {
      // DSH cannot safely turn a writable native process into a read-only inquiry. A failed preparation must not start Goal.
      await expect(studio.api("PUT", path, { objective, status: "active" })).rejects.toThrow(/只读|共同需求/);
      expect((await state()).sessions.find((s) => s.id === session.id)?.goal?.status).not.toBe("active");
      expect((await context()).receipts.some((r) => r.sessionId === session.id && r.deliveredAt)).toBe(false);
      await studio.api("POST", `/api/sessions/${session.id}/messages`, { text: "先读取完整需求，核对后等待原生目标开启。" });
      await settled(session.id);
    }
    const result = await studio.api<SessionGoalState>("PUT", path, { objective, status: "active" });
    expect(result.goal?.objective).toBe(objective);
    const receipts = (await context()).receipts.filter((r) => r.sessionId === session.id);
    expect(receipts.some((r) => r.deliveredAt && r.version === 1)).toBe(true);
    expect(receipts.some((r) => r.adoptedAt)).toBe(false);
    const items = await studio.api<SessionItem[]>("GET", `/api/sessions/${session.id}/items`);
    expect(items.some((i) => i.type === "user" && i.text.includes(body))).toBe(true);
    if (profileId !== "dsh-mock") expect(items.some((i) => i.type === "turn" && i.messagePurpose === "inquiry" && i.state === "completed")).toBe(true);
  });
}

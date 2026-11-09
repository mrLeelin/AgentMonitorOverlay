import { test, expect } from "@playwright/test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { Session, Task, Workspace, Topic, SharedContext, SharedContextView, StateSnapshot, SessionItem, TaskResult } from "@amo-studio/protocol";
import { launchStudio, type Studio } from "../support/studio.js";

// Independent acceptance evidence only. Production code is intentionally untouched.
let studio: Studio | undefined;
const extraCleanup: Array<() => Promise<void>> = [];
const evidence = join(tmpdir(), "amo-studio-sandbox", "shared-context-independent-c");
mkdirSync(evidence, { recursive: true });
const freePort = async () => {
  for (let p = 47960; p <= 47999; p++) {
    const server = createServer();
    const ok = await new Promise<boolean>(resolve => { server.once("error", () => resolve(false)); server.listen(p, "127.0.0.1", () => server.close(() => resolve(true))); });
    if (ok) return String(p);
  }
  throw new Error("No free isolated Host port");
};
test.afterEach(async () => { await studio?.close(); studio = undefined; for (const fn of extraCleanup.splice(0)) await fn(); });
const state = () => studio!.api<StateSnapshot>("GET", "/api/state");
const view = (id: string) => studio!.api<SharedContextView>("GET", `/api/tasks/${id}/context`);
const items = (id: string) => studio!.api<SessionItem[]>("GET", `/api/sessions/${id}/items`);
const settled = (id: string) => expect.poll(async () => (await state()).sessions.find(s => s.id === id)?.status).toMatch(/idle|completed/);
const create = (ws: Workspace, topic: Topic, title: string, lead: boolean, managerTaskId?: string) => studio!.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title, workspaceId: ws.id, topicId: topic.id, lead, managerTaskId, firstSession: { profileId: "codex-mock", text: "Independent acceptance fixture." } });
const draft = (root: { task: Task; session: Session }) => ({ sessionId: root.session.id, rootTaskId: root.task.id, baseRevision: 0, title: "Independent shared requirement", body: "Three coins, disable at zero.", changeNote: "Initial authorized target", sources: [{ kind: "user_requirement", source: "Acceptance fixture" }] });

test("independent C: same-topic roots and worker publication stay isolated; invented evidence cannot be waived", async () => {
  studio = await launchStudio({ env: { AMO_STUDIO_PORT: await freePort() } });
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("independent-c") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "Independent C isolation" });
  const a = await create(ws, topic, "Root A", true), b = await create(ws, topic, "Root B", true);
  const worker = await create(ws, topic, "Worker A", false, a.task.id);
  const sibling = await create(ws, topic, "Unbound sibling", false, a.task.id);
  for (const s of [a, b, worker, sibling]) await settled(s.session.id);
  const saved = await studio.api<SharedContext>("POST", "/api/shared-context/save", draft(a));
  const published = await studio.api<SharedContext>("POST", "/api/shared-context/publish", { sessionId: a.session.id, contextId: saved.id, baseRevision: saved.revision });
  const basis = { contextId: saved.id, version: 1 };
  await expect(studio.api("POST", "/api/shared-context/apply", { sessionId: a.session.id, ...basis, taskIds: [b.task.id] })).rejects.toThrow(/read_only.*跨管理树/);
  await expect(studio.api("POST", "/api/shared-context/publish", { sessionId: worker.session.id, contextId: saved.id, baseRevision: published.revision })).rejects.toThrow(/read_only.*根主控/);
  await expect(studio.api("POST", "/api/shared-context/publish", { sessionId: b.session.id, contextId: saved.id, baseRevision: published.revision })).rejects.toThrow(/read_only.*根主控/);
  await studio.api("POST", "/api/shared-context/apply", { sessionId: a.session.id, ...basis, taskIds: [worker.task.id] });
  await expect.poll(async () => (await view(worker.task.id)).receipts.some(r => r.deliveredAt)).toBe(true);
  expect((await view(worker.task.id)).receipts.some(r => r.adoptedAt)).toBe(false);
  expect(await view(sibling.task.id)).toMatchObject({ context: null, binding: null });
  expect(await view(b.task.id)).toMatchObject({ context: null, binding: null });
  await settled(worker.session.id);
  const fake = await studio.api<TaskResult>("POST", `/api/tasks/${worker.task.id}/workflow/submit`, { sessionId: worker.session.id, summary: "Preserve invented-basis result", verification: "Deliberate negative case", contextBasis: { contextId: saved.id, version: 999 } });
  expect(fake).toMatchObject({ state: "submitted", contextBasis: { version: 999 } });
  await expect(studio.api("POST", `/api/tasks/${a.task.id}/workflow/review`, { sessionId: a.session.id, resultId: fake.id, accept: true, review: "Test waiver", contextExplanation: "Pretend the difference is immaterial" })).rejects.toThrow(/409.*不存在/);
  writeFileSync(join(evidence, "isolation.json"), JSON.stringify({ published, worker: await view(worker.task.id), unrelatedRoot: await view(b.task.id), unboundSibling: await view(sibling.task.id), savedFake: fake }, null, 2));
});

test("independent C: stopped notification survives actual isolated Host restart without wake or duplicate", async () => {
  studio = await launchStudio({ env: { AMO_STUDIO_PORT: await freePort() } });
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("independent-c-restart") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "Independent C restart" });
  const root = await create(ws, topic, "Stopped root", true), worker = await create(ws, topic, "Stopped executor", false, root.task.id);
  await settled(root.session.id); await settled(worker.session.id);
  await studio.api("POST", `/api/sessions/${worker.session.id}/interrupt`);
  const saved = await studio.api<SharedContext>("POST", "/api/shared-context/save", draft(root));
  await studio.api("POST", "/api/shared-context/publish", { sessionId: root.session.id, contextId: saved.id, baseRevision: saved.revision });
  await studio.api("POST", "/api/shared-context/apply", { sessionId: root.session.id, contextId: saved.id, version: 1, taskIds: [worker.task.id] });
  await expect.poll(async () => (await items(worker.session.id)).filter(i => i.type === "user" && i.id.startsWith("i-context-")).length).toBe(1);
  const before = await view(worker.task.id), firstItems = await items(worker.session.id);
  expect(before.receipts[0]).toMatchObject({ queuedAt: expect.any(String) });
  expect(before.receipts.some(r => r.deliveredAt || r.adoptedAt)).toBe(false);
  const sandbox = studio.root;
  // Keep the same mock provider alive across the process restart, so provider identity does not change.
  const oldMock = studio.mock!, oldClaude = studio.claudeMock;
  extraCleanup.push(async () => { await oldMock.close(); await oldClaude?.close(); });
  await studio.app.close(); studio = undefined;
  studio = await launchStudio({ root: sandbox, env: { AMO_STUDIO_PORT: await freePort(), AMO_STUDIO_TEST_PROVIDER_URL: oldMock.baseUrl } });
  await studio.page.waitForTimeout(1200);
  const after = await view(worker.task.id), afterItems = await items(worker.session.id);
  expect(after.receipts).toEqual(before.receipts);
  const notices = afterItems.filter(i => i.type === "user" && i.id.startsWith("i-context-"));
  expect(notices).toHaveLength(1); expect(notices[0]).toMatchObject({ delivery: "held" });
  expect(afterItems.filter(i => i.type === "turn").length).toBe(firstItems.filter(i => i.type === "turn").length);
  writeFileSync(join(evidence, "restart-before-resume.json"), JSON.stringify({ before, afterRestart: after, stableNoticeId: notices[0]!.id }, null, 2));
  let firstResumeError = "";
  try { await studio.api("POST", `/api/sessions/${worker.session.id}/messages`, { text: "The user explicitly resumes work.", now: true }); } catch (err) { firstResumeError = String(err); }
  writeFileSync(join(evidence, "first-resume.json"), JSON.stringify({ firstResumeError, view: await view(worker.task.id), items: await items(worker.session.id) }, null, 2));
  if (firstResumeError) {
    await studio.page.waitForTimeout(1200);
    await studio.api("POST", `/api/sessions/${worker.session.id}/messages`, { text: "Diagnostic retry after thread restoration.", now: true });
  }
  await expect.poll(async () => (await view(worker.task.id)).receipts.some(r => r.deliveredAt)).toBe(true);
  if (!firstResumeError) await expect.poll(async () => (await items(worker.session.id)).filter(i => i.type === "user" && i.text.startsWith("The user explicitly resumes work.")).length).toBe(1);
  await settled(worker.session.id);
  expect((await view(worker.task.id)).receipts.some(r => r.adoptedAt)).toBe(false);
  const finalItems = await items(worker.session.id);
  expect(finalItems.filter(i => i.type === "user" && i.id.startsWith("i-context-")).length).toBe(1);
  if (!firstResumeError) {
    expect(finalItems.filter(i => i.type === "user" && i.text.startsWith("The user explicitly resumes work.")).length).toBe(1);
    expect(finalItems.some(i => i.type === "user" && i.text.startsWith("Diagnostic retry"))).toBe(false);
  }
  writeFileSync(join(evidence, "restart.json"), JSON.stringify({ before, afterRestart: after, afterExplicitResume: await view(worker.task.id), stableNoticeId: notices[0]!.id, finalItems }, null, 2));
  expect(firstResumeError, "The first explicit user continuation must work without a diagnostic retry").toBe("");
});

test("independent C control: cold-resume of an unbound second Codex session", async () => {
  studio = await launchStudio({ env: { AMO_STUDIO_PORT: await freePort() } });
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("independent-c-control") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "Unbound recovery control" });
  const root = await create(ws, topic, "Control root", true), worker = await create(ws, topic, "Control executor", false, root.task.id);
  await settled(root.session.id); await settled(worker.session.id);
  await studio.api("POST", `/api/sessions/${worker.session.id}/interrupt`);
  expect((await view(worker.task.id)).binding).toBeNull();
  const sandbox = studio.root, oldMock = studio.mock!, oldClaude = studio.claudeMock;
  extraCleanup.push(async () => { await oldMock.close(); await oldClaude?.close(); });
  await studio.app.close(); studio = undefined;
  studio = await launchStudio({ root: sandbox, env: { AMO_STUDIO_PORT: await freePort(), AMO_STUDIO_TEST_PROVIDER_URL: oldMock.baseUrl } });
  let firstResumeError = "";
  try { await studio.api("POST", `/api/sessions/${worker.session.id}/messages`, { text: "Resume old unbound task.", now: true }); } catch (err) { firstResumeError = String(err); }
  if (!firstResumeError) {
    await expect.poll(async () => (await items(worker.session.id)).filter(i => i.type === "user" && i.text.startsWith("Resume old unbound task.")).length).toBe(1);
    await settled(worker.session.id);
    expect((await items(worker.session.id)).filter(i => i.type === "user" && i.text.startsWith("Resume old unbound task.")).length).toBe(1);
  }
  writeFileSync(join(evidence, "unbound-resume.json"), JSON.stringify({ firstResumeError, view: await view(worker.task.id), finalItems: await items(worker.session.id) }, null, 2));
  expect(firstResumeError, "Control first continuation").toBe("");
});

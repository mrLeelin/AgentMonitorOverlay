import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelProfile, Session, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { amoToolsFor } from "../../mcp/tools.js";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { startLeadFixture } from "../botleads/lead.test-support.js";

// What reaches a 主控 from its children, and what no longer wakes it (2026-11-17, the Free 主控: 13 mails it never saw,
// a turn only to say 已知悉 after its own 传话, a status that repeated a question it had not answered yet).

const profiles: ModelProfile[] = [{ id: "test", label: "测试", runtime: "codex", provider: null, model: "test-model" }];
let folder: string, store: Store, servers: FakeServers, service: HostService, workspace: Workspace, manager: Session, worker: Session;
beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), "amo-studio-test-manager-wakes-"));
  store = new Store(join(folder, "studio.db"));
  servers = new FakeServers(profiles);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles }), profiles, { commonDir: join(folder, "common") });
  workspace = store.addWorkspace({ name: "项目", path: folder });
  const top = store.createTask({ title: "主控", workspaceId: workspace.id, lead: true });
  const child = store.createTask({ title: "执行", workspaceId: workspace.id, managerTaskId: top.id });
  manager = await startLeadFixture(service, top, "test");
  worker = await service.tasks.addSession(child.id, { profileId: "test", options: { permission: "workspace-write" } });
});
afterEach(async () => { vi.restoreAllMocks(); await servers.close(); store.close(); removeTempDir(folder); });

const tool = (s: Session, name: string) => amoToolsFor(service, { sessionId: s.id }).find((t) => t.name === name)!;
const notices = (suffix: string, view: "full" | "pending" = "full") => service.orchestration.workflow(manager.taskId!, view).deliveryNotices!.filter((n) => n.id.endsWith(suffix));
const idle = (s: Session) => vi.waitFor(() => expect(store.getSession(s.id)?.status).toBe("idle"), { timeout: 4000 });

/** The child delivered and its manager accepted. */
function accepted(): void {
  const result = service.orchestration.submit(worker.id, "完成", "检查通过");
  service.orchestration.review(manager.id, result.id, true, "验收通过");
}

it("a child's mail to its direct manager goes into the manager's conversation as a notification", async () => {
  const reply = await tool(worker, "mailbox_send").run({ toTaskId: manager.taskId, text: "并发编辑阻塞：同一个 Handler 被另一个任务改了" });
  expect(reply.isError).not.toBe(true);
  expect(JSON.parse((reply.content[0] as { text: string }).text)).toMatchObject({ note: expect.stringContaining("直属主控") });
  await vi.waitFor(() => expect(store.listItems(manager.id).find((i) => i.type === "user" && i.text.includes("并发编辑阻塞"))).toMatchObject({ messagePurpose: "notification" }));
  await vi.waitFor(() => expect(service.collab.mail({ taskId: manager.taskId! })).toEqual([expect.objectContaining({ state: "forwarded" })]));
  await idle(manager);
}, 15_000);

it("mail to a task that does not manage the sender still waits for the person", async () => {
  const peer = store.createTask({ title: "平级", workspaceId: workspace.id });
  const reply = await tool(worker, "mailbox_send").run({ toTaskId: peer.id, text: "顺便说一下" });
  expect(JSON.parse((reply.content[0] as { text: string }).text)).not.toHaveProperty("note");
  expect(service.collab.mail({ taskId: peer.id })).toEqual([expect.objectContaining({ state: "unread" })]);
});

it("the manager's own work 传话 to an accepted child does not tell the manager it restarted", async () => {
  accepted();
  expect((await tool(manager, "task_message").run({ taskId: worker.taskId, text: "[[slow]] 再补一处", purpose: "work" })).isError).not.toBe(true);
  await vi.waitFor(() => expect(service.orchestration.results(worker.taskId!).at(-1)?.state).toBe("returned"));
  expect(notices("-reopened")).toEqual([]);
  await service.sessions.interrupt(worker.id);
}, 15_000);

it("a child restarted by someone else still tells its manager", async () => {
  accepted();
  await service.sessions.sendMessage(worker.id, "[[slow]] 人直接让它再改");
  await vi.waitFor(() => expect(service.orchestration.results(worker.taskId!).at(-1)?.state).toBe("returned"));
  expect(notices("-reopened")).toHaveLength(1);
  await service.sessions.interrupt(worker.id);
}, 15_000);

it("a child's turn is not reported while its question to the manager is open; once answered it is again", async () => {
  const decision = service.collab.requestDecisionFromSession(worker.id, "按哪种方案做？", ["A", "B"]);
  // Asked in an earlier turn, as in the Free 主控's case: turn boundaries have whole-second precision.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await service.sessions.sendMessage(worker.id, "先做不依赖答案的部分");
  await idle(worker);
  expect(notices("-manager")).toEqual([]);
  service.collab.answerDecision(decision.id, "A");
  await vi.waitFor(() => expect(notices("-manager")).toHaveLength(1), { timeout: 4000 });
}, 15_000);

it("the pending view keeps only notices still on their way or failed", async () => {
  service.orchestration.submit(worker.id, "完成", "检查通过");
  await vi.waitFor(() => expect(notices("-submit")).toEqual([expect.objectContaining({ state: "delivered" })]), { timeout: 4000 });
  service.sessions.inbox.pause(manager.id);
  service.collab.requestDecisionFromSession(worker.id, "按哪种方案做？", ["A", "B"]);
  await vi.waitFor(() => expect(service.orchestration.workflow(manager.taskId!, "pending").deliveryNotices).toEqual([expect.objectContaining({ state: "waiting" })]));
  expect(service.orchestration.workflow(manager.taskId!).deliveryNotices!.map((n) => n.state).sort()).toEqual(["delivered", "waiting"]);
}, 15_000);

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProfile, Session, SessionItem } from "@amo-studio/protocol";
import { removeTempDir, TINY_PNG_BASE64 } from "@amo-studio/testkit";
import { Store } from "../../store/store.js";
import { PiRuntime } from "./pi-runtime.js";

const profiles: ModelProfile[] = [{ id: "pi", label: "Pi", runtime: "pi", provider: null, model: null }];
const command = { command: process.execPath, args: [fileURLToPath(new URL("../../../../testkit/scripts/mock-pi.mjs", import.meta.url))] };
let root: string, store: Store, runtime: PiRuntime;
let workspace: ReturnType<Store["addWorkspace"]>, task: ReturnType<Store["createTask"]>;
const rows = (s: Session) => store.listItems(s.id);
const users = (s: Session) => rows(s).filter((i): i is Extract<SessionItem, { type: "user" }> => i.type === "user");
const replies = (s: Session) => rows(s).filter((i): i is Extract<SessionItem, { type: "agent" }> => i.type === "agent");
async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("Pi mock did not reach the expected state");
    await new Promise((r) => setTimeout(r, 10));
  }
}
const start = (text = "hello", options = {}) => runtime.startSession({ taskId: task.id, topicId: null, workspace, profileId: "pi", text, options });
const ended = (s: Session) => until(() => ["idle", "completed", "error", "interrupted"].includes(store.getSession(s.id)!.status));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-pi-runtime-"));
  const path = join(root, "ws"); mkdirSync(path);
  store = new Store(":memory:");
  workspace = store.addWorkspace({ path, name: "Pi workspace" });
  task = store.createTask({ title: "Pi task", workspaceId: workspace.id });
  runtime = new PiRuntime(store, profiles, { dir: join(root, "pi"), command });
});
afterEach(async () => { await runtime.closeAll(); store.close(); removeTempDir(root); });

describe("Pi sessions against a subprocess RPC peer", () => {
  it("lists configured models and records a complete reply, tool result, and token usage", async () => {
    const choices = await runtime.choices("pi");
    expect(choices.models.map((m) => m.id)).toContain("mock/pi-test");
    expect(choices.defaultPermission).toBe("full-access");
    expect(choices.permissions.map((p) => p.id)).toEqual(["full-access"]);
    const s = await start("hello [[tool]]"); await ended(s);
    expect(replies(s).at(-1)?.markdown).toContain("MOCK-PI 1: hello");
    expect(users(s)[0]?.delivery).toBeUndefined();
    expect(rows(s).find((i) => i.type === "tool")).toMatchObject({ status: "completed", detail: "mock file content" });
    expect(rows(s).find((i) => i.type === "turn")).toMatchObject({ state: "completed", usage: { output: 20 } });
  });

  it("waits for agent_settled after agent_end announces a retry", async () => {
    const s = await start("hello [[retry]]");
    await new Promise((r) => setTimeout(r, 30));
    expect(store.getSession(s.id)?.status).toBe("running");
    await ended(s);
    expect(replies(s).at(-1)?.markdown).toContain("MOCK-PI 1");
  });

  it("stops and sends a waiting message now as a separate turn", async () => {
    const s = await start("first [[hold]]");
    expect(await runtime.sendMessage(s.id, "second")).toEqual({ mode: "queue" });
    const row = users(s).at(-1)!; expect(row.delivery).toBe("waiting");
    await runtime.sendNow(s.id, row.id);
    await until(() => replies(s).some((r) => r.markdown.includes("second")));
    await ended(s);
    expect(users(s).at(-1)?.delivery).toBeUndefined();
    expect(rows(s).filter((i) => i.type === "turn").map((i) => i.state)).toEqual(["interrupted", "completed"]);
  });

  it("revalidates a queued message before transport and keeps the expired item", async () => {
    const s = await start("first [[hold]]");
    await runtime.sendMessage(s.id, "old requirement");
    const row = users(s).at(-1)!;
    runtime.setDispatchValidation((_id, itemId) => itemId !== row.id);
    await runtime.sendNow(s.id, row.id).catch(() => undefined);
    await until(() => store.getItem(row.id)?.type === "user" && (store.getItem(row.id) as Extract<SessionItem, { type: "user" }>).delivery === "expired");
    expect(replies(s).some((r) => r.markdown.includes("old requirement"))).toBe(false);
  });

  it.each(["send", "resend", "turn-start"] as const)("preserves permanent expiry at the %s dispatch barrier", async (seam) => {
    const s = await start("");
    const reason = "Requirement changed before Pi accepted the input";
    const expire = () => {
      const row = users(s).at(-1)!;
      store.replaceItem({ ...row, delivery: "expired", deliveryReason: reason, deliveryEndedAt: new Date().toISOString() });
    };
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const atGate = new Promise<void>((resolve) => { entered = resolve; });
    const internal = runtime as unknown as { applyOptions(session: Session, live: unknown): Promise<void> };
    const apply = vi.spyOn(internal, "applyOptions").mockImplementation(async () => { entered(); await gate; });
    const listener = () => { if (seam === "turn-start" && store.getSession(s.id)?.status === "running") expire(); };
    runtime.on("event", listener);
    if (seam === "resend") store.appendItem({ id: "i-pi-expiry", sessionId: s.id, createdAt: new Date().toISOString(), type: "user", text: "old requirement", delivery: "held" });
    const sending = seam === "resend" ? runtime.resend(s.id, "i-pi-expiry", []) : runtime.sendMessage(s.id, "old requirement");
    try {
      await atGate;
      if (seam !== "turn-start") expire();
      release();
      await expect(sending).rejects.toThrow(reason);
      expect(users(s).at(-1)).toMatchObject({ delivery: "expired", deliveryReason: reason, text: "old requirement" });
      expect(replies(s)).toHaveLength(0);
    } finally { release(); apply.mockRestore(); runtime.off("event", listener); }
  });

  it("cancels queued messages on stop and can resend their original row", async () => {
    const s = await start("first [[hold]]");
    await runtime.sendMessage(s.id, "later");
    const row = users(s).at(-1)!;
    await runtime.interrupt(s.id); await ended(s);
    expect(store.getItem(row.id)).toMatchObject({ delivery: "unsent" });
    await runtime.resend(s.id, row.id, []); await ended(s);
    expect(users(s)).toHaveLength(2);
    expect(store.getItem(row.id)).toMatchObject({ text: "later" });
    expect(replies(s).at(-1)?.markdown).toContain("later");
  });

  it("resumes the same persisted Pi conversation after closing the runtime", async () => {
    const s = await start("one"); await ended(s);
    await runtime.closeAll();
    runtime = new PiRuntime(store, profiles, { dir: join(root, "pi"), command });
    await runtime.sendMessage(s.id, "two"); await ended(s);
    expect(replies(s).at(-1)?.markdown).toContain("MOCK-PI 2: two");
    expect(store.getSession(s.id)?.runtimeRef).toBe(s.runtimeRef);
  });

  it("maps Pi extension dialogs into a question and returns the selected answer", async () => {
    const s = await start("choose [[question]]");
    await until(() => rows(s).some((i) => i.type === "question"));
    const q = rows(s).find((i): i is Extract<SessionItem, { type: "question" }> => i.type === "question")!;
    expect(q).toMatchObject({ source: "pi-input", state: "pending" });
    await runtime.answerQuestion(s.id, q.id, { action: "answer", answers: [{ id: q.questions![0]!.id, selected: ["继续"] }] });
    await ended(s);
    expect(store.getItem(q.id)).toMatchObject({ state: "answered" });
    expect(replies(s).at(-1)?.markdown).toContain("-> 继续");
  });

  it("rejects read-only and lead sessions before starting Pi", async () => {
    await expect(start("cannot", { permission: "read-only" })).rejects.toThrow(/Pi/);
    store.updateTask(task.id, { lead: true });
    await expect(start("cannot")).rejects.toThrow(/Pi/);
    expect(store.listSessions()).toHaveLength(0);
  });

  it("reports provider and child-process failures and can continue after a failure", async () => {
    const s = await start("fail [[fail]]"); await ended(s);
    expect(store.getSession(s.id)?.status).toBe("error");
    expect(rows(s).find((i) => i.type === "turn")).toMatchObject({ state: "failed" });
    await runtime.sendMessage(s.id, "recover"); await ended(s);
    expect(replies(s).at(-1)?.markdown).toContain("recover");
    await runtime.sendMessage(s.id, "crash [[crash]]").catch(() => undefined);
    await until(() => store.getSession(s.id)?.status === "error");
    expect(rows(s).filter((i) => i.type === "turn").at(-1)).toMatchObject({ state: "failed" });
  });

  it("sends real image bytes, compacts once, and updates only valid options", async () => {
    const s = await start("one"); await ended(s);
    const path = join(root, "image.png"), bytes = Buffer.from(TINY_PNG_BASE64, "base64"); writeFileSync(path, bytes);
    await runtime.sendMessage(s.id, "look", [{ id: "a-image", path, name: "image.png", mime: "image/png", size: bytes.length, createdAt: new Date().toISOString() }]); await ended(s);
    expect(replies(s).at(-1)?.markdown).toContain("[images:1]");
    expect(users(s).at(-1)?.images).toEqual([{ id: "a-image", path }]);
    await runtime.runCommand(s.id, "compact", "");
    expect(rows(s).filter((i) => i.type === "compaction")).toMatchObject([{ state: "completed", beforeTokens: 100 }]);
    await runtime.setOptions(s.id, { model: "mock/pi-other", effort: "high" });
    expect(store.getSession(s.id)?.options).toMatchObject({ model: "mock/pi-other", effort: "high" });
    await expect(runtime.setOptions(s.id, { model: "mock/missing" })).rejects.toThrow(/Model not found/);
    expect(store.getSession(s.id)?.options).toMatchObject({ model: "mock/pi-other", effort: "high" });
    await expect(runtime.sendMessage(s.id, "read-only question", [], { purpose: "inquiry" })).rejects.toThrow(/Pi/);
  });

  it("a stop during cold recovery prevents the waiting send from reaching Pi", async () => {
    const s = await start("one"); await ended(s);
    await runtime.closeAll();
    runtime = new PiRuntime(store, profiles, { dir: join(root, "pi"), command: { ...command, env: { MOCK_PI_START_DELAY: "150" } } });
    const sending = runtime.sendMessage(s.id, "must not run").catch(() => undefined);
    await new Promise((r) => setTimeout(r, 40));
    await runtime.interrupt(s.id);
    await sending;
    await new Promise((r) => setTimeout(r, 80));
    expect(replies(s)).toHaveLength(1);
    expect(replies(s)[0]?.markdown).toContain("one");
    expect(store.getSession(s.id)?.status).not.toBe("running");
  });
});

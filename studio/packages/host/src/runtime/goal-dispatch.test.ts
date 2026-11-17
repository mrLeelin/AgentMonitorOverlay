import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProfile, Session, SessionItem } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { HostService } from "../service.js";
import { Store } from "../store/store.js";
import { CodexRuntime } from "./codex/codex-runtime.js";
import { FakeServers } from "./codex/fake-servers.test-support.js";
import { currentMessagePurpose, pendingMessagePurpose } from "./message-purpose.js";

const profiles: ModelProfile[] = [{ id: "goal-dispatch", label: "Goal dispatch", runtime: "codex", provider: null, model: null }];
let folder: string, store: Store, servers: FakeServers, native: CodexRuntime, service: HostService, session: Session;

beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), "amo-studio-test-goal-dispatch-"));
  store = new Store(join(folder, "studio.db"));
  servers = new FakeServers(profiles);
  native = new CodexRuntime({ store, servers, profiles });
  service = new HostService(store, native, profiles, { commonDir: join(folder, "common") });
  const workspace = store.addWorkspace({ name: "Goal dispatch", path: folder });
  const task = store.createTask({ title: "Goal dispatch", workspaceId: workspace.id });
  session = await service.tasks.addSession(task.id, { profileId: profiles[0]!.id, text: "Prepare the dispatch test" });
  await idle();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await servers.close();
  store.close();
  removeTempDir(folder);
});

const idle = () => vi.waitFor(() => expect(store.getSession(session.id)?.status).toBe("idle"));
const userItem = (text: string) => store.listItems(session.id).find((item): item is Extract<SessionItem, { type: "user" }> => item.type === "user" && item.text.includes(text));

function gateRecovery(failure?: string) {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const atGate = new Promise<void>((resolve) => { entered = resolve; });
  const ensure = servers.ensure.bind(servers);
  vi.spyOn(servers, "ensure").mockImplementationOnce(async (id) => {
    entered();
    await gate;
    if (failure) throw new Error(failure);
    return ensure(id);
  });
  return { release, atGate };
}

describe("Goal and message dispatch reservations", () => {
  it.each(["work", "inquiry"] as const)("rejects Goal activation while an earlier %s message waits for native recovery", async (purpose) => {
    const recovery = gateRecovery();
    const activate = vi.spyOn(native, "setGoal");
    const sending = service.sessions.sendMessage(session.id, `Existing ${purpose} message`, [], [], { purpose });
    await recovery.atGate;
    try {
      expect(store.getSession(session.id)?.status).toBe("idle");
      await expect(service.runtime.setGoal!(session.id, { objective: "Do not overtake this message", status: "active" })).rejects.toThrow("当前消息还在发送");
      expect(activate).not.toHaveBeenCalled();
      expect(currentMessagePurpose(store, session.id)).toBe(purpose);
      expect(pendingMessagePurpose(store, session.id)).toBe(purpose);
    } finally {
      recovery.release();
    }
    await sending;
    await idle();
    expect((await service.runtime.setGoal!(session.id, { objective: "Start after the message finishes", status: "active" })).goal?.status).toBe("active");
  });

  it.each(["work", "inquiry", "notification"] as const)("keeps a later %s message in the inbox while Goal activation waits", async (purpose) => {
    const recovery = gateRecovery();
    const activating = service.runtime.setGoal!(session.id, { objective: "Start before later messages", status: "active" });
    await recovery.atGate;
    const text = `Deferred ${purpose} during Goal recovery`;
    try {
      expect(await service.sessions.sendMessage(session.id, text, [], [], { purpose })).toEqual({ mode: "queue" });
      expect(userItem(text)).toMatchObject({ delivery: "held", messagePurpose: purpose });
      expect(currentMessagePurpose(store, session.id)).toBe("work");
      expect(pendingMessagePurpose(store, session.id)).toBe("work");
    } finally {
      recovery.release();
    }
    await activating;
    if (purpose !== "work") {
      await service.sessions.inbox.flush(session.id);
      expect(userItem(text)).toMatchObject({ delivery: "held", messagePurpose: purpose });
      expect(currentMessagePurpose(store, session.id)).toBe("work");
      await service.runtime.setGoal!(session.id, { status: "paused" });
    }
    await vi.waitFor(() => expect(userItem(text)?.delivery).toBeUndefined());
    await idle();
    expect(userItem(text)?.messagePurpose).toBe(purpose);
    expect(currentMessagePurpose(store, session.id)).toBe(purpose);
  });

  it("releases a failed Goal reservation so held and new messages can be dispatched without a retry", async () => {
    const recovery = gateRecovery("Native Goal recovery failed");
    const activating = service.runtime.setGoal!(session.id, { objective: "Fail before activation", status: "active" });
    const failed = expect(activating).rejects.toThrow("Native Goal recovery failed");
    await recovery.atGate;
    const text = "Inquiry held behind failed Goal";
    try {
      expect(await service.sessions.sendMessage(session.id, text, [], [], { purpose: "inquiry" })).toEqual({ mode: "queue" });
      expect(userItem(text)).toMatchObject({ delivery: "held", messagePurpose: "inquiry" });
      expect(currentMessagePurpose(store, session.id)).toBe("work");
    } finally {
      recovery.release();
    }
    await failed;
    // The reservation's finally notification wakes the existing inbox automatically.
    await vi.waitFor(() => expect(userItem(text)?.delivery).toBeUndefined());
    await idle();
    expect(store.getSession(session.id)?.goal ?? null).toBeNull();
    expect(currentMessagePurpose(store, session.id)).toBe("inquiry");
    await service.sessions.sendMessage(session.id, "New work after failed Goal");
    await vi.waitFor(() => expect(userItem("New work after failed Goal")?.delivery).toBeUndefined());
    await idle();
    await service.sessions.inbox.flush(session.id);
    expect((await service.runtime.setGoal!(session.id, { objective: "A later activation still works", status: "active" })).goal?.status).toBe("active");
  });

  it("rejects activation while Send now is crossing a work-to-inquiry turn boundary", async () => {
    await service.sessions.sendMessage(session.id, "[[busy: 500]]");
    await vi.waitFor(() => expect(store.getSession(session.id)?.status).toBe("running"));
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const atGate = new Promise<void>((resolve) => { entered = resolve; });
    const interrupt = native.interrupt.bind(native);
    vi.spyOn(native, "interrupt").mockImplementationOnce(async (id) => { entered(); await gate; await interrupt(id); });
    const activate = vi.spyOn(native, "setGoal");
    const sending = service.sessions.sendMessage(session.id, "Read-only message sent now", [], [], { purpose: "inquiry", now: true });
    await atGate;
    try {
      await expect(service.runtime.setGoal!(session.id, { objective: "Do not overtake the boundary", status: "active" })).rejects.toThrow("当前消息还在发送");
      expect(activate).not.toHaveBeenCalled();
      expect(currentMessagePurpose(store, session.id)).toBe("work");
    } finally {
      release();
    }
    await sending;
    await vi.waitFor(() => expect(userItem("Read-only message sent now")?.delivery).toBeUndefined());
    await idle();
    expect(currentMessagePurpose(store, session.id)).toBe("inquiry");
  });
});

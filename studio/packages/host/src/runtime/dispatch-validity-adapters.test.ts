import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelProfile, Session } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { HostService } from "../service.js";
import { Store } from "../store/store.js";
import { StaticCredentialReader } from "./credentials.js";
import { ClaudeRuntime } from "./claude/claude-runtime.js";
import { newLive } from "./claude/live.js";
import { DshRuntime } from "./dsh/dsh-runtime.js";

let folder: string, store: Store;
afterEach(() => { vi.restoreAllMocks(); store?.close(); if (folder) removeTempDir(folder); });

it.each(["dsh-resume", "dsh-options", "claude-closing", "claude-ready"] as const)("keeps terminal inbox expiry across the native %s transport barrier", async (seam) => {
  folder = mkdtempSync(join(tmpdir(), "amo-studio-test-native-dispatch-"));
  store = new Store(join(folder, "studio.db"));
  const isDsh = seam.startsWith("dsh"), kind = isDsh ? "dsh" : "claude";
  const profiles: ModelProfile[] = [{ id: "test", label: "测试", runtime: kind, provider: null, model: "test" }];
  const credentials = new StaticCredentialReader({});
  const runtime = isDsh ? new DshRuntime({ store, profiles, credentials, dir: join(folder, "dsh"), folderAccess: null }) : new ClaudeRuntime({ store, profiles, credentials, providers: {}, claudeHome: join(folder, "claude"), localClaudeHome: join(folder, "local-claude") });
  const service = new HostService(store, runtime, profiles, { commonDir: join(folder, "common") });
  const workspace = store.addWorkspace({ name: "项目", path: folder });
  const task = store.createTask({ title: "执行", workspaceId: workspace.id });
  const session = store.createSession({ taskId: task.id, topicId: null, parentId: null, kind: "main", runtime: kind, profileId: "test", workspaceId: workspace.id, title: "执行", status: "idle", writer: "workbench", runtimeRef: "saved-runtime-ref" });
  service.sessions.inbox.pause(session.id);
  await service.sessions.inbox.put(session.id, "冻结旧消息", undefined, "i-native-old");
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const atGate = new Promise<void>((resolve) => { entered = resolve; });
  const transport = vi.fn();
  if (runtime instanceof DshRuntime) {
    const internal = runtime as unknown as { ensureLive(session: Session): Promise<unknown>; applyOptions(id: string, live: unknown): Promise<void> };
    const live = { inflight: false, auto: null, idleTimer: null, transcript: { openTurn: vi.fn() }, conn: { request: transport } };
    vi.spyOn(internal, "ensureLive").mockImplementation(async () => { if (seam === "dsh-resume") { entered(); await gate; } return live; });
    vi.spyOn(internal, "applyOptions").mockImplementation(async () => { if (seam === "dsh-options") { entered(); await gate; } });
  } else {
    const internal = runtime as unknown as { closing: Map<string, Promise<void>>; ensureLive(session: Session): ReturnType<typeof newLive> };
    const live = newLive(transport, () => undefined);
    if (seam === "claude-closing") internal.closing.set(session.id, gate.then(() => undefined));
    else live.ready = gate;
    vi.spyOn(internal, "ensureLive").mockImplementation(() => { entered(); return live; });
    if (seam === "claude-closing") entered();
  }
  const sending = service.sessions.resend(session.id, "i-native-old");
  await atGate;
  service.sessions.inbox.expire("i-native-old", "旧通知已过期：实际派发前版本变更");
  release();
  if (seam === "claude-ready") { await sending; await vi.waitFor(() => expect(store.getSession(session.id)?.status).toBe("idle")); }
  else await expect(sending).rejects.toThrow(/过期/);
  expect(transport).not.toHaveBeenCalled();
  expect(store.getItem("i-native-old")).toMatchObject({ delivery: "expired", deliveryReason: "旧通知已过期：实际派发前版本变更", text: expect.stringContaining("冻结旧消息") });
});

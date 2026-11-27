import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProfile, ProfileChoices, Session, Task, Workspace } from "@amo-studio/protocol";
import { removeTempDir, startFakeAppServer } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { startHostServer, type HostServer } from "../../http/server.js";

// PATCH /api/sessions/:id/options with 「Fast」 (stage 13): true / false are kept with the session, null clears it.

const fetch = (url: string, init: RequestInit = {}) => globalThis.fetch(url, { ...init, headers: { connection: "close", ...(init.headers as Record<string, string> | undefined) } });
const GPT = "codex-default";
const RELAY = { id: "ch-relay", label: "Relay", runtime: "codex", provider: "amo-ch-relay", model: null, custom: true } satisfies ModelProfile;
const PROFILES: ModelProfile[] = [
  { id: GPT, label: "GPT", runtime: "codex", provider: null, model: null },
  RELAY,
  { id: "claude", label: "Claude", runtime: "claude", provider: "anthropic", model: null },
];
const TOKEN = "test-host-token";

let root: string;
let store: Store;
let servers: FakeServers;
let http: HostServer;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-options-route-"));
  mkdirSync(join(root, "ws"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  const service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES);
  http = await startHostServer({ service, token: TOKEN, allowedOrigins: [] });
});

afterEach(async () => {
  await http.close();
  await servers.close();
  store.close();
  removeTempDir(root);
});

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${http.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, data: (await res.json()) as T };
}

describe("session options over HTTP", () => {
  it("keeps Fast on and off with the session, clears it with null, and refuses other values", async () => {
    const ws = (await api<Workspace>("POST", "/api/workspaces", { path: join(root, "ws") })).data;
    const { session } = (await api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "t", workspaceId: ws.id, firstSession: { profileId: GPT, options: { fast: true } } })).data;
    expect(session.options).toEqual({ fast: true });
    const path = `/api/sessions/${session.id}/options`;

    expect((await api<Session>("PATCH", path, { effort: "low" })).data.options).toEqual({ fast: true, effort: "low" });
    expect((await api<Session>("PATCH", path, { fast: false })).data.options).toEqual({ fast: false, effort: "low" });
    // Kept in the database.
    const reopened = new Store(join(root, "studio.db"));
    expect(reopened.getSession(session.id)!.options).toEqual({ fast: false, effort: "low" });
    reopened.close();
    expect((await api<Session>("PATCH", path, { fast: null })).data.options).toEqual({ effort: "low" });
    expect((await api("PATCH", path, { fast: "yes" })).status).toBe(400);
  });

  it.each([GPT, RELAY.id])("starts new sessions in %s at the channel's Fast tier and honors explicit standard speed", async (profileId) => {
    if (profileId === RELAY.id) servers.fakes.set(RELAY.id, await startFakeAppServer({ defaultProvider: RELAY.provider, speedTiers: true }));
    const ws = (await api<Workspace>("POST", "/api/workspaces", { path: join(root, "ws") })).data;
    expect((await api("PUT", "/api/settings", { modelPrefs: { [profileId]: { fast: true } } })).status).toBe(200);
    const choices = (await api<ProfileChoices>("GET", `/api/profiles/${profileId}/choices`)).data;
    expect(choices.defaultFast).toBe(true);
    const model = choices.models.find((m) => m.isDefault)!;
    expect(model.fast?.tier).toBe("priority");
    const options = { model: model.id, effort: "low", permission: choices.defaultPermission };
    const start = async (text: string, fast?: boolean) => {
      const response = await api<{ task: Task; session: Session }>("POST", "/api/tasks", {
        workspaceId: ws.id, firstSession: { profileId, text, options: { ...options, ...(fast !== undefined ? { fast } : {}) } },
      });
      expect(response.status).toBe(200);
      return response.data.session;
    };
    const inherited = await start("inherit Fast");
    expect(inherited.options.fast).toBe(true);
    expect((await start("use standard", false)).options.fast).toBe(false);

    expect((await api("PUT", "/api/settings", { modelPrefs: { [profileId]: null } })).status).toBe(200);
    expect((await start("inherit Codex")).options.fast).toBeUndefined();
    expect(store.getSession(inherited.id)?.options.fast).toBe(true);
    const tiers = servers.fakes.get(profileId)!.calls.filter((call) => call.method === "turn/start").map((call) => (call.params as { serviceTier?: string }).serviceTier);
    expect(tiers).toEqual(["priority", "default", undefined]);
  });

  it("refuses a channel Fast default for other runtimes", async () => {
    expect((await api("PUT", "/api/settings", { modelPrefs: { claude: { fast: true } } })).status).toBe(400);
  });
});

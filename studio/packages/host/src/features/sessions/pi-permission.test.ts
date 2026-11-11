import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ModelProfile } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { peerPermission } from "./service.js";

const choices = { permissions: [{ id: "full-access", label: "完全访问", description: "Pi" }], defaultPermission: "full-access" };

describe("Pi sub-session permissions", () => {
  it("refuses unsupported sandbox requests even when the caller has full access", () => {
    const caller = { runtime: "codex" as const, permission: "full-auto" };
    expect(() => peerPermission(caller, "pi", "read-only", choices)).toThrow(/Pi 暂不支持只读或工作区沙箱/);
    expect(() => peerPermission(caller, "pi", "write", choices)).toThrow(/Pi 暂不支持只读或工作区沙箱/);
    expect(peerPermission(caller, "pi", "full", choices)).toBe("full-access");
  });

  it("never widens a sandboxed caller to Pi, including an omitted permission or unavailable choices", () => {
    for (const [runtime, permission] of [["codex", "read-only"], ["codex", "workspace-write"], ["claude", "auto"], ["dsh", "workspace-write"]] as const) {
      const caller = { runtime, permission };
      expect(() => peerPermission(caller, "pi", null, choices)).toThrow(/开的 Pi 会话不能比你宽/);
      expect(() => peerPermission(caller, "pi", "full", null)).toThrow(/开的 Pi 会话不能比你宽/);
    }
  });

  it("retains a Pi caller's full-access level across runtimes and allows explicitly narrower child sessions", () => {
    const caller = { runtime: "pi" as const, permission: "full-access" };
    expect(peerPermission(caller, "pi", null, choices)).toBe("full-access");
    expect(peerPermission(caller, "codex", "full", null)).toBe("full-auto");
    expect(peerPermission(caller, "claude", "read-only", null)).toBe("plan");
    expect(peerPermission(caller, "dsh", "write", null)).toBe("workspace-write");
    expect(() => peerPermission(null, "pi", "read-only", choices)).toThrow(/Pi 暂不支持/);
  });

  it("refuses unverifiable delegation and keeps remote sandbox restrictions when Pi is allowed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "amo-studio-test-pi-permission-"));
    const profiles: ModelProfile[] = [{ id: "codex", label: "GPT", runtime: "codex", provider: null, model: null }, { id: "pi", label: "Pi", runtime: "pi", provider: null, model: null }];
    const store = new Store(join(dir, "studio.db"));
    const servers = new FakeServers(profiles);
    const service = new HostService(store, new CodexRuntime({ store, servers, profiles }), profiles, { commonDir: join(dir, "common") });
    try {
      const workspace = store.addWorkspace({ path: dir, name: "sandbox" });
      const task = store.createTask({ title: "permissions", workspaceId: workspace.id });
      const caller = store.createSession({ taskId: task.id, topicId: null, parentId: null, kind: "main", runtime: "codex", profileId: "codex", workspaceId: workspace.id, title: "caller", status: "idle", writer: "workbench", runtimeRef: null });
      const spy = vi.spyOn(service.config, "choices").mockRejectedValue(new Error("CLI unavailable"));
      await expect(service.sessions.optionsFor(caller.id, { model: "Pi" })).rejects.toThrow(/无法核验当前会话的权限/);
      store.updateSession(caller.id, { options: { permission: "full-auto" } });
      await expect(service.sessions.optionsFor(caller.id, { model: "Pi" })).resolves.toMatchObject({ profileId: "pi", options: { permission: "full-access" } });
      spy.mockRestore();

      for (const permission of ["read-only", "write"] as const) {
        service.remote.setAllowed({ profiles: ["pi"], defaultProfile: "pi", permission });
        expect(() => service.remote.grants.permissionFor("pi")).toThrow(/Pi 不支持远程设置要求/);
      }
      service.remote.setAllowed({ profiles: ["pi"], defaultProfile: "pi", permission: "full" });
      expect(service.remote.grants.permissionFor("pi")).toBe("full-access");
    } finally {
      await servers.close();
      store.close();
      removeTempDir(dir);
    }
  });
});

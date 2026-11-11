import { describe, expect, it } from "vitest";
import { exampleSessions, type Session } from "@amo-studio/protocol";
import { taskRunnerSkin } from "./TaskRunner.js";

const session = (patch: Partial<Session> = {}): Session => ({ ...exampleSessions[0]!, id: "runner", runtime: "claude", kind: "main", status: "running", archivedAt: null, createdAt: "2026-11-11T00:00:00Z", ...patch });

describe("task runner skin", () => {
  it("uses the orange runner only for Claude", () => {
    expect(taskRunnerSkin([session()])).toBe("claude");
    for (const runtime of ["codex", "dsh", "pi", "remote"] as const) expect(taskRunnerSkin([session({ runtime })])).toBe("default");
  });

  it("ignores archived and stopped Claude sessions", () => {
    expect(taskRunnerSkin([session({ archivedAt: "2026-11-11T01:00:00Z" }), session({ runtime: "codex" })])).toBe("default");
    expect(taskRunnerSkin([session({ status: "idle" }), session({ runtime: "codex" })])).toBe("default");
    expect(taskRunnerSkin([])).toBe("default");
  });

  it("keeps the running main session's skin when a different model runs a branch", () => {
    const main = session({ runtime: "codex" });
    const branch = session({ id: "branch", kind: "sub", createdAt: "2026-11-11T01:00:00Z" });
    expect(taskRunnerSkin([branch, main])).toBe("default");
    expect(taskRunnerSkin([{ ...main, status: "idle" }, branch])).toBe("claude");
  });

  it("uses the newest running main consistently regardless of input order", () => {
    const old = session({ runtime: "codex" });
    const latest = session({ id: "latest", createdAt: "2026-11-11T01:00:00Z" });
    expect(taskRunnerSkin([old, latest])).toBe("claude");
    expect(taskRunnerSkin([latest, old])).toBe("claude");
  });
});

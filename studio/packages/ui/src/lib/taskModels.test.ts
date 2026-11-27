import { describe, expect, it } from "vitest";
import { exampleSessions, type ModelProfile, type ProfileChoices, type Session } from "@amo-studio/protocol";
import { taskModelBadges, taskModelSessions } from "./task-models.js";

const session = (id: string, patch: Partial<Session> = {}): Session => ({ ...exampleSessions[0]!, id, profileId: "p", kind: "main", createdAt: "2026-11-16T00:00:00Z", archivedAt: null, options: {}, ...patch });
const profile: ModelProfile = { id: "p", label: "Claude 渠道", runtime: "claude", provider: null, model: null };
const offered: ProfileChoices = { profileId: "p", permissions: [], defaultPermission: "ask", source: "cli", models: [{ id: "default", label: "默认（Opus 5.5）", efforts: [], isDefault: true }, { id: "sonnet", label: "Sonnet", efforts: [] }] };
const choices = new Map([["p", offered]]);

describe("task model sessions", () => {
  it("uses the oldest live root main and ignores launched mains, archived mains, and branches", () => {
    const old = session("old");
    const next = session("next", { createdAt: "2026-11-16T01:00:00Z" });
    const delegated = session("delegated", { startedBy: "old", status: "running" });
    const branch = session("branch", { kind: "sub", status: "running" });
    const archived = session("archived", { archivedAt: "2026-11-16T02:00:00Z" });
    const input = [delegated, old, branch, archived, next];
    expect(taskModelSessions(input)).toEqual([old]);
    expect(input).toEqual([delegated, old, branch, archived, next]);
  });

  it("falls back to one live branch and resolves equal creation times consistently", () => {
    const fork = session("a", { kind: "fork" });
    const sub = session("b", { kind: "sub" });
    expect(taskModelSessions([fork, sub]).map((s) => s.id)).toEqual(["b"]);
    expect(taskModelSessions([sub, fork]).map((s) => s.id)).toEqual(["b"]);
  });

  it("falls back to the current launched main when no live root main remains", () => {
    const archivedRoot = session("root", { archivedAt: "2026-11-16T02:00:00Z" });
    const delegated = session("delegated", { startedBy: "root", createdAt: "2026-11-16T01:00:00Z" });
    expect(taskModelSessions([archivedRoot, delegated])).toEqual([delegated]);
  });

  it("shows one latest historical main, or a historical branch without any main", () => {
    const main = session("main", { archivedAt: "2026-11-16T02:00:00Z" });
    const branch = session("branch", { kind: "fork", archivedAt: "2026-11-16T02:00:00Z", createdAt: "2026-11-16T01:00:00Z" });
    expect(taskModelSessions([branch, main])).toEqual([main]);
    expect(taskModelSessions([branch])).toEqual([branch]);
    expect(taskModelSessions([])).toEqual([]);
  });
});

describe("task model badges", () => {
  it("resolves default names and deduplicates a chosen default with an implicit default", () => {
    const badges = taskModelBadges([session("a"), session("b", { options: { model: "default" } })], [profile], choices);
    expect(badges).toHaveLength(1);
    expect(badges[0]).toMatchObject({ name: "Opus 5.5", channel: "Claude 渠道" });
  });

  it("shows the root main model without adding models from launched sessions", () => {
    const another = { ...profile, id: "q", label: "另一个渠道" };
    const root = session("root", { options: { model: "sonnet" } });
    const delegated = session("delegated", { profileId: "q", startedBy: "root", options: { model: "sonnet" } });
    const badges = taskModelBadges([delegated, root], [profile, another], choices);
    expect(badges.map((b) => b.name)).toEqual(["Sonnet"]);
    expect(badges).toHaveLength(1);
  });

  it("keeps unknown explicit models instead of substituting the default, and uses the channel while choices load", () => {
    expect(taskModelBadges([session("a", { options: { model: "retired" } })], [profile], choices)[0]?.name).toBe("retired");
    expect(taskModelBadges([session("a", { options: { model: "custom" } })], [profile], new Map())[0]?.name).toBe("custom");
    expect(taskModelBadges([session("a")], [profile], new Map())[0]?.name).toBe("Claude 渠道");
    expect(taskModelBadges([], [profile], choices)).toEqual([]);
  });

  it("updates the visible model when session options change", () => {
    const before = session("a");
    expect(taskModelBadges([before], [profile], choices)[0]?.name).toBe("Opus 5.5");
    expect(taskModelBadges([{ ...before, options: { model: "sonnet" } }], [profile], choices)[0]?.name).toBe("Sonnet");
  });
});

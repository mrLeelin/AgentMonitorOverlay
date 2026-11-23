import { describe, expect, it } from "vitest";
import type { ProfileChoices } from "@amo-studio/protocol";
import { applyModelPrefs, fillDefaults } from "./model-prefs.js";

const choices: ProfileChoices = {
  profileId: "gpt",
  source: "cli",
  models: [
    { id: "sol", label: "Sol 6.1", efforts: ["low", "medium", "high"], defaultEffort: "medium", isDefault: true },
    { id: "luna", label: "Luna", efforts: ["low", "medium"], defaultEffort: "low" },
    { id: "new", label: "New", efforts: [] },
  ],
  permissions: [
    { id: "ask", label: "逐条询问", description: "" },
    { id: "auto", label: "帮我审批", description: "" },
  ],
  defaultPermission: "ask",
};

describe("model prefs", () => {
  it("orders the models (unknown ones after, as listed), moves the default and sets efforts and permissions", () => {
    const out = applyModelPrefs(choices, { order: ["luna", "gone", "sol"], model: "luna", effort: "high", permission: "auto" });
    expect(out.models.map((m) => m.id)).toEqual(["luna", "sol", "new"]);
    expect(out.models.filter((m) => m.isDefault).map((m) => m.id)).toEqual(["luna"]);
    // high only where the model takes it.
    expect(out.models.map((m) => m.defaultEffort)).toEqual(["low", "high", undefined]);
    expect(out.defaultPermission).toBe("auto");
  });

  it("skips prefs naming what the CLI no longer offers", () => {
    const out = applyModelPrefs(choices, { model: "gone", permission: "nope" });
    expect(out.models.find((m) => m.isDefault)?.id).toBe("sol");
    expect(out.defaultPermission).toBe("ask");
    expect(applyModelPrefs(choices, undefined)).toBe(choices);
  });

  it("fills a new session's unchosen options from the prefs, keeps what was chosen", () => {
    const prefs = { model: "luna", effort: "medium", permission: "auto" };
    expect(fillDefaults({}, applyModelPrefs(choices, prefs), prefs)).toEqual({ model: "luna", effort: "medium", permission: "auto" });
    expect(fillDefaults({ model: "sol", effort: "low" }, applyModelPrefs(choices, prefs), prefs)).toEqual({ model: "sol", effort: "low", permission: "auto" });
    // An effort the model does not take stays the model's own default.
    expect(fillDefaults({ model: "new" }, choices, { effort: "high" })).toEqual({ model: "new" });
    expect(fillDefaults({}, choices, undefined)).toEqual({});
  });

  it("hides models independently of ordering and picks a visible default for new sessions", () => {
    const prefs = { order: ["luna", "sol"], model: "sol", hidden: ["sol", "unlisted"], effort: "medium" };
    const out = applyModelPrefs(choices, prefs);
    expect(out.models.map((m) => m.id)).toEqual(["luna", "new"]);
    expect(out.hiddenModels?.map((m) => m.id)).toEqual(["sol"]);
    expect(out.models.find((m) => m.isDefault)?.id).toBe("luna");
    expect(fillDefaults({}, out, prefs)).toMatchObject({ model: "luna", effort: "medium" });
    expect(fillDefaults({ model: "sol" }, out, { ...prefs, effort: "high" })).toMatchObject({ model: "sol", effort: "high" });

    const restored = applyModelPrefs(choices, { ...prefs, hidden: ["unlisted"] });
    expect(restored.models.map((m) => m.id)).toEqual(["luna", "sol", "new"]);
    expect(restored.models.find((m) => m.isDefault)?.id).toBe("sol");
    expect(restored.hiddenModels).toBeUndefined();
  });

  it("keeps the native default available when the catalog only returns models marked hidden", () => {
    const prefs = { order: ["luna", "sol"], hidden: ["sol", "luna", "new"] };
    const out = applyModelPrefs(choices, prefs);
    expect(out.models.map((m) => m.id)).toEqual(["sol"]);
    expect(out.hiddenModels?.map((m) => m.id)).toEqual(["luna", "new"]);
    expect(fillDefaults({}, out, prefs)).toMatchObject({ model: "sol" });
  });
});

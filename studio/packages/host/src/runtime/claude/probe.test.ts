import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ query: vi.fn(), commands: vi.fn(), skills: vi.fn(), close: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mock.query }));
vi.mock("./executable.js", () => ({ requireClaudeCode: () => "C:/mock/claude.exe" }));
import { askCommandList } from "./probe.js";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDir } from "@amo-studio/testkit";
import { afterEach } from "vitest";

let root: string;

beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-skill-probe-"));
  mock.commands.mockResolvedValue([{ name: "context", description: "上下文", builtin: true }, { name: "release-notes", description: "写发布说明" }]);
  mock.skills.mockResolvedValue({ skills: [{ name: "release-notes", description: "写发布说明" }] });
  mock.query.mockReturnValue({ supportedCommands: mock.commands, reloadSkills: mock.skills, close: mock.close });
});
afterEach(() => removeTempDir(root));

describe("Claude first-message discovery", () => {
  it("uses the selected cwd/env and native skill list without yielding any model prompt", async () => {
    const cwd = join(root, "project"), home = join(root, "home");
    const dir = join(cwd, ".claude", "skills", "release-notes");
    mkdirSync(dir, { recursive: true }); mkdirSync(home);
    writeFileSync(join(dir, "SKILL.md"), "---\nname: release-notes\n---\n写发布说明。", "utf8");
    const env = { TEST_PROFILE: "selected", CLAUDE_CONFIG_DIR: home };
    const result = await askCommandList(env, cwd);
    expect(result.commands).toEqual([{ name: "context", description: "上下文", group: "runtime" }, { name: "release-notes", description: "写发布说明", group: "skill", skillPath: realpathSync(join(dir, "SKILL.md")) }]);
    const input = mock.query.mock.calls[0]![0];
    expect(input.options).toMatchObject({ cwd, env, settingSources: ["user", "project", "local"] });
    const prompts = [];
    for await (const prompt of input.prompt) prompts.push(prompt);
    expect(prompts).toEqual([]);
    expect(mock.close).toHaveBeenCalledOnce();
  });

  it("keeps commands and explains missing skill discovery on older CLIs", async () => {
    mock.skills.mockRejectedValue(new Error("unsupported reload_skills"));
    const result = await askCommandList({}, "C:/project");
    expect(result.commands).toHaveLength(2);
    expect(result.note).toContain("unsupported reload_skills");
    expect(mock.close).toHaveBeenCalledOnce();
  });

  it("closes the probe when command discovery fails", async () => {
    mock.commands.mockRejectedValue(new Error("CLI failed"));
    await expect(askCommandList({}, "C:/project")).rejects.toThrow("CLI failed");
    expect(mock.close).toHaveBeenCalledOnce();
  });
});

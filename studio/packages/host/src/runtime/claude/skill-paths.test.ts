import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SlashCommand } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { claudeSkillPaths } from "./skill-paths.js";

let root: string, cwd: string, home: string;
const skill = (name: string): SlashCommand => ({ name, description: "已由 CLI 确认可用", group: "skill" });
function writeSkill(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(file, `---\nname: ${name}\ndescription: 示例\n---\n技能正文。`, "utf8");
  return realpathSync(file);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-skill-paths-"));
  cwd = join(root, "project", "src"); home = join(root, "home");
  mkdirSync(cwd, { recursive: true }); mkdirSync(home);
});
afterEach(() => removeTempDir(root));

describe("Claude native skill source lookup", () => {
  it("resolves current project ancestor and selected home files by actual skill name", async () => {
    const project = writeSkill(join(root, "project", ".claude", "skills", "folder-name"), "release-notes");
    const user = writeSkill(join(home, "skills", "review"), "review");
    expect(await claudeSkillPaths([skill("release-notes"), skill("review")], cwd, home)).toEqual([
      { ...skill("release-notes"), skillPath: project }, { ...skill("review"), skillPath: user },
    ]);
  });

  it("resolves a namespaced plugin skill from recorded install paths", async () => {
    const plugin = join(root, "plugin");
    const file = writeSkill(join(plugin, "skills", "review"), "review");
    mkdirSync(join(home, "plugins"));
    writeFileSync(join(home, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "my-plugin@market": [{ installPath: plugin, scope: "user" }] } }));
    expect(await claudeSkillPaths([skill("my-plugin:review")], cwd, home)).toEqual([{ ...skill("my-plugin:review"), skillPath: file }]);
  });

  it("omits ambiguous, missing and unrelated custom command paths", async () => {
    writeSkill(join(root, "project", ".claude", "skills", "review"), "review");
    writeSkill(join(home, "skills", "review"), "review");
    const commands: SlashCommand[] = [skill("review"), skill("missing"), { name: "review", description: "custom", group: "custom" }];
    expect(await claudeSkillPaths(commands, cwd, home)).toEqual(commands);
  });

  it("does not use another project's plugin install record", async () => {
    const plugin = join(root, "plugin");
    writeSkill(join(plugin, "skills", "review"), "review");
    mkdirSync(join(home, "plugins"));
    writeFileSync(join(home, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "my-plugin@market": [{ installPath: plugin, scope: "project", projectPath: join(root, "other-project") }] } }));
    expect(await claudeSkillPaths([skill("my-plugin:review")], cwd, home)).toEqual([skill("my-plugin:review")]);
  });
});

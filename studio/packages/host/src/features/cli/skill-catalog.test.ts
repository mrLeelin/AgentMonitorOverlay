import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDir } from "@amo-studio/testkit";
import { readSkillCatalog, scanSkillSource, skillMetadata } from "./skill-catalog.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "amo-studio-test-skill-catalog-")); });
afterEach(() => { removeTempDir(root); });
function skill(dir: string, body = "---\nname: local-skill\ndescription: 本地技能说明\n---\n# Instructions\n"): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  writeFileSync(path, body, "utf8");
  return realpathSync(path);
}

describe("skill catalog metadata", () => {
  it("reads quoted and block scalars without treating Markdown or comments as metadata", () => {
    expect(skillMetadata('\uFEFF---\r\nname: "release"\r\ndescription: >-\r\n  写发布说明\r\n  并核对改动\r\n---\r\nname: ignored', "folder")).toEqual({ name: "release", description: "写发布说明 并核对改动", diagnostics: [] });
    expect(skillMetadata("---\nname: 'it''s-valid'\ndescription: text # ignored\n---\n", "folder")).toEqual({ name: "it's-valid", description: "text", diagnostics: [] });
  });

  it("keeps incomplete skills visible with concrete diagnostics", () => {
    expect(skillMetadata("# no metadata", "folder")).toEqual({ name: "folder", description: "", diagnostics: ["缺少有效的 YAML 元数据（---）"] });
    expect(skillMetadata("---\nname:\n---\n", "folder").diagnostics).toHaveLength(2);
  });
});

describe("local skill discovery", () => {
  it("separates user sources, system skills and plugin caches, honoring explicit tool homes", async () => {
    const shared = skill(join(root, ".agents", "skills", "release"));
    const codexHome = join(root, "custom-codex");
    const system = skill(join(codexHome, "skills", ".system", "setup"));
    const plugin = skill(join(codexHome, "plugins", "cache", "market", "package", "1.0", "skills", "review"));
    const claudeHome = join(root, "custom-claude");
    const claude = skill(join(claudeHome, "skills", "review"));
    skill(join(root, ".codex", "skills", "should-not-be-read"));
    const result = await readSkillCatalog({ home: root, env: { CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome } });
    expect(result.scope).toBe("global");
    expect(result.workspaceId).toBeNull();
    expect(result.sources.find((s) => s.id === "agents")?.skills.map((s) => s.path)).toEqual([shared]);
    expect(result.sources.find((s) => s.id === "codex")?.skills.map((s) => s.path)).toEqual([system]);
    expect(result.sources.find((s) => s.id === "claude")?.skills.map((s) => s.path)).toEqual([claude]);
    expect(result.sources.find((s) => s.id === "codex-plugins")?.skills.map((s) => s.path)).toEqual([plugin]);
    expect(result.sources.find((s) => s.id === "cursor")).toMatchObject({ exists: false, skills: [], diagnostics: [] });
  });

  it("scans only the selected project and ignores user tool-home overrides", async () => {
    const project = join(root, "project");
    const path = skill(join(project, ".claude", "skills", "local"));
    skill(join(root, "user", "skills", "global"));
    const result = await readSkillCatalog({ workspace: { id: "ws-project", path: project }, home: root, env: { CLAUDE_CONFIG_DIR: join(root, "user") } });
    expect(result).toMatchObject({ scope: "project", workspaceId: "ws-project" });
    expect(result.sources.flatMap((s) => s.skills).map((s) => s.path)).toEqual([path]);
    expect(result.sources.some((s) => s.id.endsWith("plugins"))).toBe(false);
  });

  it("uses the distinct project and user discovery directories of OpenCode, Pi and Windsurf", async () => {
    const project = join(root, "project");
    const userOpenCode = skill(join(root, ".config", "opencode", "skills", "user"));
    const userPi = skill(join(root, ".pi", "agent", "skills", "user"));
    const userWindsurf = skill(join(root, ".codeium", "windsurf", "skills", "user"));
    const projectOpenCode = skill(join(project, ".opencode", "skills", "project"));
    const projectPi = skill(join(project, ".pi", "skills", "project"));
    const projectWindsurf = skill(join(project, ".windsurf", "skills", "project"));
    skill(join(project, ".config", "opencode", "skills", "wrong-project-path"));
    skill(join(project, ".pi", "agent", "skills", "wrong-project-path"));
    skill(join(project, ".codeium", "windsurf", "skills", "wrong-project-path"));
    skill(join(root, ".windsurf", "skills", "wrong-user-path"));
    const global = await readSkillCatalog({ home: root, env: {} });
    const local = await readSkillCatalog({ workspace: { id: "project", path: project }, home: root, env: {} });
    expect(global.sources.find((s) => s.id === "opencode")?.skills.map((s) => s.path)).toEqual([userOpenCode]);
    expect(global.sources.find((s) => s.id === "pi")?.skills.map((s) => s.path)).toEqual([userPi]);
    expect(global.sources.find((s) => s.id === "windsurf")?.skills.map((s) => s.path)).toEqual([userWindsurf]);
    expect(local.sources.find((s) => s.id === "opencode")?.skills.map((s) => s.path)).toEqual([projectOpenCode]);
    expect(local.sources.find((s) => s.id === "pi")?.skills.map((s) => s.path)).toEqual([projectPi]);
    expect(local.sources.find((s) => s.id === "windsurf")?.skills.map((s) => s.path)).toEqual([projectWindsurf]);
  });

  it("follows shared directory links once and stops cycles", async () => {
    const source = join(root, "skills");
    const target = join(root, "shared");
    const path = skill(join(target, "real"));
    mkdirSync(source);
    const type = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(target, join(source, "one"), type);
    symlinkSync(target, join(source, "two"), type);
    symlinkSync(source, join(target, "cycle"), type);
    const result = await scanSkillSource("test", "Test", source);
    expect(result.skills.map((s) => s.path)).toEqual([path]);
    expect(result.diagnostics).toEqual([]);
  });

  it("reports oversized skills and bounded recursion without descending into skill resources", async () => {
    const source = join(root, "skills");
    skill(join(source, "oversized"), "x".repeat(256 * 1024 + 1));
    const normal = skill(join(source, "normal"));
    skill(join(source, "normal", "scripts", "nested-not-a-skill"));
    skill(join(source, "a", "b", "c", "d", "e", "f", "g", "too-deep"));
    const result = await scanSkillSource("test", "Test", source);
    expect(result.skills).toHaveLength(2);
    expect(result.skills.find((s) => s.path === normal)?.diagnostics).toEqual([]);
    expect(result.skills.find((s) => s.name === "oversized")?.diagnostics).toEqual(["SKILL.md 超过 256 KB，未读取"]);
    expect(result.diagnostics).toContain("目录过深或条目过多，已停止扫描；列表可能不完整");
  });
});

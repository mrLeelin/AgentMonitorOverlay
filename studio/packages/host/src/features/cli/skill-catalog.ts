import { open, opendir, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type { CatalogSkill, SkillCatalog, SkillSource } from "@amo-studio/protocol";

const MAX_ENTRIES = 6000;
const MAX_DEPTH = 6;
const MAX_SKILL_BYTES = 256 * 1024;
const SKIP = new Set([".git", "node_modules"]);
const SOURCES = [
  ["agents", "公共 Agent", ".agents", "skills"],
  ["codex", "Codex", ".codex", "skills"],
  ["claude", "Claude Code", ".claude", "skills"],
  ["dsh", "DSH", ".dsh", "skills"],
  ["gemini", "Gemini", ".gemini", "skills"],
  ["opencode", "OpenCode", ".config", "opencode", "skills"],
  ["cursor", "Cursor", ".cursor", "skills"],
  ["windsurf", "Windsurf", ".codeium", "windsurf", "skills"],
  ["trae", "Trae", ".trae", "skills"],
  ["roo", "Roo", ".roo", "skills"],
  ["pi", "Pi", ".pi", "agent", "skills"],
  ["cc-switch", "CC Switch", ".cc-switch", "skills"],
] as const;
// These tools keep user configuration under different directories from their project sources.
const PROJECT_PARTS: Record<string, readonly string[]> = { opencode: [".opencode", "skills"], pi: [".pi", "skills"], windsurf: [".windsurf", "skills"] };

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const reason = (error: unknown): string => (error as NodeJS.ErrnoException)?.code ?? "读取失败";

/** Only the display metadata is parsed; a skill's Markdown is never executed or treated as configuration. */
export function skillMetadata(body: string, fallback: string): Pick<CatalogSkill, "name" | "description" | "diagnostics"> {
  const diagnostics: string[] = [];
  const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body)?.[1];
  if (frontmatter === undefined) return { name: fallback, description: "", diagnostics: ["缺少有效的 YAML 元数据（---）"] };
  const lines = frontmatter.split(/\r?\n/);
  const scalar = (key: string): string => {
    const index = lines.findIndex((line) => line.startsWith(`${key}:`));
    if (index < 0) return "";
    const value = lines[index]!.slice(key.length + 1).trim();
    if (/^[>|][-+]?\s*(?:#.*)?$/.test(value)) {
      const block: string[] = [];
      for (let i = index + 1; i < lines.length; i++) {
        const line = lines[i]!;
        if (line && !/^\s/.test(line)) break;
        block.push(line.trim());
      }
      return block.join(value.startsWith(">") ? " " : "\n").trim();
    }
    if (value.startsWith('"') && value.endsWith('"')) {
      try { return String(JSON.parse(value)); } catch { return value.slice(1, -1); }
    }
    if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
    return value.replace(/\s+#.*$/, "").trim();
  };
  const name = scalar("name");
  const description = scalar("description");
  if (!name) diagnostics.push("缺少 name，使用文件夹名称");
  if (!description) diagnostics.push("缺少 description");
  return { name: name || fallback, description, diagnostics };
}

/** Bounded walk follows shared skill links, with realpath-based cycle detection and per-source deduplication. */
export async function scanSkillSource(id: string, name: string, root: string): Promise<SkillSource> {
  const source: SkillSource = { id, name, root, exists: false, skills: [], diagnostics: [] };
  const visited = new Set<string>();
  const files = new Set<string>();
  const bytes = Buffer.alloc(MAX_SKILL_BYTES + 1);
  let remaining = MAX_ENTRIES;
  let truncated = false;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (remaining-- <= 0) { truncated = true; return; }
    let resolved: string;
    try {
      resolved = await realpath(dir);
      if (visited.has(resolved)) return;
      if (!(await stat(resolved)).isDirectory()) return;
      visited.add(resolved);
      if (dir === root) source.exists = true;
    } catch (error) {
      if (dir !== root || !missing(error)) source.diagnostics.push(`${dir}：${reason(error)}`);
      return;
    }
    const path = join(resolved, "SKILL.md");
    let found = false;
    try {
      const info = await stat(path);
      found = true;
      const actual = await realpath(path);
      if (files.has(actual)) return;
      files.add(actual);
      if (!info.isFile() || info.size > MAX_SKILL_BYTES) {
        source.skills.push({ name: basename(dir), description: "", path: actual, diagnostics: [!info.isFile() ? "SKILL.md 不是普通文件" : "SKILL.md 超过 256 KB，未读取"] });
        return;
      }
      const file = await open(path, "r");
      try {
        // Read a bounded buffer even if another process grows the file after stat.
        const result = await file.read(bytes, 0, bytes.length, 0);
        source.skills.push({ path: actual, ...skillMetadata(bytes.subarray(0, result.bytesRead).toString("utf8"), basename(dir)), ...(result.bytesRead > MAX_SKILL_BYTES ? { diagnostics: ["SKILL.md 超过 256 KB，内容已截断"] } : {}) });
      } finally { await file.close(); }
    } catch (error) {
      if (!missing(error)) { found = true; source.diagnostics.push(`${path}：${reason(error)}`); }
    }
    // Skill resources can contain arbitrary trees; only source/namespace folders need recursion.
    if (found) return;
    if (!depth) { truncated = true; return; }
    try {
      const entries = await opendir(resolved);
      for await (const entry of entries) {
        if (remaining-- <= 0) { truncated = true; break; }
        if (!SKIP.has(entry.name) && (entry.isDirectory() || entry.isSymbolicLink())) await walk(join(dir, entry.name), depth - 1);
      }
    } catch (error) { source.diagnostics.push(`${dir}：${reason(error)}`); }
  };
  await walk(root, MAX_DEPTH);
  if (truncated) source.diagnostics.push("目录过深或条目过多，已停止扫描；列表可能不完整");
  source.skills.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  return source;
}

export async function readSkillCatalog(options: { workspace?: { id: string; path: string }; home?: string; env?: NodeJS.ProcessEnv; codexHome?: string; claudeHome?: string } = {}): Promise<SkillCatalog> {
  const base = options.workspace?.path ?? options.home ?? homedir();
  const env = options.env ?? process.env;
  const overrides: Record<string, string | undefined> = options.workspace ? {} : { codex: options.codexHome || env.CODEX_HOME?.trim(), claude: options.claudeHome || env.CLAUDE_CONFIG_DIR?.trim(), dsh: env.DSH_HOME?.trim() };
  const sources: SkillSource[] = [];
  for (const [id, name, ...parts] of SOURCES) {
    const relative = options.workspace ? PROJECT_PARTS[id] ?? parts : parts;
    sources.push(await scanSkillSource(id, name, overrides[id] ? join(overrides[id]!, "skills") : join(base, ...relative)));
  }
  if (!options.workspace) {
    sources.push(await scanSkillSource("codex-plugins", "Codex 插件缓存", join(overrides.codex || join(base, ".codex"), "plugins", "cache")));
    sources.push(await scanSkillSource("claude-plugins", "Claude 插件缓存", join(overrides.claude || join(base, ".claude"), "plugins", "cache")));
  }
  return { scope: options.workspace ? "project" : "global", workspaceId: options.workspace?.id ?? null, sources, notes: ["这里展示磁盘上的技能；是否可用取决于对应工具的加载目录和设置。"] };
}

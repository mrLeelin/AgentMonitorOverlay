import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { SlashCommand } from "@amo-studio/protocol";

/** The SDK advertises skill names, not source paths. Resolve only unique files in this runtime's known sources. */
export async function claudeSkillPaths(commands: readonly SlashCommand[], cwd: string, home: string, withSource = false): Promise<SlashCommand[]> {
  const wanted = new Set(commands.filter((command) => command.group === "skill" && !command.skillPath).map((command) => command.name));
  if (!wanted.size) return [...commands];
  const roots = new Map<string, { scope: "global" | "project"; pluginId?: string }>();
  const ancestors = new Set<string>();
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    // The OS user's .claude is a user source, not a project ancestor when CLAUDE_CONFIG_DIR selects another home.
    if (dir === resolve(homedir())) break;
    ancestors.add(dir);
    roots.set(join(dir, ".claude", "skills"), { scope: "project" });
    if (dirname(dir) === dir) break;
  }
  roots.set(join(home, "skills"), { scope: "global" });
  try {
    const installed = JSON.parse(await readFile(join(home, "plugins", "installed_plugins.json"), "utf8")) as { plugins?: Record<string, Array<{ installPath?: string; projectPath?: string }>> };
    for (const [id, entries] of Object.entries(installed.plugins ?? {})) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (typeof entry.installPath !== "string" || !isAbsolute(entry.installPath)) continue;
        if (entry.projectPath && !ancestors.has(resolve(entry.projectPath))) continue;
        const source = { scope: entry.projectPath ? "project" as const : "global" as const, pluginId: id };
        roots.set(join(entry.installPath, "skills"), source);
        if ((await stat(join(entry.installPath, "SKILL.md")).catch(() => undefined))?.isFile()) roots.set(entry.installPath, source);
        try {
          const manifest = JSON.parse(await readFile(join(entry.installPath, ".claude-plugin", "plugin.json"), "utf8")) as { skills?: unknown };
          const extra = Array.isArray(manifest.skills) ? manifest.skills : [manifest.skills];
          for (const field of extra) {
            if (typeof field !== "string" || isAbsolute(field)) continue;
            const dir = resolve(entry.installPath, field);
            const part = relative(entry.installPath, dir);
            if (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part)) roots.set(dir, source);
          }
        } catch { /* The default skills directory also works without a manifest. */ }
      }
    }
  } catch { /* No installed plugin records in this runtime's configuration directory. */ }
  const matches = new Map<string, Map<string, Pick<SlashCommand, "skillPath" | "skillScope" | "skillPluginId">>>();
  let remaining = 2000;
  const scan = async (dir: string, source: { scope: "global" | "project"; pluginId?: string }, depth: number): Promise<void> => {
    if (remaining-- <= 0) return;
    try {
      const skill = join(dir, "SKILL.md");
      const body = await readFile(skill, "utf8");
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body)?.[1] ?? "";
      const declared = /^name:\s*["']?([A-Za-z0-9][\w:.-]*)["']?\s*$/m.exec(frontmatter)?.[1];
      const names = new Set([declared ?? basename(dir)]);
      if (source.pluginId) for (const name of [...names]) names.add(`${source.pluginId.split("@")[0]}:${name}`);
      const file = await realpath(skill);
      for (const name of names) {
        if (!wanted.has(name)) continue;
        const candidates = matches.get(name) ?? new Map();
        candidates.set(file, { skillPath: file, skillScope: source.scope, ...(source.pluginId ? { skillPluginId: source.pluginId } : {}) });
        matches.set(name, candidates);
      }
      return;
    } catch { /* A source root or namespace folder can contain skill directories rather than a skill itself. */ }
    if (!depth) return;
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory() || entry.isSymbolicLink()) await scan(join(dir, entry.name), source, depth - 1);
    }
  };
  for (const [root, source] of roots) await scan(root, source, 4);
  if (remaining < 0) return [...commands]; // A truncated scan cannot establish that a candidate is unique.
  return commands.map((command) => {
    const candidates = matches.get(command.name);
    const match = command.group === "skill" && candidates?.size === 1 ? candidates.values().next().value : undefined;
    return match ? { ...command, ...(withSource ? match : { skillPath: match.skillPath }) } : command;
  });
}

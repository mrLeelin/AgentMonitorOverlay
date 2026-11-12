import { readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { SlashCommand } from "@amo-studio/protocol";

/** The SDK advertises skill names, not source paths. Resolve only unique files in this runtime's known sources. */
export async function claudeSkillPaths(commands: readonly SlashCommand[], cwd: string, home: string): Promise<SlashCommand[]> {
  const wanted = new Set(commands.filter((command) => command.group === "skill" && !command.skillPath).map((command) => command.name));
  if (!wanted.size) return [...commands];
  const roots = new Map<string, string | undefined>();
  const ancestors = new Set<string>();
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    // The OS user's .claude is a user source, not a project ancestor when CLAUDE_CONFIG_DIR selects another home.
    if (dir === resolve(homedir())) break;
    ancestors.add(dir);
    roots.set(join(dir, ".claude", "skills"), undefined);
    if (dirname(dir) === dir) break;
  }
  roots.set(join(home, "skills"), undefined);
  try {
    const installed = JSON.parse(await readFile(join(home, "plugins", "installed_plugins.json"), "utf8")) as { plugins?: Record<string, Array<{ installPath?: string; projectPath?: string }>> };
    for (const [id, entries] of Object.entries(installed.plugins ?? {})) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (typeof entry.installPath !== "string" || !isAbsolute(entry.installPath)) continue;
        if (entry.projectPath && !ancestors.has(resolve(entry.projectPath))) continue;
        roots.set(join(entry.installPath, "skills"), id.split("@")[0]);
      }
    }
  } catch { /* No installed plugin records in this runtime's configuration directory. */ }
  const matches = new Map<string, Set<string>>();
  let remaining = 2000;
  const scan = async (dir: string, namespace: string | undefined, depth: number): Promise<void> => {
    if (remaining-- <= 0) return;
    try {
      const source = join(dir, "SKILL.md");
      const body = await readFile(source, "utf8");
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body)?.[1] ?? "";
      const declared = /^name:\s*["']?([A-Za-z0-9][\w:.-]*)["']?\s*$/m.exec(frontmatter)?.[1];
      const names = new Set([declared ?? basename(dir)]);
      if (namespace) for (const name of [...names]) names.add(`${namespace}:${name}`);
      const file = await realpath(source);
      for (const name of names) {
        if (!wanted.has(name)) continue;
        const candidates = matches.get(name) ?? new Set<string>();
        candidates.add(file);
        matches.set(name, candidates);
      }
      return;
    } catch { /* A source root or namespace folder can contain skill directories rather than a skill itself. */ }
    if (!depth) return;
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory() || entry.isSymbolicLink()) await scan(join(dir, entry.name), namespace, depth - 1);
    }
  };
  for (const [root, namespace] of roots) await scan(root, namespace, 4);
  if (remaining < 0) return [...commands]; // A truncated scan cannot establish that a candidate is unique.
  return commands.map((command) => {
    const candidates = matches.get(command.name);
    return command.group === "skill" && candidates?.size === 1 ? { ...command, skillPath: [...candidates][0]! } : command;
  });
}

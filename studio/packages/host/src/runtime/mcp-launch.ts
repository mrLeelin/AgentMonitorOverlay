import type { McpServerSpec } from "@amo-studio/protocol";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, resolve } from "node:path";

// MCP 设置 (2026-11-04, plans/done/mcp.md): what a runtime starts a session's process with besides `amo`. Worked out by the
// MCP feature (features/mcp/service.ts launch); here so the runtimes need not import a feature.

export interface McpLaunch {
  /** Servers passed to the CLI explicitly, secrets filled in. */
  explicit: Record<string, McpServerSpec>;
  /** Claude in the person's own config dir: the CLI loads their servers itself; these names are denied to it. */
  deny: string[];
  /** Claude, same: .mcp.json servers approved for this process. */
  enableJson: string[];
  /** Claude: load only the explicit ones (strictMcpConfig). */
  strict: boolean;
}

/** A session not made yet: its project and its own choices. */
export interface McpDraft {
  workspaceId: string;
  mcp?: Record<string, boolean>;
}

/** What a runtime asks the MCP feature. `native`: Claude in the person's own config dir (see launch). */
export interface McpSource {
  /** For a session, or one about to be made (DSH asks before the session exists). */
  launch(target: string | McpDraft, native: boolean): McpLaunch;
  /** Claude: the statuses its process reported. */
  noteStatus?(sessionId: string, list: ReadonlyArray<{ name: string; status: string; source?: string; error?: string }>): void;
}

const sorted = (xs: readonly string[]) => [...xs].sort().join("\n");

/** Whether two launches differ in what only a new process can take (Claude: strict, denied and approved names). */
export function sameProcessPart(a: McpLaunch, b: McpLaunch): boolean {
  return a.strict === b.strict && sorted(a.deny) === sorted(b.deny) && sorted(a.enableJson) === sorted(b.enableJson);
}

/** A spec as the Claude Agent SDK's mcpServers takes it. */
export function sdkServer(spec: McpServerSpec): Record<string, unknown> {
  if (spec.type === "stdio") return { type: "stdio", command: spec.command ?? "", ...(spec.args?.length ? { args: spec.args } : {}), ...(spec.env ? { env: spec.env } : {}) };
  return { type: spec.type, url: spec.url ?? "", ...(spec.headers ? { headers: spec.headers } : {}) };
}

/** A spec as ACP's session/new and session/resume take it (DSH). */
export function acpServer(name: string, spec: McpServerSpec, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Record<string, unknown> {
  if (spec.type === "stdio") return { name, command: acpCommand(name, spec, env, cwd), args: spec.args ?? [], env: Object.entries(spec.env ?? {}).map(([k, value]) => ({ name: k, value })) };
  return { type: spec.type, name, url: spec.url ?? "", headers: Object.entries(spec.headers ?? {}).map(([k, value]) => ({ name: k, value })) };
}

/** ACP rejects bare commands before starting any MCP (2026-11-07); Claude's config commonly has node/npx/codegraph. */
function acpCommand(name: string, spec: McpServerSpec, env: NodeJS.ProcessEnv, cwd: string): string {
  const command = spec.command ?? "";
  if (isAbsolute(command)) return command;
  const windows = process.platform === "win32";
  const vars = { ...env, ...spec.env };
  const variable = (key: string) => windows ? Object.entries(vars).reverse().find(([k]) => k.toUpperCase() === key)?.[1] : vars[key];
  const names = windows && !extname(command) ? (variable("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((ext) => command + ext.toLowerCase()) : [command];
  const dirs = /[\\/]/.test(command) ? [cwd] : (variable("PATH") ?? "").split(delimiter).filter(Boolean).map((dir) => dir.replace(/^"(.*)"$/, "$1"));
  if (command) for (const dir of dirs) for (const candidate of names) {
    const file = resolve(cwd, dir, candidate);
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, windows ? constants.F_OK : constants.X_OK);
      return file;
    } catch { /* Try the next PATH entry. */ }
  }
  throw new Error(`DSH 的 MCP「${name}」找不到启动命令「${command}」：请在 MCP 设置中填写程序的绝对路径，或把它加入 PATH`);
}

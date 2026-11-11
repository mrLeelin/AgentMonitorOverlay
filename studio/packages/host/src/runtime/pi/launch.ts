import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { resolveNode } from "../dsh/install.js";

export interface PiCommand {
  command: string;
  args: string[];
}

/** Pi renamed its npm scope; both published layouts are still in use. */
export const PI_PACKAGES = ["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"] as const;

const isFile = (file: string): boolean => {
  try { return statSync(file).isFile(); } catch { return false; }
};

/** Resolve npm's Windows shim to its Node entry point: spawning .cmd needs a shell, which RPC must not use. */
function npmEntry(shim: string): string | null {
  for (const name of PI_PACKAGES) {
    const root = join(dirname(shim), "node_modules", name);
    try {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { bin?: string | Record<string, string> };
      const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
      if (typeof bin !== "string" || !bin) continue;
      const entry = resolve(root, bin), rel = relative(root, entry);
      if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) continue;
      if (isFile(entry)) return entry;
    } catch { /* Another Pi distribution, or an incomplete installation. */ }
  }
  return null;
}

/** Locate an installed Pi without running it, changing its configuration, or opening a terminal. */
export function resolvePiCommand(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): PiCommand | null {
  const windows = platform === "win32";
  for (const value of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    const dir = value.replace(/^"(.*)"$/, "$1");
    if (!dir) continue;
    const binary = join(dir, windows ? "pi.exe" : "pi");
    if (isFile(binary)) return { command: binary, args: [] };
    if (!windows) continue;
    const shim = join(dir, "pi.cmd");
    if (!isFile(shim)) continue;
    const entry = npmEntry(shim), node = resolveNode(env);
    if (entry && node && isFile(node)) return { command: node, args: [entry] };
  }
  return null;
}

export function piUnavailable(env: NodeJS.ProcessEnv = process.env): string | null {
  return resolvePiCommand(env) ? null : "没有找到 Pi：请先安装 Pi，并把 pi 加入 PATH；安装后重新打开 Studio。";
}

export const PI_MCP_SERVERS_ENV = "AMO_PI_MCP_SERVERS";

// The source is constant: session credentials live only in the child's environment, never in this file or Pi's home.
const MCP_EXTENSION = `export default function (pi) {
  const servers = JSON.parse(process.env.AMO_PI_MCP_SERVERS || "{}");
  delete process.env.AMO_PI_MCP_SERVERS;
  if (!Object.keys(servers).length) return;
  const registrations = [];
  let active = false;
  // pi-mcp-adapter replaces the built-in connector. Its documented event API is available only after all extensions load.
  pi.on("session_start", () => {
    if (active) return;
    active = true;
    for (const [name, config] of Object.entries(servers)) {
      const definition = config.url
        ? { url: config.url, ...(config.headers ? { headers: config.headers } : {}), httpTransport: "streamable-http", lifecycle: "eager" }
        : { command: config.command, args: config.args || [], ...(config.env ? { env: config.env } : {}), lifecycle: "eager" };
      const request = { version: 1, name, definition };
      pi.events.emit("pi-mcp-adapter:runtime-register:v1", request);
      if (request.result) {
        if (!request.result.ok) throw request.result.error;
        registrations.push(() => request.result.registration.dispose());
      } else {
        if (typeof pi.registerMcpServer !== "function") throw new Error("这个 Pi 版本不支持 Studio 的 MCP 接入，请升级 Pi 后重试。");
        pi.registerMcpServer(name, config);
        registrations.push(() => pi.unregisterMcpServer?.(name));
      }
    }
  });
  pi.on("session_shutdown", async () => {
    active = false;
    await Promise.all(registrations.splice(0).map((dispose) => dispose()));
  });
}
`;

/** A session-only extension, outside the program folder; the user's Pi and project files remain untouched. */
export function piMcpExtension(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "amo-mcp.mjs");
  if (!existsSync(file) || readFileSync(file, "utf8") !== MCP_EXTENSION) writeFileSync(file, MCP_EXTENSION, "utf8");
  return file;
}

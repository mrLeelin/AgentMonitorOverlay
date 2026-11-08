import { execFile } from "node:child_process";
import { connect } from "node:net";
import type { NetworkSettings, NetworkTestResult } from "@amo-studio/protocol";

export const NETWORK_KEY = "settings:network";
type Kv = { getKv(key: string): { value: string } | undefined };

export function checkNetwork(value: unknown): NetworkSettings {
  const v = value as Partial<NetworkSettings> | null;
  if (!v || !["inherit", "manual", "direct"].includes(v.mode ?? "")) throw new Error("请选择网络连接方式");
  if (v.mode !== "manual") return { mode: v.mode!, proxyUrl: "" };
  let url: URL;
  try { url = new URL(typeof v.proxyUrl === "string" ? v.proxyUrl.trim() : ""); } catch { throw new Error("请输入完整代理地址，例如 http://127.0.0.1:7890"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("代理地址仅支持 HTTP / HTTPS，不含账号、密码或路径");
  return { mode: "manual", proxyUrl: url.origin };
}

export function readNetwork(kv: Kv): NetworkSettings {
  try { return checkNetwork(JSON.parse(kv.getKv(NETWORK_KEY)?.value ?? "null")); } catch { return { mode: "inherit", proxyUrl: "" }; }
}

/** Override both cases: inherited lowercase variables otherwise silently outrank a manual choice on some clients. */
export function networkEnv(settings: NetworkSettings, inherited: Record<string, string>): Record<string, string>;
export function networkEnv(settings: NetworkSettings, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function networkEnv(settings: NetworkSettings, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...inherited };
  const bypass = Object.entries(env).find(([k]) => k.toLowerCase() === "no_proxy")?.[1];
  if (settings.mode !== "inherit") {
    for (const k of Object.keys(env)) if (/^(https?_proxy|all_proxy|no_proxy)$/i.test(k)) delete env[k];
    if (settings.mode === "manual") {
      env.HTTP_PROXY = env.http_proxy = settings.proxyUrl;
      env.HTTPS_PROXY = env.https_proxy = settings.proxyUrl;
    }
  }
  env.NO_PROXY = env.no_proxy = [...new Set([...(bypass ?? "").split(",").map((s) => s.trim()).filter(Boolean), "localhost", "127.0.0.1", "::1", "[::1]"])].join(",");
  return env;
}

export function agentNetworkEnv(kv: Kv, env: Record<string, string>): Record<string, string>;
export function agentNetworkEnv(kv: Kv, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function agentNetworkEnv(kv: Kv, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return networkEnv(readNetwork(kv), env);
}

async function proxyReachable(url: URL): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: url.hostname, port: Number(url.port || (url.protocol === "https:" ? 443 : 80)) });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(3000, () => done(false));
    socket.once("error", () => done(false));
    socket.once("connect", () => done(true));
  });
}

/** No model requests or credentials: HTTP responses prove reachability, not sign-in or model access. */
export async function testNetwork(settings: NetworkSettings, inherited: NodeJS.ProcessEnv = process.env, targets = [
  { name: "Codex", url: "https://chatgpt.com/backend-api/codex" },
  { name: "Claude", url: "https://api.anthropic.com/" },
  { name: "DeepSeek", url: "https://api.deepseek.com/" },
]): Promise<NetworkTestResult> {
  const env = networkEnv(settings, inherited);
  const proxy = settings.mode === "manual" ? settings.proxyUrl : settings.mode === "inherit" ? env.https_proxy || env.HTTPS_PROXY || env.all_proxy || env.ALL_PROXY : undefined;
  if (proxy) {
    let reachable = false;
    try { reachable = await proxyReachable(new URL(proxy)); } catch { /* report below without echoing inherited credentials */ }
    if (!reachable) return { proxy: "代理无法连接，请检查代理软件及地址、端口", checks: [] };
  }
  const checks = await Promise.all(targets.map(({ name, url }) => new Promise<NetworkTestResult["checks"][number]>((resolve) => {
    const args = ["--disable", "--silent", "--output", process.platform === "win32" ? "NUL" : "/dev/null", "--write-out", "%{http_code}", "--connect-timeout", "5", "--max-time", "8", "--head"];
    if (settings.mode === "direct") args.push("--noproxy", "*");
    if (settings.mode === "manual") args.push("--proxy", settings.proxyUrl);
    args.push(url);
    execFile(process.platform === "win32" ? "curl.exe" : "curl", args, { env, windowsHide: true, timeout: 10_000 }, (err, stdout) => {
      const status = Number(stdout.trim());
      const ok = !err && status > 0 && status !== 407;
      const code = err && "code" in err ? String(err.code) : "";
      resolve({ name, ok, message: ok ? `服务有响应（HTTP ${status}），未验证登录及模型权限` : status === 407 ? "代理要求身份验证" : code === "ENOENT" ? "系统缺少 curl，无法测试" : code === "60" ? "证书验证失败" : code === "28" ? "连接超时" : "连接失败，请检查代理规则、网络或证书" });
    });
  })));
  return { proxy: proxy ? "代理端口可连接" : "未指定代理", checks };
}

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { TEAM_TASK_BODY_LIMIT, TeamBoardError, type TeamTaskPerson } from "@amo-studio/protocol";
import { TeamBoardStore, text } from "./store.js";

const COOKIE = "amo_team_board";
const SESSION_AGE = 12 * 60 * 60 * 1000;
type Session = { key: string; expires: number };
type Account = { name: string; key: string };
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };

async function body(req: IncomingMessage, limit = TEAM_TASK_BODY_LIMIT): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:;|$)/i.test(String(req.headers["content-type"]))) throw new TeamBoardError(415, "请发送 JSON 请求");
  if (Number(req.headers["content-length"]) > limit) throw new TeamBoardError(413, "内容超过可提交的大小");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const data = Buffer.from(chunk as Buffer);
    size += data.length;
    if (size > limit) throw new TeamBoardError(413, "内容超过可提交的大小");
    chunks.push(data);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new TeamBoardError(400, "请求格式无效"); }
}

export async function startTeamBoardServer(options: { path: string; relay: string; web: string; host: string; port: number; origin?: string }) {
  const store = new TeamBoardStore(options.path);
  const relay = new URL(options.relay);
  if (!/^https?:$/.test(relay.protocol) || relay.username || relay.password) throw new Error("AMO 中转地址无效");
  const origin = options.origin ? new URL(options.origin).origin : undefined;
  const sessions = new Map<string, Session>();

  async function relayRequest<T>(path: string, key?: string, data?: Record<string, string>): Promise<T> {
    let result: Response;
    try {
      result = await fetch(new URL(path, relay), { redirect: "error", method: data ? "POST" : "GET", headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(data ? { "content-type": "application/json" } : {}) }, body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(6000) });
    } catch { throw new TeamBoardError(502, "AMO 账号服务暂时连不上"); }
    if (result.status === 401 || result.status === 403) throw new TeamBoardError(401, "登录已失效或账号、密码不正确");
    if (!result.ok) throw new TeamBoardError(502, "AMO 账号服务暂不可用");
    return result.json() as Promise<T>;
  }

  function json(res: ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(value));
  }

  const server = createServer(async (req, res) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("content-security-policy", "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; style-src 'self'");
    try {
      const route = new URL(req.url ?? "/", "http://localhost").pathname;
      const method = req.method;
      if (method === "GET" && route === "/health") return json(res, 200, { ok: true, service: "amo-team-board" });
      if (method === "GET" && (route === "/" || /^\/assets\/[A-Za-z0-9_.-]+$/.test(route))) {
        const path = route === "/" ? join(options.web, "index.html") : join(options.web, route.slice(1));
        const mime = TYPES[extname(path)];
        if (!mime) throw new TeamBoardError(404, "页面不存在");
        const bytes = await readFile(path).catch(() => { throw new TeamBoardError(404, "看板页面未构建，请检查服务安装"); });
        res.writeHead(200, { "content-type": mime, "cache-control": route === "/" ? "no-store" : "public, max-age=86400" });
        res.end(bytes);
        return;
      }
      if (!route.startsWith("/api/board") || !["GET", "POST"].includes(method ?? "")) throw new TeamBoardError(404, "找不到接口");
      const bearer = /^Bearer ([^\s]+)$/.exec(req.headers.authorization ?? "")?.[1];
      const cookie = new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{43})(?:;|$)`).exec(req.headers.cookie ?? "")?.[1];
      const session = cookie && sessions.get(cookie);
      const cookieAttrs = `Path=/; HttpOnly; SameSite=Strict${origin?.startsWith("https:") ? "; Secure" : ""}`;
      if (method === "POST" && (!bearer || route === "/api/board/login") && req.headers.origin !== (origin ?? `http://${req.headers.host}`)) throw new TeamBoardError(403, "请从团队看板打开这个操作");
      if (method === "POST" && route === "/api/board/login") {
        const input = await body(req, 8192);
        const name = text(input.name, "账号", 120);
        const password = typeof input.password === "string" && input.password.length <= 2048 ? input.password : "";
        if (!password) throw new TeamBoardError(400, "请输入密码");
        const account = await relayRequest<Account>("/api/login", undefined, { name, password });
        const now = Date.now();
        for (const [id, current] of sessions) if (current.expires <= now) sessions.delete(id);
        if (cookie) sessions.delete(cookie);
        const id = randomBytes(32).toString("base64url");
        sessions.set(id, { key: account.key, expires: now + SESSION_AGE });
        res.setHeader("set-cookie", `${COOKIE}=${id}; ${cookieAttrs}; Max-Age=${SESSION_AGE / 1000}`);
        return json(res, 200, { name: account.name });
      }
      if (method === "POST" && route === "/api/board/logout" && !bearer) {
        if (cookie) sessions.delete(cookie);
        res.setHeader("set-cookie", `${COOKIE}=; ${cookieAttrs}; Max-Age=0`);
        if (session) await relayRequest("/api/logout", session.key, {}).catch(() => undefined);
        return json(res, 200, { ok: true });
      }
      const key = bearer ?? (session && session.expires > Date.now() ? session.key : null);
      if (!key) throw new TeamBoardError(401, "请登录 AMO 团队账号");
      const { name } = await relayRequest<{ name: string }>("/api/me", key);
      if (typeof name !== "string" || !name) throw new TeamBoardError(502, "账号服务返回了无效身份");
      const members = async () => (await relayRequest<{ members: TeamTaskPerson[] }>("/api/members", key)).members.map(({ name, nick }) => ({ name, nick }));
      if (method === "GET" && route === "/api/board") return json(res, 200, store.snapshot(name));
      if (method === "GET" && route === "/api/board/identity") return json(res, 200, { name, members: await members() });
      if (method === "POST" && route === "/api/board/tickets") return json(res, 200, store.create(name, await body(req), (await members()).map((member) => member.name)));
      const notice = /^\/api\/board\/notices\/(team-[0-9a-f-]{36})\/read$/.exec(route);
      if (method === "POST" && notice) { store.readNotice(name, notice[1]!); return json(res, 200, { ok: true }); }
      const ticket = /^\/api\/board\/tickets\/(team-[0-9a-f-]{36})(?:\/(change|claim|release|files\/([0-9a-f-]{36})))?$/.exec(route);
      if (!ticket) throw new TeamBoardError(404, "找不到接口");
      const [, id, verb, fileId] = ticket;
      if (method === "GET" && !verb) return json(res, 200, store.detail(id!));
      if (method === "GET" && fileId) {
        const file = store.file(id!, fileId);
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": file.bytes.length, "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(Buffer.from(file.name).toString("utf8"))}`, "cache-control": "no-store" });
        res.end(file.bytes);
        return;
      }
      if (method === "POST" && verb === "change") return json(res, 200, store.change(name, id!, await body(req)));
      if (method === "POST" && (verb === "claim" || verb === "release")) {
        if (!bearer) throw new TeamBoardError(403, "请从 Studio 拖入本地待办接单");
        const input = await body(req, 8192);
        if (verb === "claim") return json(res, 200, store.claim(name, id!, input.revision));
        store.release(name, id!, input.claimId);
        return json(res, 200, { ok: true });
      }
      throw new TeamBoardError(404, "找不到接口");
    } catch (error) {
      if (!res.headersSent) json(res, error instanceof TeamBoardError ? error.status : 500, { message: error instanceof TeamBoardError ? error.message : "团队看板暂时无法处理请求" });
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host, () => { server.off("error", reject); resolve(); });
    });
  } catch (error) { store.close(); throw error; }
  const port = (server.address() as AddressInfo).port;
  return { port, close: () => new Promise<void>((resolve, reject) => server.close((error) => { store.close(); error ? reject(error) : resolve(); })) };
}

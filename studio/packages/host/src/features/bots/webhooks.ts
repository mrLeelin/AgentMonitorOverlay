import { createHash } from "node:crypto";
import type { BotRequest, BotWebhook, BotWebhookEvent, Id } from "@amo-studio/protocol";
import type { TeamLink } from "../../core/teamlink.js";
import { HostError } from "../../core/shared.js";
import type { Store } from "../../store/store.js";

const DEVICE_KEY = "bots.webhooks-device";
type Login = NonNullable<ReturnType<TeamLink["login"]>>;
type HookRecord = Omit<BotWebhook, "url">;
const accountDevice = (login: Login) => JSON.stringify([login.account.server, login.account.name, login.deviceId]);

export class BotWebhookBridge {
  private timer: ReturnType<typeof setInterval> | undefined;
  private poll: AbortController | undefined;

  constructor(private readonly team: TeamLink, private readonly store: Store, private readonly ask: (botId: Id, id: Id, text: string) => Promise<BotRequest>) {}

  start() { this.timer ??= setInterval(() => void this.sync(), 5000).unref(); }
  stop() { clearInterval(this.timer); this.timer = undefined; this.poll?.abort(); }

  private login(): Login {
    const login = this.team.login();
    if (!login) throw new HostError("conflict", "请先在 AMO 平台登录，Webhook 由团队中转接收。");
    return login;
  }

  private url(login: Login, id: Id) {
    return `${login.account.server.replace(/\/$/u, "")}/api/bot-hooks/${encodeURIComponent(id)}`;
  }

  private async relay<T>(login: Login, path: string, options: { method?: string; body?: unknown; query?: Record<string, string>; signal?: AbortSignal } = {}): Promise<T> {
    const query = new URLSearchParams({ device: login.deviceId, ...options.query });
    const timeout = AbortSignal.timeout(6000);
    const response = await fetch(`${login.account.server.replace(/\/$/u, "")}${path}?${query}`, {
      method: options.method ?? "GET", redirect: "error", signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
      headers: { Authorization: `Bearer ${login.account.key}`, ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    if (!response.ok) throw new HostError("conflict", response.status === 404 ? "当前中转服务还未启用 Bot Webhook。" : `中转 Webhook 请求失败（HTTP ${response.status}）。`);
    return await response.json() as T;
  }

  async list(botId: Id): Promise<BotWebhook[]> {
    const login = this.login();
    const hooks = await this.relay<HookRecord[]>(login, "/api/bot-hooks");
    const key = accountDevice(login);
    if (hooks.length) this.store.setKv(DEVICE_KEY, key);
    else if (this.store.getKv(DEVICE_KEY)?.value === key) this.store.deleteKv(DEVICE_KEY);
    return hooks.filter((hook) => hook.botId === botId).map((hook) => ({ ...hook, url: this.url(login, hook.id) }));
  }

  async add(botId: Id, allowResult: boolean): Promise<BotWebhook & { token: string }> {
    const login = this.login();
    const hook = await this.relay<HookRecord & { token: string }>(login, "/api/bot-hooks", { method: "POST", body: { botId, allowResult } });
    this.store.setKv(DEVICE_KEY, accountDevice(login));
    return { ...hook, url: this.url(login, hook.id) };
  }

  async remove(botId: Id, hookId: Id): Promise<{ ok: true }> {
    return this.relay(this.login(), "/api/bot-hooks", { method: "DELETE", query: { id: hookId, botId } });
  }

  async sync(): Promise<void> {
    const login = this.team.login();
    if (!login || this.poll || this.store.getKv(DEVICE_KEY)?.value !== accountDevice(login)) return;
    const poll = new AbortController();
    this.poll = poll;
    try {
      const events = await this.relay<BotWebhookEvent[]>(login, "/api/bot-hook-inbox", { signal: poll.signal });
      for (const event of events) {
        const current = this.team.login();
        if (poll.signal.aborted || !current || accountDevice(current) !== accountDevice(login)) return;
        const id = createHash("sha256").update(JSON.stringify([current.account.server, event.hookId, event.eventId])).digest("hex");
        let status: BotRequest["status"], result: string | undefined;
        try {
          const row = await this.ask(event.botId, id, event.text);
          ({ status, result } = row);
        } catch (err) {
          status = "failed";
          result = err instanceof Error ? err.message : String(err);
        }
        if (status !== event.status) await this.relay(login, "/api/bot-hook-inbox", { method: "PATCH", body: { hookId: event.hookId, eventId: event.eventId, status, result }, signal: poll.signal });
      }
    } catch {
      // The relay can be offline. The receipt stays there for the next poll, and the request id is stable.
    } finally { if (this.poll === poll) this.poll = undefined; }
  }
}

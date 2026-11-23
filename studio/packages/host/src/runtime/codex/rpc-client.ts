import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { codex } from "@amo-studio/protocol";

// JSON-RPC client for `codex app-server` over WebSocket with a capability token. One instance = one connection;
// reconnecting is the caller's job (the server manager re-creates clients after a restart).

// The stable generated schema omits this experimental request (Codex 0.167.2).
// Goals start turns themselves, so their settings must be applied without a turn/start.
export type ThreadSettingsUpdate = Pick<codex.v2.TurnStartParams, "threadId" | "model" | "effort" | "summary" | "approvalPolicy" | "approvalsReviewer" | "sandboxPolicy" | "serviceTier">;
export type ClientMethod = codex.ClientRequest["method"] | "thread/settings/update";
export type ParamsOf<M extends ClientMethod> = M extends "thread/settings/update" ? ThreadSettingsUpdate : Extract<codex.ClientRequest, { method: M }>["params"];
export type ServerNotification = codex.ServerNotification;
export type ServerRequest = codex.ServerRequest;

/** Responses for the methods the Host uses. Others resolve to `unknown`. */
export interface ResponseMap {
  "thread/goal/get": codex.v2.ThreadGoalGetResponse;
  "thread/goal/set": codex.v2.ThreadGoalSetResponse;
  "thread/goal/clear": codex.v2.ThreadGoalClearResponse;
  "thread/settings/update": Record<string, never>;
  initialize: codex.InitializeResponse;
  "thread/start": codex.v2.ThreadStartResponse;
  "thread/resume": codex.v2.ThreadResumeResponse;
  "thread/fork": codex.v2.ThreadForkResponse;
  "thread/archive": codex.v2.ThreadArchiveResponse;
  "thread/read": codex.v2.ThreadReadResponse;
  "thread/turns/list": codex.v2.ThreadTurnsListResponse;
  "thread/list": codex.v2.ThreadListResponse;
  "thread/loaded/list": codex.v2.ThreadLoadedListResponse;
  "thread/name/set": codex.v2.ThreadSetNameResponse;
  "turn/start": codex.v2.TurnStartResponse;
  "turn/steer": codex.v2.TurnSteerResponse;
  "turn/interrupt": codex.v2.TurnInterruptResponse;
}
export type ResponseOf<M extends ClientMethod> = M extends keyof ResponseMap ? ResponseMap[M] : unknown;

export class RpcError extends Error {
  constructor(readonly method: string, readonly code: number, message: string, readonly data?: unknown) {
    super(`${method}: ${message}`);
    this.name = "RpcError";
  }
}

export class ConnectionClosedError extends Error {
  constructor(method: string) {
    super(`${method}: connection closed`);
    this.name = "ConnectionClosedError";
  }
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

export interface CodexRpcClientEvents {
  notification: [ServerNotification];
  /** A server request (approvals etc.). Answer with `respond(id, result)`; another client may answer first. */
  request: [ServerRequest];
  close: [];
}

export interface ConnectOptions {
  url: string;
  token: string;
  clientName?: string;
  clientVersion?: string;
  connectTimeoutMs?: number;
}

export class CodexRpcClient extends EventEmitter<CodexRpcClientEvents> {
  private ws: WebSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  private readonly threadSettings = new Map<string, Record<string, unknown>>();
  defaultTimeoutMs = 60_000;

  static async connect(options: ConnectOptions): Promise<CodexRpcClient> {
    const client = new CodexRpcClient();
    await client.open(options);
    return client;
  }

  get isOpen(): boolean {
    return !this.closed && this.ws?.readyState === WebSocket.OPEN;
  }

  private async open(options: ConnectOptions): Promise<void> {
    const ws = new WebSocket(options.url, { headers: { Authorization: `Bearer ${options.token}` }, handshakeTimeout: options.connectTimeoutMs ?? 5000 });
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (err) => reject(err));
      ws.once("unexpected-response", (_req, res) => reject(new Error(`app-server refused the connection: HTTP ${res.statusCode}`)));
    });
    ws.on("message", (data) => this.onMessage(String(data)));
    ws.on("close", () => this.onClose());
    ws.on("error", () => {
      // 'close' follows and does the cleanup.
    });
    await this.request("initialize", {
      clientInfo: { name: options.clientName ?? "amo-studio", title: "AMO Studio", version: options.clientVersion ?? "0.0.0" },
      capabilities: { experimentalApi: true },
    } as ParamsOf<"initialize">);
    this.notify("initialized");
  }

  request<M extends ClientMethod>(method: M, params: ParamsOf<M>, options: { timeoutMs?: number } = {}): Promise<ResponseOf<M>> {
    if (!this.isOpen) return Promise.reject(new ConnectionClosedError(method));
    const id = this.nextId++;
    return new Promise<ResponseOf<M>>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(method, -32000, `timed out after ${timeoutMs} ms`));
      }, timeoutMs) : undefined;
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  /** The RPC only queues ThreadSettings; wait for its application before enabling Goal continuation. */
  async updateThreadSettings(params: ThreadSettingsUpdate): Promise<void> {
    let resolveApplied!: () => void;
    const applied = new Promise<void>((resolve) => { resolveApplied = resolve; });
    const matches = (actual: unknown, expected: unknown): boolean => {
      if (expected && typeof expected === "object") return !!actual && typeof actual === "object" && Object.entries(expected).every(([key, value]) => matches((actual as Record<string, unknown>)[key], value));
      return actual === expected;
    };
    const confirms = (settings: Record<string, unknown>) => Object.entries(params).every(([key, value]) => key === "threadId" || value === undefined || matches(settings[key], value));
    // start/resume and native updates maintain this connection's effective settings. Unchanged snapshots have
    // no public notification in Codex, so avoid sending an update that cannot acknowledge a change.
    const known = this.threadSettings.get(params.threadId);
    if (known && confirms(known)) return;
    let confirmed = false;
    const confirm = () => { confirmed = true; resolveApplied(); };
    const onNotification = (n: ServerNotification) => {
      if (n.method !== "thread/settings/updated" || n.params.threadId !== params.threadId) return;
      // Another turn can publish settings while this request is queued; its acknowledgement must not unlock Goal.
      if (confirms(n.params.threadSettings as unknown as Record<string, unknown>)) confirm();
    };
    this.on("notification", onNotification);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.request("thread/settings/update", params);
      // Only a connection without a snapshot needs a readback. Normal Host connections learn it on start/resume;
      // avoid rejoining an already active Goal merely to read settings, because resume may wake an idle Goal.
      if (!confirmed && !known) {
        const snapshot = await this.request("thread/resume", { threadId: params.threadId, excludeTurns: true });
        if (confirms({ ...snapshot, effort: snapshot.reasoningEffort, sandboxPolicy: snapshot.sandbox })) confirm();
      }
      await Promise.race([applied, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Codex 尚未确认会话设置，Goal 未开启，请重试。")), 10000); })]);
    } finally {
      if (timer) clearTimeout(timer);
      this.off("notification", onNotification);
    }
  }

  notify(method: string, params?: unknown): void {
    if (this.isOpen) this.ws!.send(JSON.stringify(params === undefined ? { method } : { method, params }));
  }

  /** Answers a server request. */
  respond(id: codex.RequestId, result: unknown): void {
    if (this.isOpen) this.ws!.send(JSON.stringify({ id, result }));
  }

  /** Answers a server request with a JSON-RPC error (Studio could not handle it). */
  respondError(id: codex.RequestId, code: number, message: string): void {
    if (this.isOpen) this.ws!.send(JSON.stringify({ id, error: { code, message } }));
  }

  close(): void {
    if (this.closed) return;
    this.ws?.close();
    this.onClose();
  }

  private onMessage(raw: string): void {
    let msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(Number(msg.id));
      if (!p) return;
      this.pending.delete(Number(msg.id));
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) p.reject(new RpcError(p.method, msg.error.code, msg.error.message, msg.error.data));
      else {
        if (p.method === "thread/start" || p.method === "thread/resume" || p.method === "thread/fork") {
          const result = msg.result as Record<string, unknown> | undefined;
          const thread = result?.thread as { id?: string } | undefined;
          if (thread?.id) this.threadSettings.set(thread.id, { ...result, effort: result?.reasoningEffort, sandboxPolicy: result?.sandbox });
        }
        p.resolve(msg.result);
      }
    } else if (msg.id !== undefined && msg.method) {
      this.emit("request", msg as unknown as ServerRequest);
    } else if (msg.method) {
      if (msg.method === "thread/settings/updated") {
        const params = msg.params as { threadId: string; threadSettings: Record<string, unknown> };
        this.threadSettings.set(params.threadId, params.threadSettings);
      }
      this.emit("notification", msg as unknown as ServerNotification);
    }
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new ConnectionClosedError(p.method));
      this.pending.delete(id);
    }
    this.emit("close");
  }
}

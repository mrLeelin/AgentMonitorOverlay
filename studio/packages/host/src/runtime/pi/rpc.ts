import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { lowerAgentPriority } from "../priority.js";

export interface PiCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface Pending {
  type: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout | null;
}

export interface PiRpcEvents {
  event: [record: Record<string, any>];
  exit: [error: Error];
  log: [message: string];
}

/** One Pi RPC process. Only LF ends a record: U+2028 and U+2029 are valid message text. */
export class PiRpc extends EventEmitter<PiRpcEvents> {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private readonly writes: string[] = [];
  private nextId = 1;
  private buffer = "";
  private blocked = false;
  private closing = false;
  private failure: Error | null = null;
  private closingPromise: Promise<void> | null = null;
  private finishExit!: () => void;
  readonly exited: Promise<void>;

  constructor(command: PiCommand, cwd: string, env: NodeJS.ProcessEnv = process.env) {
    super();
    this.exited = new Promise((resolve) => { this.finishExit = resolve; });
    this.child = spawn(command.command, command.args, { cwd, env: { ...env, ...command.env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false, detached: process.platform !== "win32" });
    lowerAgentPriority(this.child.pid);
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.read(chunk));
    // Drain diagnostics continuously, but never copy a provider's stderr (which may contain credentials) to logs.
    this.child.stderr.on("data", () => undefined);
    this.child.stdin.on("error", () => this.inputFailed());
    this.child.on("error", () => this.finish(new Error("无法启动 Pi，请检查 Pi 是否已安装且启动命令可用。")));
    this.child.on("close", (code, signal) => this.finish(new Error(`Pi 进程已退出（${signal ?? code ?? "被终止"}）。`)));
  }

  get alive(): boolean { return !this.failure && !this.closing; }
  get pid(): number | undefined { return this.child.pid; }

  /** A prompt's successful response is acceptance; its agent_settled event marks completion. */
  request<T = Record<string, unknown>>(type: string, payload: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    if (!this.alive) return Promise.reject(this.failure ?? new Error("Pi 进程正在关闭。"));
    const id = `pi-${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`Pi 没有回应 ${type}（${Math.round(timeoutMs / 1000)} 秒）。`), { code: "pi_timeout" }));
      }, timeoutMs) : null;
      this.pending.set(id, { type, resolve: resolve as (value: unknown) => void, reject, timer });
      try { this.write({ ...payload, type, id }); }
      catch (error) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(error);
      }
    });
  }

  /** Extension dialog replies have their own IDs and do not produce a normal command response. */
  notify(payload: Record<string, unknown>): void {
    if (!this.alive) throw this.failure ?? new Error("Pi 进程正在关闭。");
    this.write(payload);
  }

  close(graceMs = 5_000): Promise<void> {
    if (this.closingPromise) return this.closingPromise;
    this.closing = true;
    this.rejectPending(new Error("Pi 进程正在关闭。"));
    this.closingPromise = (async () => {
      if (this.failure) return;
      // end() queues EOF after already-written records; Pi disposes its runtime on EOF.
      this.writes.length = 0;
      this.child.stdin.end();
      const timer = setTimeout(() => this.kill(), graceMs);
      timer.unref?.();
      try { await this.exited; }
      finally { clearTimeout(timer); }
    })();
    return this.closingPromise;
  }

  /** A stopped Pi must not leave a shell or tool running after Studio considers it stopped. */
  kill(): void {
    this.closing = true;
    this.rejectPending(new Error("Pi 进程已终止。"));
    const pid = this.child.pid;
    if (this.failure || !pid) return;
    if (process.platform === "win32") {
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, (error) => { if (error) this.child.kill("SIGKILL"); });
    } else {
      try { process.kill(-pid, "SIGKILL"); }
      catch { this.child.kill("SIGKILL"); }
    }
  }

  private write(record: Record<string, unknown>): void {
    this.writes.push(`${JSON.stringify(record)}\n`);
    this.flush();
  }

  private flush(): void {
    while (!this.blocked && !this.failure && this.writes.length) {
      const frame = this.writes.shift()!;
      const ready = this.child.stdin.write(frame, (error) => { if (error) this.inputFailed(); });
      if (!ready) {
        this.blocked = true;
        this.child.stdin.once("drain", () => { this.blocked = false; this.flush(); });
      }
    }
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, "");
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let record: Record<string, any>;
      try { record = JSON.parse(line) as Record<string, any>; }
      catch { this.emit("log", "Pi 的标准输出包含无效的 RPC 记录，已忽略。"); continue; }
      if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.type !== "string") {
        this.emit("log", "Pi 的标准输出包含无效的 RPC 记录，已忽略。");
        continue;
      }
      if (record.type !== "response") { this.emit("event", record); continue; }
      if (typeof record.id !== "string") continue;
      const pending = this.pending.get(record.id);
      if (!pending) continue;
      this.pending.delete(record.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (record.success === true) pending.resolve(record.data);
      else pending.reject(new Error(typeof record.error === "string" ? record.error : `Pi 无法执行 ${pending.type}。`));
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private inputFailed(): void {
    if (this.failure) return;
    // A broken input pipe does not prove the agent or its tools exited; terminate that tree before settling it.
    this.kill();
  }

  private finish(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.writes.length = 0;
    this.rejectPending(error);
    this.emit("exit", error);
    this.finishExit();
  }
}

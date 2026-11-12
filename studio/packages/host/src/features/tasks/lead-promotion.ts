import type { Id, Session } from "@amo-studio/protocol";
import { Feature, type FeatureHost } from "../../core/feature.js";
import { HostError, sessionMoving } from "../../core/shared.js";
import { newId } from "../../store/store.js";
import type { TasksFeature } from "./service.js";

const KEY = "tasks.lead-promotions";
type Promotion = {
  taskId: Id;
  sourceSessionId: Id;
  summary: string;
  topicTitle?: string;
  originalTopicId?: Id | null;
  originalManagerTaskId?: Id | null;
  promotedTopicId?: Id;
  oldSessionIds: Id[];
  state: "pending" | "switching" | "starting" | "done" | "failed";
  sessionId?: Id;
  error?: string;
  retryState?: "pending" | "switching" | "starting";
  retrySessionId?: Id;
};

/** A writable CLI cannot promote its existing thread: finish the turn, then hand over to a fresh read-only one. */
export class TaskLeadPromotion extends Feature<"sessions" | "topics" | "canvases"> {
  private scheduled: NodeJS.Timeout | null = null;
  private processing: Promise<void> = Promise.resolve();

  constructor(host: FeatureHost<"sessions" | "topics" | "canvases">, private readonly tasks: TasksFeature) {
    super(host);
  }

  watch(): void {
    this.host.on("event", (event) => {
      if (event.type === "session.upserted" || event.type === "item.appended" || event.type === "item.updated" || event.type === "task.upserted") this.schedule();
    });
    this.schedule();
  }

  request(sessionId: Id, summaryIn: unknown, topicTitle?: unknown): Promotion {
    const source = this.requireSession(sessionId);
    if (source.kind !== "main" || source.parentId || !source.taskId) throw new HostError("bad_request", "只有任务的主会话可以将自己的任务设为主控；专题、分支和子 agent 不能调用。");
    const task = this.requireTask(source.taskId);
    const records = this.records();
    const previous = records[task.id];
    const retry = previous?.state === "failed" && (previous.retryState === "switching" || previous.retryState === "starting");
    this.requireLiveWorkspace(task.workspaceId);
    if (task.topicId) this.requireLiveTopic(task.topicId);
    if (source.archivedAt || task.archivedAt || task.remote || source.runtime === "remote" || source.writer !== "workbench") throw new HostError("read_only", "请在有效本地任务的 Studio 主会话中设置主控。");
    if (typeof summaryIn !== "string" || !summaryIn.trim() || summaryIn.trim().length > 20_000) throw new HostError("bad_request", "请提供不超过 20000 字符的交接摘要，说明目标、已有结果和主控接下来要做的事。");
    // The first request owns its pending title; a retry with no title reuses that frozen value, even after renaming the task.
    const title = this.f.topics.leadTopicTitle(task.id, topicTitle ?? (previous && ((previous.state !== "done" && previous.state !== "failed") || retry) ? previous.topicTitle : undefined));
    if (previous && (previous.state === "pending" || previous.state === "switching" || (retry && !task.topicId)) && previous.originalTopicId === null && topicTitle !== undefined && String(topicTitle).trim() !== previous.topicTitle) throw new HostError("conflict", "带队申请已保存 topicTitle；同一次重试须保留原标题。尚未切换时先取消申请，再用新标题重新申请；已开始切换则先恢复原交接。");
    if (previous && previous.state !== "failed" && previous.state !== "done") return previous;
    if (retry) {
      if ((previous.originalManagerTaskId !== undefined && (task.managerTaskId ?? null) !== previous.originalManagerTaskId) || (previous.promotedTopicId && task.topicId !== previous.promotedTopicId) || (previous.retryState === "starting" && !task.lead)) throw new HostError("conflict", "失败后的角色或管理范围已变化，不能恢复旧交接；请在当前任务会话中继续。");
      previous.state = previous.retryState!;
      previous.retrySessionId = source.id;
      delete previous.error;
      this.put(previous);
      this.schedule();
      return previous;
    }
    if (task.lead) return previous ?? { taskId: task.id, sourceSessionId: source.id, summary: summaryIn.trim(), oldSessionIds: [], state: "done", sessionId: source.id };
    const entry: Promotion = { taskId: task.id, sourceSessionId: source.id, summary: summaryIn.trim(), ...(title ? { topicTitle: title } : {}), originalTopicId: task.topicId, originalManagerTaskId: task.managerTaskId ?? null, oldSessionIds: this.store.listSessions({ taskId: task.id }).map((s) => s.id), state: "pending" };
    records[task.id] = entry;
    this.save(records);
    this.notice(source.id, "已申请将本任务设为主控。请完成当前轮；所有会话、终端、后台命令和待送消息安定后，会保留并归档旧会话，自动新开只读主控会话接收交接。");
    this.schedule();
    return entry;
  }

  status(taskId: Id): Promotion | null {
    return this.records()[taskId] ?? null;
  }

  cancel(sessionId: Id): void {
    const taskId = this.store.getSession(sessionId)?.taskId;
    const entry = taskId ? this.status(taskId) : null;
    if (entry?.state === "failed" || entry?.state === "done") return;
    if (!entry || (entry.state !== "pending" && entry.retrySessionId !== sessionId)) return;
    entry.retryState = entry.state === "switching" || entry.state === "starting" ? entry.state : "pending";
    entry.state = "failed";
    entry.error = "会话被用户停止，已取消自动切换；需要时可重新申请。";
    this.put(entry);
    this.notice(entry.sourceSessionId, entry.error);
  }

  /** The brief archive barrier must not admit a new writable session or a message to an old thread. */
  assertAvailable(taskId: Id | null): void {
    if (taskId && this.status(taskId)?.state === "switching") throw new HostError("conflict", "任务正在切换为主控，请稍后在新的主控会话中继续。");
  }

  flush(): Promise<void> {
    const next = this.processing.then(async () => {
      for (const entry of Object.values(this.records())) {
        if (!this.store.getTask(entry.taskId)) {
          const records = this.records();
          delete records[entry.taskId];
          this.save(records);
          continue;
        }
        if (entry.state === "done" || entry.state === "failed") continue;
        try {
          await this.advance(entry);
        } catch (error) {
          entry.retryState = entry.state === "switching" || entry.state === "starting" ? entry.state : "pending";
          entry.state = "failed";
          entry.error = error instanceof Error ? error.message : String(error);
          this.put(entry);
          this.notice(entry.sourceSessionId, `切换主控未完成：${entry.error}。旧对话已保留；请检查任务和会话状态后继续，不会自动重复创建会话。`, "warning");
        }
      }
    });
    this.processing = next.catch((error: unknown) => this.log(`task lead promotion: ${String(error)}`));
    return this.processing;
  }

  private async advance(entry: Promotion): Promise<void> {
    let task = this.requireTask(entry.taskId);
    this.requireLiveWorkspace(task.workspaceId);
    if (task.topicId) this.requireLiveTopic(task.topicId);
    if (task.archivedAt || task.remote) throw new HostError("read_only", "任务已归档或属于远程，已停止切换。");
    const source = this.requireSession(entry.sourceSessionId);
    if (entry.retrySessionId) {
      const retrySource = this.requireSession(entry.retrySessionId);
      const [turn] = this.store.findItems(retrySource.id, "turn", {}, { newest: true, limit: 1 });
      if (retrySource.archivedAt || retrySource.status === "interrupted" || retrySource.status === "error" || (turn?.type === "turn" && (turn.state === "interrupted" || turn.state === "failed"))) throw new HostError("conflict", "重试来源会话被停止或归档，已停止恢复交接。");
      if (this.tasks.hasStartingSession(task.id) || this.store.listSessions({ taskId: task.id }).some((s) => !s.archivedAt && (sessionMoving(s) || this.store.findItems(s.id, "background", { state: "running" }).length || this.unsent(s)))) return;
      delete entry.retrySessionId;
      this.put(entry);
    }
    if (entry.state === "pending") {
      if ((entry.originalTopicId !== undefined && task.topicId !== entry.originalTopicId) || (entry.originalManagerTaskId !== undefined && (task.managerTaskId ?? null) !== entry.originalManagerTaskId)) throw new HostError("conflict", "申请期间专题或直属主控已变化，请重新核对后申请。");
      this.f.topics.leadTopicTitle(task.id, entry.topicTitle);
      if (source.archivedAt) throw new HostError("conflict", "来源会话已归档，已停止切换。");
      if (source.status === "interrupted" || source.status === "error") throw new HostError("conflict", "来源会话被停止或发生错误，已停止自动切换。");
      const [turn] = this.store.findItems(source.id, "turn", {}, { newest: true, limit: 1 });
      if (turn?.type === "turn" && (turn.state === "interrupted" || turn.state === "failed")) throw new HostError("conflict", "来源会话上一轮未正常结束，已停止自动切换。");
      if (task.lead) throw new HostError("conflict", "任务角色已由其他操作改变，请在任务页继续。");
      if (this.tasks.hasStartingSession(task.id)) return;
      const sessions = this.store.listSessions({ taskId: task.id }).filter((s) => !s.archivedAt);
      if (sessions.some((s) => sessionMoving(s) || this.store.findItems(s.id, "background", { state: "running" }).length || this.unsent(s))) return;
      entry.oldSessionIds = this.store.listSessions({ taskId: task.id }).map((s) => s.id);
      entry.state = "switching";
      this.put(entry);
    }
    if (entry.state === "switching") {
      const sessions = this.store.listSessions({ taskId: task.id }).filter((s) => !s.archivedAt);
      if (sessions.some((s) => sessionMoving(s) || this.store.findItems(s.id, "background", { state: "running" }).length || this.unsent(s))) throw new HostError("conflict", "切换期间出现了新的运行或待送消息，已停止切换以保留工作。");
      // Each runtime archives its tree synchronously before its first await. Close every root before yielding, so
      // inbox delivery and Codex's afterTurn cannot start a new writable turn in the gap between roots.
      await Promise.all(sessions.filter((s) => !s.parentId).map((s) => this.runtime.archive(s.id)));
      task = this.requireTask(task.id);
      if (task.archivedAt || task.remote) throw new HostError("read_only", "任务在切换期间已归档或转为远程。");
      if (task.topicId) this.requireLiveTopic(task.topicId);
      if ((entry.originalTopicId !== undefined && task.topicId !== entry.originalTopicId) || (entry.originalManagerTaskId !== undefined && (task.managerTaskId ?? null) !== entry.originalManagerTaskId)) throw new HostError("conflict", "切换期间专题或直属主控已变化，未自动迁移。");
      const promoted = this.host.transaction(() => {
        const topic = this.f.topics.ensureLeadTopic(task.id, entry.topicTitle);
        this.tasks.updateTask(task.id, { lead: true });
        this.f.canvases.ensureManagementCards(task.id);
        const next: Promotion = { ...entry, promotedTopicId: topic.id, state: "starting" };
        this.put(next);
        return next;
      });
      Object.assign(entry, promoted);
    }
    if (entry.state !== "starting") return;
    task = this.requireTask(task.id);
    if (!task.lead) throw new HostError("conflict", "主控标记已取消，已停止启动主控会话。");
    if ((entry.promotedTopicId && task.topicId !== entry.promotedTopicId) || (entry.originalManagerTaskId !== undefined && (task.managerTaskId ?? null) !== entry.originalManagerTaskId)) throw new HostError("conflict", "主控交接的专题或管理范围已变化，已停止启动。");
    this.f.topics.ensureLeadTopic(task.id, entry.topicTitle);
    this.f.canvases.ensureManagementCards(task.id);
    // A Host may have stopped after saving the new session but before saving its receipt. Adopt it, never duplicate.
    let target = entry.sessionId ? this.store.getSession(entry.sessionId) : this.store.listSessions({ taskId: task.id }).find((s) => !entry.oldSessionIds.includes(s.id) && !s.archivedAt && s.kind === "main");
    if (!target) {
      target = await this.tasks.addSession(task.id, { profileId: source.profileId, options: { ...source.options, permission: "read-only" } });
      entry.sessionId = target.id;
      this.put(entry);
    }
    if (target.archivedAt) throw new HostError("conflict", "新的主控会话已归档，未自动重开。");
    entry.sessionId = target.id;
    this.put(entry);
    task = this.requireTask(task.id);
    if (!task.lead || task.archivedAt || task.remote || (entry.promotedTopicId && task.topicId !== entry.promotedTopicId) || (entry.originalManagerTaskId !== undefined && (task.managerTaskId ?? null) !== entry.originalManagerTaskId) || this.store.getWorkspace(task.workspaceId)?.archivedAt || (task.topicId && this.store.getTopic(task.topicId)?.archivedAt)) {
      if (!sessionMoving(this.requireSession(target.id))) await this.runtime.archive(target.id);
      throw new HostError("conflict", "新会话创建期间任务角色或归档状态已改变，未发送主控交接。");
    }
    const messageId = `lead-promotion-${source.id}`;
    const last = this.store.findItems(source.id, "agent").filter((item) => item.type === "agent" && !item.streaming).at(-1);
    const text = `本任务已自行设为主控，你是新的只读主控会话。旧会话 ${source.id} 已归档，对话仍可读取。先用 amo_whoami 和 task_management 核对角色与管理范围；保留原直属主控，仅管理自己和明确下辖的任务。\n\n交接摘要：\n${entry.summary}${last?.type === "agent" ? `\n\n来源会话最后的回复：\n${last.markdown.slice(-12_000)}` : ""}\n\n按交接中的目标继续；具体实现和本地文件修改交给执行任务。`;
    await this.f.sessions.inbox.put(target.id, text, undefined, messageId);
    const message = this.store.getItem(messageId);
    if (message?.type === "user" && message.delivery === "unsent") throw new HostError("conflict", "只读主控会话已创建，但交接消息未送达；请在新会话中重新发送该消息。");
    entry.state = "done";
    this.put(entry);
    this.notice(source.id, `本任务已设为主控，新的只读主控会话：${target.id}。请在该会话中继续发布任务。`);
  }

  private unsent(session: Session): boolean {
    return this.store.findItems(session.id, "user").some((item) => item.type === "user" && (item.delivery === "waiting" || item.delivery === "held" || item.delivery === "unsent"));
  }

  private notice(sessionId: Id, message: string, level: "info" | "warning" = "info"): void {
    if (!this.store.getSession(sessionId)) return;
    const item = this.store.appendItem({ id: newId("i"), sessionId, createdAt: new Date().toISOString(), type: "notice", level, message });
    this.publish({ type: "item.appended", item });
  }

  private records(): Record<Id, Promotion> {
    return JSON.parse(this.store.getKv(KEY)?.value ?? "{}");
  }

  private put(entry: Promotion): void {
    const records = this.records();
    records[entry.taskId] = entry;
    this.save(records);
  }

  private save(records: Record<Id, Promotion>): void {
    this.store.setKv(KEY, JSON.stringify(records));
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = null;
      void this.flush();
    }, 25);
    this.scheduled.unref?.();
  }
}

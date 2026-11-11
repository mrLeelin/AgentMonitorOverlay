import { createHash } from "node:crypto";
import { isCommon, managementRoot, TASK_DESCRIPTION_MAX, TASK_PLAN_MAX_TASKS, wouldCycle, type Id, type ModelProfile, type PlannedTask, type Task, type TaskPlan } from "@amo-studio/protocol";
import { newId } from "../../store/store.js";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";
import { roleFacts } from "../../core/role.js";

const SUMMARY_MAX = 2000;
const FIRST_MESSAGE_MAX = 20_000;
/** How long a decided proposal stays listed. */
const DECIDED_SHOWN_MS = 24 * 3600_000;
const STARTS_KEY = "taskplans.pending-starts";
type PendingStart = { taskId: Id; planId: Id; managerTaskId: Id | null; rootTaskId?: Id | null; dependsOn: Id[]; profileId: Id; text: string; options?: PlannedTask["options"]; error?: string };

/**
 * A lead organises its managed work directly; a topic session without a lead keeps the editable proposal workflow.
 * Tasks and dependencies are created before any session, and dependent work waits for accepted prerequisites.
 */
export class TaskPlansFeature extends Feature<"canvases" | "collab" | "sessions" | "tasks" | "orchestration" | "sharedContext"> {
  private starting: Promise<void> | null = null;

  /** Only accepted plans enter this durable queue; installing it never starts old unaccepted proposals. */
  watch(): void {
    this.host.on("event", (event) => {
      if (event.type === "task.upserted") {
        // Revoke synchronously: transferring away and back before the async scan must not revive old dispatch.
        const pending = this.pending(), tasks = this.store.listTasks();
        let changed = false;
        for (const entry of Object.values(pending)) {
          if (entry.rootTaskId === undefined) continue;
          const task = tasks.find((t) => t.id === entry.taskId);
          if (!task || (task.managerTaskId ?? null) !== entry.managerTaskId || (managementRoot(tasks, entry.taskId)?.id ?? null) !== entry.rootTaskId) { delete pending[entry.taskId]; changed = true; }
        }
        if (changed) this.store.setKv(STARTS_KEY, JSON.stringify(pending));
        void this.startReady();
      }
    });
    void this.startReady();
  }

  list(): TaskPlan[] {
    const since = Date.now() - DECIDED_SHOWN_MS;
    return this.store.listTaskPlans().filter((p) => p.state === "open" || Date.parse(p.decidedAt ?? p.createdAt) > since);
  }

  private requirePlan(id: Id): TaskPlan {
    const plan = this.store.getTaskPlan(id);
    if (!plan) throw new HostError("not_found", `proposal ${id} not found`);
    return plan;
  }

  private save(plan: TaskPlan): TaskPlan {
    this.store.putTaskPlan(plan);
    this.publish({ type: "taskplan.upserted", plan });
    return plan;
  }

  /** A 主控's proposal (MCP task_plan_propose). */
  async propose(sessionId: Id, input: { summary?: unknown; tasks?: unknown }): Promise<TaskPlan> {
    const facts = roleFacts(this.host, sessionId);
    if (facts.role !== "lead" && facts.role !== "topic") {
      throw new HostError("bad_request", "只有主控（或专题会话）能提拆任务的提案：把想法用 mailbox_send 发给主控，或由任务主会话用 task_set_lead 自行设置主控并在新的只读主控会话中继续。");
    }
    const summary = typeof input.summary === "string" ? input.summary.trim() : "";
    if (!summary) throw new HostError("bad_request", "summary is required: what the split is for, in a few lines");
    if (summary.length > SUMMARY_MAX) throw new HostError("bad_request", `summary is limited to ${SUMMARY_MAX} characters`);
    if (!Array.isArray(input.tasks) || !input.tasks.length) throw new HostError("bad_request", "tasks must list at least one task");
    if (input.tasks.length > TASK_PLAN_MAX_TASKS) throw new HostError("bad_request", `at most ${TASK_PLAN_MAX_TASKS} tasks in one proposal`);
    const defaultWs = facts.task?.workspaceId ?? facts.topic?.workspaceIds[0] ?? this.commonWorkspace().id;
    const tasks: PlannedTask[] = [];
    for (const [i, t] of (input.tasks as Array<Record<string, unknown>>).entries()) {
      if (!t || typeof t !== "object") throw new HostError("bad_request", `task ${i + 1} is not an object`);
      const key = typeof t.key === "string" && t.key.trim() ? t.key.trim() : `t${i + 1}`;
      const title = typeof t.title === "string" ? t.title.trim() : "";
      if (!title) throw new HostError("bad_request", `task ${key} needs a title`);
      const workspaceId = t.project === undefined || t.project === "" ? defaultWs : this.workspaceByRef(String(t.project));
      const description = optionalText(t.description, `task ${key}: description`, TASK_DESCRIPTION_MAX);
      if (t.lead !== undefined && typeof t.lead !== "boolean") throw new HostError("bad_request", `task ${key}: lead must be true or false`);
      const firstMessage = optionalText(t.firstMessage, `task ${key}: firstMessage`, FIRST_MESSAGE_MAX);
      // model: an account, or "<account>/<model>"; effort: checked against the model it will run (as session_start).
      const picked = t.model === undefined || t.model === "" ? { profileId: this.requireSession(sessionId).profileId } : await this.f.sessions.modelByRef(String(t.model));
      const effort = typeof t.effort === "string" && t.effort.trim() ? await this.f.sessions.effortFor(picked.profileId, picked.model, t.effort.trim()) : undefined;
      const options = picked.model || effort ? { ...(picked.model ? { model: picked.model } : {}), ...(effort ? { effort } : {}) } : undefined;
      const dependsOn = Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : [];
      const contextBasis = plannedBasis(t.contextBasis);
      if (contextBasis) this.f.sharedContext.validatePlanBasis(sessionId, contextBasis);
      tasks.push({ key, title, workspaceId, ...(t.lead ? { lead: true } : {}), ...(description ? { description } : {}), ...(firstMessage ? { firstMessage } : {}), profileId: picked.profileId, ...(options ? { options } : {}), ...(contextBasis ? { contextBasis } : {}), dependsOn });
    }
    checkKeys(tasks);
    const at = new Date().toISOString();
    const plan = this.save({ id: newId("plan"), topicId: facts.topic?.id ?? null, fromSessionId: sessionId, fromTaskId: facts.task?.id ?? null, summary, tasks, state: "open", createdAt: at, decidedAt: null });
    // A real lead already has the person's authority to organise its own work (2026-11-09).
    return facts.role === "lead" ? this.accept(plan.id, { run: true }) : plan;
  }

  /** The person accepts, with their changes: the tasks are made (and started, with `run`). */
  async accept(id: Id, input: { tasks?: unknown; run?: unknown }): Promise<TaskPlan> {
    const plan = this.requirePlan(id);
    if (plan.state !== "open") throw new HostError("conflict", "this proposal was decided already");
    const run = input.run === true;
    const given: Array<Record<string, unknown>> = Array.isArray(input.tasks) ? (input.tasks as Array<Record<string, unknown>>) : plan.tasks.map((t) => ({ ...t }));
    const kept: PlannedTask[] = [];
    for (const t of given) {
      if (!t || typeof t !== "object" || t.include === false) continue;
      const original = plan.tasks.find((p) => p.key === t.key);
      if (!original) throw new HostError("bad_request", `the proposal has no task ${String(t.key)}`);
      const title = typeof t.title === "string" && t.title.trim() ? t.title.trim() : original.title;
      const workspaceId = typeof t.workspaceId === "string" && t.workspaceId ? this.requireLiveWorkspace(t.workspaceId).id : original.workspaceId;
      const description = t.description === undefined ? original.description : optionalText(t.description, "description", TASK_DESCRIPTION_MAX);
      const firstMessage = t.firstMessage === undefined ? original.firstMessage : optionalText(t.firstMessage, "firstMessage", FIRST_MESSAGE_MAX);
      const profileId = typeof t.profileId === "string" && t.profileId ? this.requireProfile(t.profileId).id : original.profileId;
      // Another account picked: the proposed model and effort were that account's; the new one's defaults apply.
      const options = profileId === original.profileId ? original.options : undefined;
      const lead = t.lead === undefined ? original.lead : t.lead;
      if (lead !== undefined && typeof lead !== "boolean") throw new HostError("bad_request", "lead must be true or false");
      const contextBasis = plannedBasis(t.contextBasis === undefined ? original.contextBasis : t.contextBasis);
      if (contextBasis) this.f.sharedContext.validatePlanBasis(plan.fromSessionId, contextBasis);
      kept.push({ key: original.key, title, workspaceId, ...(lead ? { lead: true } : {}), ...(description ? { description } : {}), ...(firstMessage ? { firstMessage } : {}), ...(profileId ? { profileId } : {}), ...(options ? { options } : {}), ...(contextBasis ? { contextBasis } : {}), dependsOn: original.dependsOn });
    }
    if (!kept.length) throw new HostError("bad_request", "keep at least one task, or dismiss the proposal");
    checkKeys(kept);
    const topic = plan.topicId ? this.store.getTopic(plan.topicId) : undefined;
    const topicId = topic && !topic.archivedAt ? topic.id : null;
    // Fail before creating groups/tasks if the proposing lead moved or lost its role while the proposal waited.
    const manager = plan.fromTaskId ? this.store.getTask(plan.fromTaskId) : null;
    if (plan.fromTaskId && (!manager || !manager.lead || manager.archivedAt || manager.remote || manager.topicId !== topicId || (!topicId && kept.some((t) => t.workspaceId !== manager.workspaceId)))) throw new HostError("conflict", "提案来源主控已失效或离开范围，请重新提案后确认。");
    // A group per project when the tasks span several (the person's case: one migration in three projects).
    const projects = [...new Set(kept.map((t) => t.workspaceId))];
    const groups = new Map<Id, Id>();
    if (topicId && projects.length > 1) {
      for (const ws of projects) {
        const w = this.store.getWorkspace(ws);
        groups.set(ws, this.f.canvases.canvasCreateGroup(topicId, { title: w && !isCommon(w) ? w.name : "未指定项目", ...(w && !isCommon(w) ? { workspace: ws } : {}) }).groupId);
      }
    }
    const made: Array<{ key: string; task: Task }> = [];
    for (const t of kept) {
      const { task } = await this.f.tasks.createTask({
        title: t.title,
        workspaceId: t.workspaceId,
        topicId,
        managerTaskId: manager?.id ?? null,
        ...(t.lead ? { lead: true } : {}),
        ...(t.description ? { description: t.description } : {}),
        column: "todo",
        ...(t.firstMessage ? { firstMessage: t.firstMessage } : {}),
      });
      const described = t.description ? this.f.tasks.updateTask(task.id, { description: t.description }) : task;
      if (t.contextBasis) this.f.sharedContext.apply(plan.fromSessionId, { ...t.contextBasis, taskIds: [task.id] });
      if (topicId) this.f.canvases.canvasPlaceTask(task.id, groups.get(t.workspaceId) ?? null);
      made.push({ key: t.key, task: described });
    }
    if (topicId) {
      for (const t of kept) {
        const to = made.find((m) => m.key === t.key)!.task.id;
        for (const dep of t.dependsOn) {
          const from = made.find((m) => m.key === dep)?.task.id;
          if (from) this.f.canvases.canvasAddDependency(from, to);
        }
      }
    }
    const accepted = this.store.transaction(() => {
      const saved = this.save({ ...plan, tasks: kept, state: "accepted", decidedAt: new Date().toISOString(), created: made.map((m) => ({ key: m.key, taskId: m.task.id })) });
      if (run) {
        const pending = this.pending();
        for (const t of kept) {
          if (!t.profileId) continue;
          const taskId = made.find((m) => m.key === t.key)!.task.id;
          pending[taskId] = { taskId, planId: plan.id, managerTaskId: manager?.id ?? null, rootTaskId: managementRoot(this.store.listTasks(), taskId)?.id ?? null, dependsOn: t.dependsOn.flatMap((key) => made.filter((m) => m.key === key).map((m) => m.task.id)), profileId: t.profileId, text: t.firstMessage || t.description || t.title, ...(t.options ? { options: t.options } : {}) };
        }
        this.store.setKv(STARTS_KEY, JSON.stringify(pending));
      }
      return saved;
    });
    if (run) await this.startReady();
    const lines = made.map((m) => `- ${m.task.title}（${m.task.id}）`);
    const dropped = plan.tasks.length - made.length;
    this.tellLead(
      plan,
      `${manager ? "已按你的分工" : "人确认了你的拆任务提案"}「${firstLine(plan.summary)}」，建了 ${made.length} 个任务${dropped ? `（${dropped} 个没有采用）` : ""}，${run ? "无前置依赖的已启动，其余在前置任务验收完成后自动启动" : "放在待办里，等人开始"}：\n${lines.join("\n")}${topicId ? "\n它们已经在专题画布上，依赖也连好了。" : ""}`,
    );
    return accepted;
  }

  dismiss(id: Id, input: { note?: unknown }): TaskPlan {
    const plan = this.requirePlan(id);
    if (plan.state !== "open") throw new HostError("conflict", "this proposal was decided already");
    const note = optionalText(input.note, "note", SUMMARY_MAX);
    const dismissed = this.save({ ...plan, state: "dismissed", decidedAt: new Date().toISOString(), ...(note ? { note } : {}) });
    this.tellLead(plan, `人没有采用你的拆任务提案「${firstLine(plan.summary)}」${note ? `：${note}` : "。"}`);
    return dismissed;
  }

  /** Keep the audit mail and automatically continue the lead through the durable inbox. */
  private tellLead(plan: TaskPlan, text: string): void {
    try {
      this.f.collab.sendMail(null, { kind: "session", sessionId: plan.fromSessionId }, text);
      if (plan.fromTaskId) void this.f.sessions.inbox.put(plan.fromSessionId, text, undefined, `i-taskplan-${plan.id}-${createHash("sha256").update(text).digest("hex").slice(0, 20)}`, { purpose: "notification", rebaseOnContextUpgrade: true }).catch((error: unknown) => this.log(`task plan notification: ${String(error)}`));
    } catch {
      // The 主控's session is gone: the proposal still records the decision.
    }
  }

  private pending(): Record<Id, PendingStart> {
    return JSON.parse(this.store.getKv(STARTS_KEY)?.value ?? "{}");
  }

  /** Serialised starts and a stable persisted entry prevent task events or a restart from duplicating sessions. */
  startReady(): Promise<void> {
    // Enqueue rather than reuse the current promise: acceptance may persist new entries while an earlier
    // event's empty scan is finishing, and its caller must await a scan that can see those entries.
    const running = (this.starting ?? Promise.resolve()).then(async () => {
        for (const entry of Object.values(this.pending())) {
          const task = this.store.getTask(entry.taskId);
          const manager = entry.managerTaskId ? this.store.getTask(entry.managerTaskId) : null;
          const rootChanged = entry.rootTaskId !== undefined && (managementRoot(this.store.listTasks(), entry.taskId)?.id ?? null) !== entry.rootTaskId;
          const binding = task ? this.f.sharedContext.get(task.id) : null;
          const invalid = !task || !!task.archivedAt || !!task.remote || (task.topicId !== null && !!this.store.getTopic(task.topicId)?.archivedAt) || task.managerTaskId !== entry.managerTaskId || (entry.managerTaskId && (!manager?.lead || !!manager.archivedAt)) || rootChanged || (!!binding?.binding && !binding.validBinding);
          const existing = this.store.listSessions({ taskId: entry.taskId });
          if (invalid || existing.length) { this.dropPending(entry.taskId); continue; }
          if (entry.error || task.column !== "todo") continue;
          const dependencies = entry.dependsOn.map((id) => this.store.getTask(id));
          if (dependencies.some((dep) => !dep || dep.archivedAt || dep.column !== "done")) continue;
          // A managed prerequisite needs its actual accepted delivery, owned by the current manager.
          // Legacy unassigned plans keep their former done-column behavior.
          const results = dependencies.map((dep) => this.f.orchestration.results(dep!.id).at(-1));
          if (dependencies.some((dep, index) => {
            if (!entry.managerTaskId) return false;
            const result = results[index];
            return dep!.managerTaskId !== entry.managerTaskId || result?.state !== "accepted" || result.managerTaskId !== dep!.managerTaskId || !this.f.sharedContext.isResultCurrent(dep!.id, result) || !this.f.sharedContext.isPrerequisiteCurrent(task.id, result);
          })) continue;
          try {
            this.f.sharedContext.setPrerequisites(task.id, results.flatMap((result) => result ? [result.id] : []));
            this.f.tasks.updateTask(task.id, { column: "doing" });
            await this.f.tasks.addSession(task.id, { profileId: entry.profileId, text: entry.text, ...(entry.options ? { options: entry.options } : {}) });
            this.f.tasks.updateTask(task.id, { firstMessage: "" });
            this.dropPending(task.id);
          } catch (error) {
            // A runtime failure can happen after the session was saved. Never silently make another one.
            if (this.store.listSessions({ taskId: task.id }).length) this.dropPending(task.id);
            else {
              const pending = this.pending();
              if (pending[task.id]) pending[task.id]!.error = String(error);
              this.store.setKv(STARTS_KEY, JSON.stringify(pending));
            }
            const plan = this.store.getTaskPlan(entry.planId);
            if (plan) this.tellLead(plan, `任务「${task.title}」未能自动启动：${String(error)}。请检查后用 task_message 安排继续；不会重复创建会话。`);
          }
        }
    }).catch((error: unknown) => this.log(`task plan starts: ${String(error)}`));
    this.starting = running;
    void running.finally(() => { if (this.starting === running) this.starting = null; });
    return running;
  }

  private dropPending(taskId: Id): void {
    const pending = this.pending();
    delete pending[taskId];
    this.store.setKv(STARTS_KEY, JSON.stringify(pending));
  }

  private workspaceByRef(ref: string): Id {
    const ws = this.store.listWorkspaces().find((w) => !w.archivedAt && (w.id === ref || w.name === ref));
    if (!ws) throw new HostError("bad_request", `project ${ref} not found (give its id or name; project_context lists them)`);
    return ws.id;
  }

  private profileByRef(ref: string): ModelProfile {
    return this.host.profileByRef(ref);
  }
}

function optionalText(v: unknown, what: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new HostError("bad_request", `${what} must be text`);
  const t = v.trim();
  if (t.length > max) throw new HostError("bad_request", `${what} is limited to ${max} characters`);
  return t || undefined;
}

function plannedBasis(value: unknown): PlannedTask["contextBasis"] {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HostError("bad_request", "contextBasis 必须包含 contextId 和 version。");
  const { contextId, version } = value as Record<string, unknown>;
  if (typeof contextId !== "string" || !contextId.trim() || typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) throw new HostError("bad_request", "contextBasis 需要有效 contextId 和正整数 version。");
  return { contextId, version };
}

/** Keys are unique; dependencies name other planned tasks and make no cycle. */
function checkKeys(tasks: readonly PlannedTask[]): void {
  const keys = new Set<string>();
  for (const t of tasks) {
    if (keys.has(t.key)) throw new HostError("bad_request", `two tasks share the key ${t.key}`);
    keys.add(t.key);
  }
  const edges: Array<{ from: string; to: string }> = [];
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (!keys.has(d)) throw new HostError("bad_request", `task ${t.key} depends on ${d}, which is not in the proposal`);
      if (wouldCycle(edges, d, t.key)) throw new HostError("bad_request", `the dependencies of ${t.key} make a cycle`);
      edges.push({ from: d, to: t.key });
    }
  }
}

const firstLine = (text: string) => text.split(/\r?\n/)[0]!.slice(0, 80);

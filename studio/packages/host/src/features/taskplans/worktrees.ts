import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { isManagedBy, isObjectId, type Id, type Session, type Task, type TaskResult, type TaskWorktreeEvidence, type TaskWorktreeIntegrations, type TaskWorktreeTarget, type WorktreeIntegrationInput, type WorktreeIntegrationReceipt, type WorktreeIntegrationReviewInput } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";
import { newId, type Store } from "../../store/store.js";
import { assertPlaneManagedBase, planeManagedMemberVersion, planeManagedScope } from "../../store/plane-bot.js";
import { git } from "../gitreview/git.js";

const KEY = "taskplans.worktree:";
const now = () => new Date().toISOString();
type WorktreeSpec = { id: Id; workspaceId: Id; baseCommit: string; branch?: string; prerequisites: Id[]; target?: TaskWorktreeTarget; ready?: true; receipts: WorktreeIntegrationReceipt[] };

function localGit(cwd: string, ...args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 5000, maxBuffer: 32_768, windowsHide: true, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } }).trim();
  } catch {
    return null;
  }
}
const ancestor = (cwd: string, commit: string, head = "HEAD") => localGit(cwd, "merge-base", "--is-ancestor", commit, head) !== null;
function samePath(a: string, b: string): boolean {
  if (!a || !b) return false;
  try { return relative(realpathSync(a), realpathSync(b)) === ""; } catch { return false; }
}

function gitSnapshot(cwd: string, ...args: string[]): Buffer {
  try {
    return execFileSync("git", args, { cwd, timeout: 15000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    throw new HostError("conflict", "无法读取这份 Plane 交付的 Git 差异，请检查实际工作树。");
  }
}

function planeChanges(target: TaskWorktreeTarget): Pick<TaskWorktreeEvidence, "changedPaths" | "changeDigest" | "workingTreeDirty"> {
  const { cwd, baseCommit } = target;
  const root = localGit(cwd, "rev-parse", "--show-toplevel");
  if (!root) throw new HostError("conflict", "无法定位 Plane 执行工作树。");
  const prefix = gitSnapshot(cwd, "rev-parse", "--show-prefix").toString("utf8").replace(/\r?\n$/, "");
  const paths = (bytes: Buffer) => bytes.toString("utf8").split("\0").filter(Boolean);
  const untracked = paths(gitSnapshot(root, "ls-files", "--others", "--exclude-standard", "-z"));
  const tracked = paths(gitSnapshot(root, "diff", "--no-renames", "--name-only", "-z", baseCommit, "--"));
  const changedPaths = [...new Set([...tracked, ...untracked])].sort();
  if (changedPaths.some((file) => !file.startsWith(prefix))) throw new HostError("conflict", "工作树存在批准项目目录之外的改动，请核对范围。");
  const dirty = gitSnapshot(root, "status", "--porcelain=v1", "-z", "--untracked-files=normal").length > 0;
  const digest = createHash("sha256").update(gitSnapshot(root, "diff", "--binary", "--no-ext-diff", "--no-textconv", baseCommit, "--"));
  for (const file of untracked.sort()) {
    const path = join(root, file), stat = lstatSync(path);
    const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(path)) : readFileSync(path);
    digest.update(JSON.stringify([file, stat.mode, bytes.length])).update(bytes);
  }
  return { changedPaths, changeDigest: digest.digest("hex"), workingTreeDirty: dirty };
}

/** Checkout identity and input receipts persist independently of a pending automatic start or a particular session. */
export class TaskPlanWorktrees {
  private readonly opening = new Map<Id, Promise<TaskWorktreeTarget | null>>();

  constructor(private readonly getStore: () => Store, private readonly accepted: (taskId: Id, prerequisiteId: Id) => TaskResult | undefined,
    private readonly liveDependencies: (taskId: Id) => Id[], private readonly changed: (taskId: Id) => void) {}

  private get store(): Store { return this.getStore(); }

  private spec(taskId: Id): WorktreeSpec | null {
    return JSON.parse(this.store.getKv(KEY + taskId)?.value ?? "null") as WorktreeSpec | null;
  }
  private save(taskId: Id, spec: WorktreeSpec): void { this.store.setKv(KEY + taskId, JSON.stringify(spec)); }

  checkBase(workspaceId: Id, baseCommit: string): void {
    const workspace = this.store.getWorkspace(workspaceId);
    if (!workspace || workspace.archivedAt || !isObjectId(baseCommit) || localGit(workspace.path, "rev-parse", "--verify", `${baseCommit}^{commit}`) !== baseCommit) throw new HostError("conflict", "所选项目找不到批准的 Git 工作树基准。");
  }

  assign(task: Task, baseCommit: string, prerequisites: Id[], branch?: string): void {
    const previous = this.spec(task.id);
    if (previous) {
      if (previous.baseCommit === baseCommit && previous.workspaceId === task.workspaceId && previous.branch === branch && JSON.stringify(previous.prerequisites) === JSON.stringify(prerequisites)) return;
      throw new HostError("conflict", "任务已有冻结的工作树基准及接入范围。");
    }
    this.save(task.id, { id: newId("checkout"), workspaceId: task.workspaceId, baseCommit, ...(branch ? { branch } : {}), prerequisites, receipts: [] });
  }

  prepare(taskId: Id, beforeAllocate?: () => void): Promise<TaskWorktreeTarget | null> {
    const prior = this.opening.get(taskId);
    if (prior) return prior;
    const opening = this.allocate(taskId, beforeAllocate).finally(() => this.opening.delete(taskId));
    this.opening.set(taskId, opening);
    return opening;
  }

  private async allocate(taskId: Id, beforeAllocate?: () => void): Promise<TaskWorktreeTarget | null> {
    const spec = this.spec(taskId);
    if (!spec) return null;
    const task = this.liveTask(taskId), workspace = this.store.getWorkspace(spec.workspaceId);
    const plane = planeManagedScope(this.store, taskId);
    if (plane) assertPlaneManagedBase(this.store, plane);
    if (!workspace || workspace.archivedAt || task.workspaceId !== spec.workspaceId) throw new HostError("conflict", "执行项目已变化，不能接入原工作树。");
    if (spec.ready && spec.target) return spec.target;
    const [root, resolved] = await Promise.all([
      git(workspace.path, ["rev-parse", "--show-toplevel"]).then((v) => v.trim()),
      git(workspace.path, ["rev-parse", "--verify", `${spec.baseCommit}^{commit}`]).then((v) => v.trim()).catch(() => ""),
    ]);
    if (resolved !== spec.baseCommit) throw new HostError("conflict", "批准的工作树基准已不可用。");
    if (!spec.target && spec.branch) {
      const branchHead = await git(workspace.path, ["rev-parse", "--verify", `refs/heads/${spec.branch}^{commit}`]).then((v) => v.trim()).catch(() => "");
      if (!isObjectId(branchHead) || !ancestor(workspace.path, spec.baseCommit, branchHead)) throw new HostError("conflict", "所选本地分支已不包含批准的工作树基准。");
    }
    const within = relative(await realpath(root), await realpath(workspace.path));
    if (isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)) throw new HostError("conflict", "项目目录不在批准基准所属仓库内。");
    const dir = join(dirname(root), `${basename(root)}-amo-${spec.id}`), checkout = join(dir, "worktree");
    const target = { id: spec.id, cwd: join(checkout, within), baseCommit: spec.baseCommit };
    if (spec.target && relative(spec.target.cwd, target.cwd) !== "") throw new HostError("conflict", "项目路径已变化，请核对原工作树位置。");
    beforeAllocate?.();
    if (!this.sameTaskScope(task, this.liveTask(taskId))) throw new HostError("conflict", "分配工作树期间任务归属已变化。");
    // Persist the intended directory before git creates it so recovering the same intent cannot create another checkout.
    this.save(taskId, { ...spec, target });
    await mkdir(dir, { recursive: true });
    const checkoutRoot = localGit(checkout, "rev-parse", "--show-toplevel");
    if (!checkoutRoot || !samePath(checkoutRoot, checkout)) {
      beforeAllocate?.();
      await git(workspace.path, ["worktree", "add", "--detach", "--", checkout, spec.baseCommit], undefined, 180_000);
    }
    const current = this.liveTask(taskId), fresh = this.spec(taskId);
    if (!fresh || fresh.id !== spec.id || !this.sameTaskScope(task, current)) throw new HostError("conflict", "分配工作树期间任务归属已变化。");
    this.assertCheckout(current, fresh);
    this.save(taskId, { ...fresh, ready: true });
    this.changed(taskId);
    return target;
  }

  private sameTaskScope(before: Task, after: Task): boolean {
    return before.workspaceId === after.workspaceId && before.topicId === after.topicId && before.managerTaskId === after.managerTaskId;
  }

  private liveTask(taskId: Id): Task {
    const task = this.store.getTask(taskId);
    if (!task) throw new HostError("not_found", "找不到工作树所属任务。");
    if (task.archivedAt || task.remote || (task.topicId && this.store.getTopic(task.topicId)?.archivedAt !== null)) throw new HostError("conflict", "任务或专题已归档或不可用。");
    return task;
  }

  private assertCheckout(task: Task, spec: WorktreeSpec): TaskWorktreeTarget {
    const target = spec.target, workspace = this.store.getWorkspace(spec.workspaceId);
    if (!target || !workspace || workspace.archivedAt || task.workspaceId !== workspace.id) throw new HostError("conflict", "任务的独立工作树尚未可用。");
    const source = localGit(workspace.path, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const dest = localGit(target.cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
    if (!source || !dest || !samePath(source, dest) || samePath(source, localGit(target.cwd, "rev-parse", "--path-format=absolute", "--git-dir") ?? "") || !ancestor(target.cwd, spec.baseCommit)) throw new HostError("conflict", "独立工作树已不可用或不再包含批准的基准。");
    return target;
  }

  private requiresIntegration(taskId: Id, spec: WorktreeSpec, prerequisiteId: Id): boolean {
    if (spec.prerequisites.includes(prerequisiteId)) return true;
    const plane = planeManagedScope(this.store, taskId);
    if (!plane) return false;
    const result = this.accepted(taskId, prerequisiteId);
    if (result) return !!result.worktrees?.some((tree) => !!tree.changedPaths?.length || (!!tree.headCommit && tree.headCommit !== tree.baseCommit));
    return !!this.spec(prerequisiteId);
  }

  private waiting(taskId: Id, spec: WorktreeSpec, recheckGit = false) {
    const dependencies = new Set(this.liveDependencies(taskId));
    return [...dependencies].filter((id) => this.requiresIntegration(taskId, spec, id)).flatMap((prerequisiteTaskId) => {
      const result = this.accepted(taskId, prerequisiteTaskId);
      const valid = spec.receipts.some((r) => r.prerequisiteTaskId === prerequisiteTaskId && r.prerequisiteResultId === result?.id && r.worktreeId === spec.id &&
        (r.verification === "reviewed" || (r.verification === "git" && (!recheckGit || (r.evidence.kind === "commit" && !!spec.target && ancestor(spec.target.cwd, r.evidence.commit))))));
      return valid ? [] : [{ prerequisiteTaskId, prerequisiteResultId: result?.id ?? null }];
    });
  }

  view(taskId: Id): TaskWorktreeIntegrations {
    if (!this.store.getTask(taskId)) throw new HostError("not_found", "找不到工作树所属任务。");
    const spec = this.spec(taskId);
    return { taskId, worktree: spec?.ready ? spec.target ?? null : null, waiting: spec ? this.waiting(taskId, spec) : [], receipts: spec?.receipts ?? [] };
  }

  assertStartable(taskId: Id, cwd?: string, work = true): void {
    const spec = this.spec(taskId);
    const plane = planeManagedScope(this.store, taskId);
    if (plane) {
      if (work) assertPlaneManagedBase(this.store, plane);
      if (!spec || planeManagedMemberVersion(this.store, taskId) !== plane.plan_hash || spec.baseCommit !== plane.base_commit) throw new HostError("conflict", "此执行任务没有当前 Plane 批准版本的独立工作树。");
    }
    if (!spec) return;
    const task = this.liveTask(taskId), target = this.assertCheckout(task, spec);
    if (!spec.ready || (cwd !== undefined && !samePath(cwd, target.cwd))) throw new HostError("conflict", "请使用任务已分配的独立工作树执行。");
    if (!work) return;
    const waiting = this.waiting(taskId, spec, true);
    if (waiting.length) throw new HostError("conflict", `等待接入前置改动：${waiting.map((r) => this.store.getTask(r.prerequisiteTaskId)?.title ?? r.prerequisiteTaskId).join("、")}。`, { reason: "worktree-integration-pending", taskId, waiting });
  }

  add(taskId: Id, input: WorktreeIntegrationInput): WorktreeIntegrationReceipt {
    this.liveTask(taskId);
    if (!input || typeof input !== "object" || ![input.operationId, input.prerequisiteTaskId, input.prerequisiteResultId, input.worktreeId].every((s) => typeof s === "string" && s.trim() === s && s.length > 0 && s.length <= 200) || !input.evidence || !["commit", "patch", "manual"].includes(input.evidence.kind)) throw new HostError("bad_request", "请提供操作 ID、前置任务、已验收交付、工作树及接入证据。");
    const { operationId, prerequisiteTaskId, prerequisiteResultId, worktreeId } = input;
    const evidence = input.evidence.kind === "commit" ? { kind: "commit" as const, commit: input.evidence.commit } : { kind: input.evidence.kind, evidenceRef: input.evidence.evidenceRef };
    if (evidence.kind === "commit" ? !isObjectId(evidence.commit) : typeof evidence.evidenceRef !== "string" || !evidence.evidenceRef.trim() || evidence.evidenceRef.length > 4000) throw new HostError("bad_request", "接入证据须为完整提交编号，或可核对的补丁／人工验证引用。");
    return this.store.transaction(() => {
      const spec = this.spec(taskId);
      if (!spec) throw new HostError("conflict", "任务没有已分配的独立工作树。");
      const previous = spec.receipts.find((r) => r.operationId === operationId);
      if (previous) {
        if (previous.prerequisiteTaskId === prerequisiteTaskId && previous.prerequisiteResultId === prerequisiteResultId && previous.worktreeId === worktreeId && JSON.stringify(previous.evidence) === JSON.stringify(evidence)) return previous;
        throw new HostError("conflict", "接入操作 ID 已用于其他参数。", { reason: "operation-conflict", operationId });
      }
      const target = this.assertCheckout(this.liveTask(taskId), spec), result = this.accepted(taskId, prerequisiteTaskId);
      if (!spec.ready || target.id !== worktreeId || !this.requiresIntegration(taskId, spec, prerequisiteTaskId) || !this.liveDependencies(taskId).includes(prerequisiteTaskId) || result?.id !== prerequisiteResultId) throw new HostError("conflict", "任务、工作树或前置交付已变化，请刷新后登记接入证据。");
      if (evidence.kind === "commit") {
        const source = result.worktrees?.find((wt) => wt.headCommit === evidence.commit && wt.baseCommit !== evidence.commit && !wt.workingTreeDirty);
        if (!source || !ancestor(target.cwd, evidence.commit)) throw new HostError("conflict", "该提交须来自当前已验收前置交付，并已接入此工作树。");
      }
      const receipt: WorktreeIntegrationReceipt = { operationId, taskId, prerequisiteTaskId, prerequisiteResultId, worktreeId, evidence, recordedAt: now(), verification: evidence.kind === "commit" ? "git" : "needs-review" };
      this.save(taskId, { ...spec, receipts: [...spec.receipts, receipt] });
      this.changed(taskId);
      return receipt;
    });
  }

  review(taskId: Id, operationId: Id, input: WorktreeIntegrationReviewInput): WorktreeIntegrationReceipt {
    if (!input || typeof input.accept !== "boolean" || typeof input.review !== "string" || !input.review.trim() || input.review.length > 4000) throw new HostError("bad_request", "请提供接入验收意见及通过或退回操作。");
    return this.store.transaction(() => {
      this.liveTask(taskId);
      const spec = this.spec(taskId), old = spec?.receipts.find((r) => r.operationId === operationId);
      if (!spec || !old) throw new HostError("not_found", "找不到这份接入记录。");
      if (old.verification !== "needs-review" || spec.id !== old.worktreeId || input.prerequisiteResultId !== old.prerequisiteResultId || !this.liveDependencies(taskId).includes(old.prerequisiteTaskId) || this.accepted(taskId, old.prerequisiteTaskId)?.id !== old.prerequisiteResultId) throw new HostError("conflict", "接入证据已处理或前置交付已变化，请刷新。");
      this.assertCheckout(this.liveTask(taskId), spec);
      const receipt: WorktreeIntegrationReceipt = { ...old, verification: input.accept ? "reviewed" : "returned", review: { text: input.review.trim(), reviewedAt: now() } };
      this.save(taskId, { ...spec, receipts: spec.receipts.map((row) => row.operationId === operationId ? receipt : row) });
      this.changed(taskId);
      return receipt;
    });
  }

  verifyDelivery(task: Task, session: Session, input: unknown): TaskWorktreeEvidence[] | undefined {
    if (input !== undefined && (!Array.isArray(input) || input.length > 100)) throw new HostError("bad_request", "工作树证据必须是最多 100 项的列表。");
    const rows: TaskWorktreeEvidence[] = input as TaskWorktreeEvidence[] | undefined ?? [];
    const own = this.spec(task.id);
    const plane = planeManagedScope(this.store, task.id);
    if (plane && !task.lead) {
      if (!own) throw new HostError("conflict", "Plane 执行任务缺少已批准的独立工作树。");
      this.assertStartable(task.id, session.cwd ?? "");
      const target = this.assertCheckout(task, own);
      const headCommit = localGit(target.cwd, "rev-parse", "--verify", "HEAD^{commit}");
      if (!headCommit) throw new HostError("conflict", "无法确认 Plane 执行工作树的实际提交。");
      const integrations = own.receipts.filter((row) => (row.verification === "git" || row.verification === "reviewed") &&
        this.liveDependencies(task.id).includes(row.prerequisiteTaskId) && this.accepted(task.id, row.prerequisiteTaskId)?.id === row.prerequisiteResultId);
      return [{ taskId: task.id, sessionId: session.id, cwd: target.cwd, baseCommit: own.baseCommit, headCommit, ...planeChanges(target), ...(integrations.length ? { integrations } : {}) }];
    }
    const verified = rows.map((row) => {
      const taskId = row?.taskId, source = typeof taskId === "string" ? this.store.getTask(taskId) : undefined;
      const submittedBy = typeof row?.sessionId === "string" ? this.store.getSession(row.sessionId) : undefined;
      const spec = source ? this.spec(source.id) : null;
      if (!source || !submittedBy || submittedBy.taskId !== source.id || !spec?.ready || typeof row.cwd !== "string" || row.baseCommit !== spec.baseCommit) throw new HostError("conflict", "工作树证据与实际任务、会话或批准基准不匹配。");
      const target = this.assertCheckout(source, spec);
      if (!submittedBy.cwd || !samePath(row.cwd, target.cwd) || !samePath(submittedBy.cwd, target.cwd)) throw new HostError("conflict", "工作树证据与实际执行目录不匹配。");
      if (task.id !== source.id) {
        const accepted = this.accepted(task.id, source.id);
        if (!task.lead || !isManagedBy(this.store.listTasks(), source.id, task.id) || !accepted?.worktrees?.some((r) => r.sessionId === row.sessionId && r.headCommit === row.headCommit)) throw new HostError("conflict", "汇总只能引用本范围内当前已验收的工作树证据。");
      } else if (submittedBy.id !== session.id) throw new HostError("conflict", "只能登记实际交付会话的工作树证据。");
      const commit = row.headCommit;
      if (commit !== undefined && (!isObjectId(commit) || !ancestor(target.cwd, commit) || !ancestor(target.cwd, spec.baseCommit, commit))) throw new HostError("conflict", "证据提交不在批准基准及实际工作树的提交范围内。");
      return { taskId: source.id, sessionId: submittedBy.id, cwd: target.cwd, baseCommit: spec.baseCommit, ...(commit ? { headCommit: commit } : {}) };
    });
    if (own && !verified.length) {
      const target = this.assertCheckout(task, own);
      if (!own.ready || !session.cwd || !samePath(session.cwd, target.cwd)) throw new HostError("conflict", "交付未来自任务已分配的独立工作树。");
      const head = localGit(target.cwd, "rev-parse", "--verify", "HEAD^{commit}");
      verified.push({ taskId: task.id, sessionId: session.id, cwd: target.cwd, baseCommit: own.baseCommit, ...(head ? { headCommit: head } : {}) });
    }
    return verified.length ? verified : undefined;
  }

  assertPlaneEvidence(rows: readonly TaskWorktreeEvidence[]): void {
    for (const row of rows) {
      const spec = this.spec(row.taskId);
      if (!spec?.ready || spec.baseCommit !== row.baseCommit) throw new HostError("conflict", "Plane 执行工作树或批准基准已变化。");
      const target = this.assertCheckout(this.liveTask(row.taskId), spec);
      const actual = planeChanges(target);
      if (!row.changeDigest || !samePath(row.cwd, target.cwd) || localGit(target.cwd, "rev-parse", "--verify", "HEAD^{commit}") !== row.headCommit ||
          actual.changeDigest !== row.changeDigest || actual.workingTreeDirty !== row.workingTreeDirty) throw new HostError("conflict", "工作树改动与已提交的证据不同，请退回并从实际执行任务重新提交。");
      this.assertStartable(row.taskId, row.cwd);
    }
  }
}

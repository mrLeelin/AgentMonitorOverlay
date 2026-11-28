import { TASK_DESCRIPTION_MAX, type LinkedTeamTask, type Task, type TeamTask, type TeamTaskChange, type TeamTaskInboxItem, type TeamTaskSummary } from "@amo-studio/protocol";
import { RelayClient, RelayClientError } from "@amo-studio/relay/light";
import { Feature } from "../../core/feature.js";
import { HostError } from "../../core/shared.js";
import { TeamBoardHost } from "./board.js";
import { PlaneBotJobs } from "./plane-bot-jobs.js";

type Link = { task_id: string; server: string; ticket_id: string; started: number; awaiting_review: number };

export class TeamTasksFeature extends Feature<"tasks" | "bots" | "orchestration" | "sessions" | "botLeads"> {
  readonly board = new TeamBoardHost(this.host);
  readonly planeBots = new PlaneBotJobs(this.host, this.board);
  private client(server?: string): RelayClient {
    const account = this.teamLink.account;
    if (!account) throw new HostError("bad_request", "请先在 AMO 平台里登录");
    const client = new RelayClient(account.server, account.key);
    if (server && server !== client.server) throw new HostError("bad_request", "请登录这张任务所属的团队服务器");
    return client;
  }

  private async relay<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof HostError) throw error;
      if (error instanceof RelayClientError) {
        const code = error.status === 404 ? "not_found" : error.status === 409 ? "conflict" : error.status > 0 && error.status < 500 ? "bad_request" : "runtime_error";
        throw new HostError(code, error.status === 401 ? "团队登录已过期，请在 AMO 平台重新登录" : error.message);
      }
      throw new HostError("runtime_error", "团队服务器连接超时或断开，请刷新后重试");
    }
  }

  private link(taskId: string): Link | undefined {
    return this.store.db.prepare("SELECT * FROM local_team_tickets WHERE task_id = ?").get(taskId) as Link | undefined;
  }

  async list(): Promise<{ name: string | null; tickets: TeamTaskInboxItem[] }> {
    if (!this.teamLink.account) return { name: null, tickets: [] };
    const client = this.client();
    const [who, tickets] = await this.relay(() => Promise.all([client.teamTaskIdentity(), client.teamTaskList()]));
    const links = this.store.db.prepare("SELECT * FROM local_team_tickets WHERE server = ?").all(client.server) as Link[];
    const byTicket = new Map(links.map((link) => [link.ticket_id, link]));
    return { name: who.name, tickets: tickets.filter((ticket) => ticket.assignee === who.name).map((ticket) => {
      const link = byTicket.get(ticket.id);
      if (link) this.observe(link, ticket);
      return { ...ticket, localTaskId: link?.task_id ?? null };
    }) };
  }

  detail(id: string): Promise<TeamTask> {
    const client = this.client();
    return this.relay(() => client.teamTaskDetail(id));
  }

  async download(id: string, fileId: string): Promise<{ base64: string }> {
    const client = this.client();
    const data = await this.relay(() => client.teamTaskDownload(id, fileId));
    return { base64: Buffer.from(data).toString("base64") };
  }

  async import(id: string, workspaceId: string, topicId?: string): Promise<{ task: Task; existing: boolean }> {
    const workspace = this.store.getWorkspace(workspaceId);
    if (!workspace || workspace.archivedAt || workspace.builtin) throw new HostError("bad_request", "请选择一个本地项目来接收任务");
    const client = this.client();
    const [who, ticket] = await this.relay(() => Promise.all([client.teamTaskIdentity(), client.teamTaskDetail(id)]));
    if (ticket.assignee !== who.name) throw new HostError("bad_request", "只能接入分配给自己的任务");
    if (this.client().server !== client.server || this.client().key !== client.key) throw new HostError("conflict", "团队账号已切换，请重新打开收件箱");
    // There is no await between the lookup and the local task/link transaction.
    const prior = this.store.db.prepare("SELECT task_id FROM local_team_tickets WHERE server = ? AND ticket_id = ?").get(client.server, id);
    const existing = prior ? this.store.getTask(String(prior.task_id)) : undefined;
    if (existing) return { task: existing, existing: true };
    if (ticket.status === "done") throw new HostError("conflict", "这张团队任务已经完成");
    const attachmentNames = ticket.events.flatMap((event) => event.files.map((file) => file.name)).slice(0, 12);
    const firstMessage = `处理这张团队任务：${ticket.title}\n\n提交人：${ticket.creator}\n\n原单说明：\n${ticket.description}${attachmentNames.length ? `\n\n原单附件（在任务页下载）：${attachmentNames.join("、")}` : ""}`;
    const task = this.f.tasks.createTaskRecord({ title: ticket.title, workspaceId, ...(topicId ? { topicId } : {}), column: "todo", description: ticket.description.slice(0, TASK_DESCRIPTION_MAX), firstMessage }, (created) => {
      this.store.db.prepare("INSERT INTO local_team_tickets (task_id, server, ticket_id) VALUES (?, ?, ?)").run(created.id, client.server, id);
    });
    return { task, existing: false };
  }

  async local(taskId: string): Promise<LinkedTeamTask | null> {
    const link = this.link(taskId);
    if (!link) return null;
    const client = this.client(link.server);
    const ticket = await this.relay(() => client.teamTaskDetail(link.ticket_id));
    this.observe(link, ticket);
    return this.view(link, ticket);
  }

  sessionStarted(taskId: string): void {
    const link = this.link(taskId);
    if (!link || link.started || !this.host.teamTasksEnabled()) return;
    this.store.db.prepare("UPDATE local_team_tickets SET started = 1 WHERE task_id = ?").run(taskId);
    // The local session has started. A temporary outage must not make it look like session creation failed.
    void this.syncStart(link).catch((error: unknown) => this.host.log(`team task start could not sync: ${String(error)}`));
  }

  private async syncStart(link: Link): Promise<TeamTask> {
    const client = this.client(link.server);
    const ticket = await this.relay(() => client.teamTaskDetail(link.ticket_id));
    this.host.requireTeamTasks();
    return ticket.status === "pending" ? this.relay(() => client.teamTaskChange(ticket.id, { revision: ticket.revision, action: "start" })) : ticket;
  }

  async change(taskId: string, input: TeamTaskChange): Promise<LinkedTeamTask> {
    const link = this.link(taskId);
    const task = this.store.getTask(taskId);
    if (!link || !task) throw new HostError("not_found", "本地任务没有关联团队原单");
    if (task.archivedAt) throw new HostError("read_only", "请先恢复已归档的本地任务");
    if (input.action === "start") {
      if (!link.started) throw new HostError("conflict", "请先开始本地会话");
      return this.view(link, await this.syncStart(link));
    }
    if (input.action !== "deliver" && input.action !== "note") throw new HostError("bad_request", "请在团队任务客户端验收");
    const client = this.client(link.server);
    const ticket = await this.relay(() => client.teamTaskChange(link.ticket_id, input));
    if (input.action === "deliver" && this.store.getTask(taskId)) {
      this.store.db.prepare("UPDATE local_team_tickets SET awaiting_review = 1 WHERE task_id = ?").run(taskId);
      this.f.tasks.updateTask(taskId, { column: "review" });
    }
    return this.view(link, ticket);
  }

  private view(link: Link, ticket: TeamTask): LinkedTeamTask {
    return { ticket, needsStartSync: !!link.started && ticket.status === "pending" };
  }

  private observe(link: Link, ticket: TeamTaskSummary): void {
    if (!link.awaiting_review || (ticket.status !== "doing" && ticket.status !== "done") || !this.host.teamTasksEnabled()) return;
    const task = this.store.getTask(link.task_id);
    if (task?.archivedAt) return;
    this.store.db.prepare("UPDATE local_team_tickets SET awaiting_review = 0 WHERE task_id = ?").run(link.task_id);
    if (task?.column === "review") this.f.tasks.updateTask(task.id, { column: ticket.status });
  }
}

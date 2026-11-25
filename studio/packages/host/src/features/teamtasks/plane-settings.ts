import { dpapi, readJsonFile, writeJsonFile } from "@amo-studio/account";
import { PLANE_BOARD_API, TeamBoardClient, TeamBoardError, type PlaneBoardCatalog, type PlaneBoardConnection, type PlaneBoardSelection } from "@amo-studio/protocol";
import { dirname, join } from "node:path";
import type { FeatureHost } from "../../core/feature.js";
import { HostError } from "../../core/shared.js";

type SavedConnection = { owner: string; server: string; sealed: string; selected: PlaneBoardSelection | null };
const SLUG = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const SOURCE = /^\/workspaces\/([a-z0-9_-]+)\/projects\/([a-f0-9-]+)$/i;

export class PlaneBoardSettings {
  private decrypted?: { sealed: string; key: Promise<string> };
  private mutation = 0;

  constructor(private readonly host: FeatureHost) {}

  private get file(): string { return join(dirname(this.host.store.path), "plane-team-board.json"); }

  private owner(): string | null {
    const account = this.host.teamLink.account;
    return account ? JSON.stringify([account.server, account.name]) : null;
  }

  private records(): SavedConnection[] {
    const value: unknown = readJsonFile(this.file);
    return Array.isArray(value) ? value.filter((row) => row && typeof row.owner === "string" && typeof row.server === "string" && typeof row.sealed === "string") : [];
  }

  get current(): SavedConnection | undefined {
    const owner = this.owner();
    return owner ? this.records().find((row) => row.owner === owner) : undefined;
  }

  private assertOwner(owner: string, mutation: number): void {
    if (owner !== this.owner() || mutation !== this.mutation) throw new HostError("conflict", "团队账号或 Plane 连接已变更，请刷新后重试");
  }

  private requireOwner(): string {
    const owner = this.owner();
    if (!owner) throw new HostError("bad_request", "请先在 AMO 平台里登录");
    return owner;
  }

  private store(owner: string, row?: SavedConnection): void {
    const records = this.records().filter((old) => old.owner !== owner);
    writeJsonFile(this.file, row ? [...records, row] : records);
    this.decrypted = undefined;
  }

  private async key(row: SavedConnection): Promise<string> {
    if (this.decrypted?.sealed !== row.sealed) this.decrypted = { sealed: row.sealed, key: dpapi.unprotect(row.sealed) };
    try { return await this.decrypted.key; }
    catch { throw new HostError("bad_request", "这台电脑无法解锁 Plane 令牌，请重新连接"); }
  }

  private async catalog(server: string, key: string): Promise<PlaneBoardCatalog> {
    const result = await new TeamBoardClient(server, key, PLANE_BOARD_API, true).catalog().catch((error: unknown) => {
      if (error instanceof TeamBoardError && error.status === 404) throw new HostError("bad_request", "Plane 服务器尚未安装 Studio 团队任务接口");
      throw error;
    });
    if (!result?.identity?.id || typeof result.identity.name !== "string" || !Array.isArray(result.workspaces)) {
      throw new HostError("bad_request", "Plane 服务器尚未安装 Studio 团队任务接口");
    }
    return result;
  }

  private matches(catalog: PlaneBoardCatalog, selected: PlaneBoardSelection | null): boolean {
    return !!selected && catalog.workspaces.some((ws) => ws.slug === selected.workspace && ws.projects.some((p) => p.id === selected.project));
  }

  private view(row?: SavedConnection, catalog?: PlaneBoardCatalog): PlaneBoardConnection {
    return { available: !!this.owner(), legacy: !row && !!process.env.AMO_TEAM_BOARD_URL, server: row?.server ?? null, selected: row?.selected ?? null, catalog: catalog ?? null };
  }

  async connection(): Promise<PlaneBoardConnection> {
    const row = this.current;
    if (!row) return this.view();
    const catalog = await this.key(row).then((key) => this.catalog(row.server, key)).catch((error: unknown) => error);
    if (this.current?.sealed !== row.sealed) throw new HostError("conflict", "Plane 连接已变更，请刷新");
    if (catalog instanceof Error) return { ...this.view(row), selected: null, error: catalog instanceof HostError || catalog instanceof TeamBoardError ? catalog.message : "暂时无法连接 Plane，请尝试刷新或更改连接" };
    if (!catalog || typeof catalog !== "object" || !("identity" in catalog)) return { ...this.view(row), selected: null, error: "暂时无法连接 Plane" };
    const value = catalog as PlaneBoardCatalog;
    return { ...this.view(row, value), selected: this.matches(value, row.selected) ? row.selected : null };
  }

  async connect(server: unknown, token: unknown): Promise<PlaneBoardConnection> {
    const owner = this.requireOwner();
    const mutation = ++this.mutation;
    if (typeof server !== "string" || server.length > 512 || typeof token !== "string" || !/^[\w.-]{16,300}$/.test(token.trim())) throw new HostError("bad_request", "请输入 Plane 地址和个人访问令牌");
    let url: URL;
    try { url = new URL(server.trim()); }
    catch { throw new HostError("bad_request", "请输入完整的 Plane 地址或项目链接"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new HostError("bad_request", "Plane 地址格式不正确");
    const key = token.trim();
    const [catalog, sealed] = await Promise.all([this.catalog(url.origin, key), dpapi.protect(key)]);
    this.assertOwner(owner, mutation);
    const fromLink = /^\/([a-z0-9_-]+)\/projects\/([a-f0-9-]+)(?:\/|$)/i.exec(url.pathname);
    const prior = this.current;
    const requested = fromLink ? { workspace: fromLink[1]!, project: fromLink[2]! } : prior?.server === url.origin ? prior.selected : null;
    const row: SavedConnection = { owner, server: url.origin, sealed, selected: this.matches(catalog, requested) ? requested : null };
    this.store(owner, row);
    return this.view(row, catalog);
  }

  async select(workspace: unknown, project: unknown): Promise<PlaneBoardConnection> {
    const owner = this.requireOwner();
    const mutation = ++this.mutation;
    const row = this.current;
    if (!row) throw new HostError("bad_request", "请先连接 Plane");
    if (typeof workspace !== "string" || !SLUG.test(workspace) || typeof project !== "string" || !UUID.test(project)) throw new HostError("bad_request", "请选择 Plane 工作区和项目");
    const catalog = await this.catalog(row.server, await this.key(row));
    const selected = { workspace, project };
    if (!this.matches(catalog, selected)) throw new HostError("bad_request", "这个项目已不可访问，请重新选择");
    this.assertOwner(owner, mutation);
    const next = { ...row, selected };
    this.store(owner, next);
    return this.view(next, catalog);
  }

  disconnect(): PlaneBoardConnection {
    const owner = this.requireOwner();
    this.mutation++;
    this.store(owner);
    return this.view();
  }

  async client(source?: string): Promise<TeamBoardClient | null> {
    const row = this.current;
    if (!row) return null;
    let picked = row.selected;
    if (source) {
      const prefix = row.server + PLANE_BOARD_API;
      const match = source.startsWith(prefix) && SOURCE.exec(source.slice(prefix.length));
      if (!match || !SLUG.test(match[1]!) || !UUID.test(match[2]!)) return null;
      picked = { workspace: match[1]!, project: match[2]! };
    }
    if (!picked || !SLUG.test(picked.workspace) || !UUID.test(picked.project)) return null;
    const prefix = `${PLANE_BOARD_API}/workspaces/${picked.workspace}/projects/${picked.project}`;
    return new TeamBoardClient(row.server, await this.key(row), prefix, true);
  }

  async ticketReference(value: unknown): Promise<{ client: TeamBoardClient; ticketId: string }> {
    const row = this.current;
    if (!row) throw new HostError("bad_request", "请先连接 Plane");
    if (typeof value !== "string" || value.length > 512) throw new HostError("bad_request", "请粘贴完整的 Plane 原单链接");
    let url: URL;
    try { url = new URL(value.trim()); }
    catch { throw new HostError("bad_request", "请粘贴完整的 Plane 原单链接"); }
    if (url.origin !== row.server || url.username || url.password) throw new HostError("bad_request", "请粘贴当前已连接的 Plane 服务器上的原单链接");
    const path = url.pathname;
    const direct = /^\/([a-z0-9_-]+)\/projects\/([a-f0-9-]+)\/(?:issues|work-items)\/([a-f0-9-]+)\/?$/i.exec(path);
    const browse = /^\/([a-z0-9_-]+)\/browse\/([a-z0-9_-]+)-(\d{1,9})\/?$/i.exec(path);
    const workspace = (direct ?? browse)?.[1];
    if (!workspace || !SLUG.test(workspace) || (direct && (!UUID.test(direct[2]!) || !UUID.test(direct[3]!)))) {
      throw new HostError("bad_request", "请从 Plane 打开工作项后复制原单链接");
    }
    const key = await this.key(row);
    const resolved = direct ? { project: direct[2]!, ticketId: direct[3]! }
      : await new TeamBoardClient(row.server, key, PLANE_BOARD_API, true).resolve(workspace, browse![2]!, Number(browse![3]));
    if (!UUID.test(resolved.project) || !UUID.test(resolved.ticketId)) throw new HostError("bad_request", "Plane 返回的原单编号无效");
    if (this.current?.sealed !== row.sealed || this.current?.server !== row.server) throw new HostError("conflict", "Plane 连接已变更，请重试");
    return { client: new TeamBoardClient(row.server, key, `${PLANE_BOARD_API}/workspaces/${workspace}/projects/${resolved.project.toLowerCase()}`, true), ticketId: resolved.ticketId.toLowerCase() };
  }
}

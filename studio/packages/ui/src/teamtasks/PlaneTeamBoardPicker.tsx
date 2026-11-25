import { useId, useRef, useState, type FormEvent } from "react";
import type { PlaneBoardConnection } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { teamBoardMessage } from "./SharedTeamBoard.js";

export function PlaneTeamBoardPicker({ link, connection, onChange, onDraft }: {
  link: HostLink;
  connection: PlaneBoardConnection;
  onChange(value: PlaneBoardConnection): void;
  onDraft(value: boolean): void;
}) {
  const [editing, setEditing] = useState(false);
  const settingsId = useId();
  const settingsButton = useRef<HTMLButtonElement>(null);
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const workspaces = connection.catalog?.workspaces ?? [];
  const selectedWorkspace = workspace ?? connection.selected?.workspace ?? (workspaces.length === 1 ? workspaces[0]!.slug : "");
  const projects = workspaces.find((item) => item.slug === selectedWorkspace)?.projects ?? [];
  const selectedProject = connection.selected?.workspace === selectedWorkspace ? connection.selected?.project ?? "" : "";
  const project = projects.find((item) => item.id === selectedProject);
  const projectUrl = project && connection.server
    ? `${connection.server}/${encodeURIComponent(selectedWorkspace)}/projects/${encodeURIComponent(project.id)}/issues/`
    : null;

  async function update(operation: () => Promise<PlaneBoardConnection>) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const next = await operation();
      setEditing(false); setWorkspace(null);
      onDraft(false); onChange(next);
    } catch (err) { setError(teamBoardMessage(err)); }
    finally { setBusy(false); }
  }

  function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void update(() => call(link, "POST /api/team-board/plane/connect", undefined, { server: String(data.get("server")).trim(), token: String(data.get("token")).trim() }));
  }

  if (!connection.available) return <p className="tb-empty">请先在 AMO 平台里登录，再点刷新。</p>;
  return <div className="tb-plane">
    {connection.catalog && <div className="tb-plane-fields">
      <label>Plane 工作区<select value={selectedWorkspace} disabled={busy} onChange={(event) => {
        const value = event.target.value;
        setWorkspace(value);
        onDraft(!!connection.selected && value !== connection.selected.workspace);
      }}>
        <option value="">请选择工作区</option>
        {workspaces.map((item) => <option key={item.slug} value={item.slug}>{item.name}</option>)}
      </select></label>
      <label>Plane 项目<select value={selectedProject} disabled={busy || !projects.length} onChange={(event) => {
        const value = event.target.value;
        if (value) void update(() => call(link, "POST /api/team-board/plane/select", undefined, { workspace: selectedWorkspace, project: value }));
      }}>
        <option value="">请选择项目</option>
        {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
    </div>}
    {connection.catalog && <div className="tb-plane-tools">
      <button ref={settingsButton} className="tb-button tb-quiet" type="button" aria-expanded={editing} aria-controls={editing ? settingsId : undefined} disabled={busy} onClick={() => setEditing(!editing)}>
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
        连接设置
      </button>
      {projectUrl && window.amo?.openExternal && <button className="tb-button tb-quiet tb-plane-open" type="button" onClick={() => {
        void window.amo?.openExternal?.(projectUrl).catch((err) => setError(teamBoardMessage(err)));
      }}>在 Plane 打开<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8.5 3h4.5v4.5M13 3 7 9m-.5-5H3v9h9V9.5" /></svg></button>}
    </div>}
    {connection.catalog && workspaces.length === 0 && <p className="tb-meta">此令牌没有可访问的 Plane 项目。</p>}
    {!!selectedWorkspace && workspaces.length > 0 && !projects.length && <p className="tb-meta">此工作区没有可访问的 Plane 项目。</p>}
    {project && !project.writable && <p className="tb-meta">当前账号在此项目中只有查看权限。</p>}
    {(!connection.catalog || editing) && <form className="tb-form tb-plane-form" id={settingsId} onSubmit={connect}>
      {connection.catalog && <p className="tb-meta">Plane 账号 <strong>{connection.catalog.identity.name}</strong></p>}
      <label>Plane 地址或项目链接<input name="server" type="url" autoComplete="off" defaultValue={connection.server ?? ""} required /></label>
      <label>Plane 个人访问令牌<input type="password" name="token" autoComplete="off" required /></label>
      <p className="tb-meta">在 Plane 的「个人资料 → 个人访问令牌」创建并复制令牌。</p>
      <div className="tb-row">
        <button className="tb-button tb-primary" type="submit" disabled={busy}>{connection.catalog ? "更新连接" : "连接 Plane"}</button>
        {connection.catalog && <>
          <button className="tb-button" type="button" disabled={busy} onClick={() => { setEditing(false); settingsButton.current?.focus(); }}>取消</button>
          <button className="tb-button tb-quiet tb-plane-disconnect" type="button" disabled={busy} onClick={() => void update(() => call(link, "POST /api/team-board/plane/disconnect"))}>断开连接</button>
        </>}
      </div>
    </form>}
    {(error || connection.error) && <p className="tb-error" role="alert">{error || connection.error}</p>}
  </div>;
}

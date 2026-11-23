import { useEffect, useState } from "react";
import type { CatalogSkill, SkillCatalog, SkillSource, Workspace } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { viewFile } from "../files/FileLinks.js";
import { revealInExplorer } from "../lib/openin.js";
import { IconChevronRight } from "../chat/icons.js";
import "./skills.css";

type Scope = "global" | "project" | "discover";
type Status = "all" | "normal" | "diagnostic";
const SCOPES = [{ id: "global", label: "全局技能" }, { id: "project", label: "项目技能" }, { id: "discover", label: "发现技能" }] as const;
const DIRECTORIES = [
  { id: "git", name: "Git 仓库", title: "Anthropic Skills", subtitle: "anthropics / skills", description: "浏览官方示例技能，查看 SKILL.md、脚本和配套资源。", url: "https://github.com/anthropics/skills", action: "浏览仓库" },
  { id: "clawhub", name: "ClawHub", title: "ClawHub", subtitle: "技能与插件社区", description: "前往 ClawHub 搜索技能，查看作者、说明和安装方式。", url: "https://clawhub.ai/", action: "前往 ClawHub" },
  { id: "skills", name: "skills.sh", title: "The Agent Skills Directory", subtitle: "skills.sh", description: "按热门榜单或关键词发现技能，查看来源仓库与安装说明。", url: "https://skills.sh/", action: "前往 skills.sh" },
] as const;

/** A disk inventory is deliberately separate from the commands a running model says it has loaded. */
export function SkillsPage({ link, projects }: { link: HostLink; projects: Workspace[] }) {
  const [scope, setScope] = useState<Scope>("global");
  const [project, setProject] = useState(projects[0]?.id ?? "");
  const workspaceId = projects.some((w) => w.id === project) ? project : projects[0]?.id ?? "";
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null);
  const [search, setSearch] = useState("");
  const [source, setSource] = useState("all");
  const [status, setStatus] = useState<Status>("all");
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [expanded, setExpanded] = useState<Map<string, boolean>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);
  const [directory, setDirectory] = useState<(typeof DIRECTORIES)[number]["id"]>("git");

  useEffect(() => {
    let live = true;
    setCatalog(null); setError(""); setNotice(""); setSelected(null);
    if (scope === "discover" || (scope === "project" && !workspaceId)) { setLoading(false); return; }
    setLoading(true);
    call(link, "GET /api/skills", {}, undefined, scope === "project" ? { workspaceId } : undefined).then((value) => {
      if (!live) return;
      setCatalog(value);
      setExpanded(new Map());
    }).catch((err: unknown) => {
      if (live) setError(err instanceof HostApiError && err.status === 404 && /no route|route not found/i.test(err.message) ? "当前后台尚未提供技能目录。请在会话空闲时手动重启源码版 Studio 后重试。" : err instanceof Error ? err.message : String(err));
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [link.url, link.token, scope, workspaceId, revision]);

  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const skills = catalog?.sources.flatMap((s) => s.skills) ?? [];
  const issues = skills.filter((s) => s.diagnostics.length > 0).length;
  const directoryIssues = catalog?.sources.filter((s) => s.diagnostics.length > 0).length ?? 0;
  const match = (skill: CatalogSkill, s: SkillSource) => (status === "all" || (status === "diagnostic" ? skill.diagnostics.length > 0 : !skill.diagnostics.length)) && terms.every((term) => `${skill.name} ${skill.description} ${skill.path} ${s.name} ${skill.diagnostics.join(" ")}`.toLowerCase().includes(term));
  const groups = catalog?.sources.filter((s) => source === "all" || source === s.id).map((s) => ({ ...s, visible: s.skills.filter((skill) => match(skill, s)) })).filter((s) => (!terms.length && status === "all") || s.visible.length || (status === "diagnostic" && s.diagnostics.length && !terms.length)) ?? [];
  const shown = groups.reduce((count, s) => count + s.visible.length, 0);
  const filtered = terms.length > 0 || status !== "all" || source !== "all";
  const activeDirectory = DIRECTORIES.find((d) => d.id === directory)!;

  function changeScope(next: Scope) {
    setScope(next); setSource("all"); setSearch(""); setStatus("all"); setError(""); setNotice("");
  }

  async function reveal(path: string) {
    setNotice("");
    try {
      await revealInExplorer(link, { path });
    } catch (err) { setNotice(err instanceof Error ? err.message : String(err)); }
  }

  async function visit(url: string) {
    setNotice("");
    try {
      if (window.amo?.openExternal) await window.amo.openExternal(url);
      else window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) { setNotice(err instanceof Error ? err.message : String(err)); }
  }

  return <section className="skills-page" aria-label="技能展览" data-testid="skills-page">
    <div className="skills-tabs" role="tablist" aria-label="技能范围" onKeyDown={(e) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      const index = SCOPES.findIndex((tab) => tab.id === scope);
      const next = SCOPES[e.key === "Home" ? 0 : e.key === "End" ? SCOPES.length - 1 : (index + (e.key === "ArrowRight" ? 1 : SCOPES.length - 1)) % SCOPES.length]!;
      changeScope(next.id);
      document.getElementById(`skills-scope-${next.id}`)?.focus();
    }}>
      {SCOPES.map((tab) => <button key={tab.id} type="button" role="tab" tabIndex={scope === tab.id ? 0 : -1} aria-selected={scope === tab.id} aria-controls="skills-content" id={`skills-scope-${tab.id}`} onClick={() => changeScope(tab.id)}>{tab.label}</button>)}
    </div>
    <div id="skills-content" role="tabpanel" aria-labelledby={`skills-scope-${scope}`} className="skills-content">
      {scope === "discover" ? <>
        <div className="skills-discover-tabs" role="group" aria-label="技能目录">{DIRECTORIES.map((d) => <button key={d.id} type="button" className="btn-ghost small" aria-pressed={directory === d.id} onClick={() => setDirectory(d.id)}>{d.name}</button>)}</div>
        {/* 设置整理 (2026-11-23): the directory's name leads, where it lives under it; no glyph tile, no line over the title. */}
        <article className="skills-discover-card">
          <h3>{activeDirectory.title}</h3><span className="skills-discover-source">{activeDirectory.subtitle}</span><p>{activeDirectory.description}</p>
          <button type="button" className="btn-primary small" onClick={() => void visit(activeDirectory.url)}>{activeDirectory.action} ↗</button>
        </article>
        <p className="settings-hint">在浏览器中查看目录及安装说明。安装完成后，回到全局或项目技能页点击「刷新」。</p>
      </> : <>
        {scope === "project" && <label className="skills-project"><span>当前项目</span><select className="field" aria-label="技能项目" value={workspaceId} onChange={(e) => { setProject(e.target.value); setSource("all"); }}>{!projects.length && <option value="">暂无项目</option>}{projects.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>}
        <div className="skills-stats" aria-label="技能统计">
          <span><strong>{catalog ? skills.length : "—"}</strong> 技能条目</span>
          <span><strong>{catalog ? catalog.sources.filter((s) => s.skills.length).length : "—"}</strong> 有技能的来源</span>
          <span className={issues + directoryIssues ? "skills-warning" : undefined}><strong>{catalog ? issues + directoryIssues : "—"}</strong> 诊断提示</span>
        </div>
        <div className="skills-toolbar">
          <select className="field" aria-label="技能来源" value={source} onChange={(e) => setSource(e.target.value)}><option value="all">全部来源</option>{catalog?.sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          <select className="field" aria-label="技能状态" value={status} onChange={(e) => setStatus(e.target.value as Status)}><option value="all">全部状态</option><option value="normal">无诊断提示</option><option value="diagnostic">有诊断提示</option></select>
          <input className="field skills-search" type="search" aria-label="搜索技能" placeholder="搜索技能名称、描述或路径" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button type="button" className="btn-ghost small skills-refresh" aria-label="刷新技能" title="重新扫描技能目录" disabled={loading || (scope === "project" && !workspaceId)} onClick={() => setRevision((n) => n + 1)}>刷新</button>
        </div>
        {loading ? <div className="skills-empty" role="status">正在读取技能目录…</div> : error ? <div className="skills-empty skills-error" role="alert"><strong>技能目录读取失败</strong><span>{error}</span><button type="button" className="btn-ghost small" onClick={() => setRevision((n) => n + 1)}>重试</button></div> : scope === "project" && !workspaceId ? <div className="skills-empty">先在 Studio 添加项目，再查看项目技能。</div> : catalog && <>
          {filtered && <div className="skills-result" role="status">找到 {shown} 个技能条目<button type="button" className="link-btn" onClick={() => { setSearch(""); setSource("all"); setStatus("all"); }}>清除筛选</button></div>}
          {!groups.length && <div className="skills-empty">没有匹配的技能，试试其他关键词或来源。</div>}
          <div className="skills-groups">{groups.map((s) => {
            const open = expanded.get(s.id) ?? (terms.length > 0 || status !== "all");
            return <div className="skills-source" key={s.id} data-testid="skill-source" data-source={s.id}>
              <div className="skills-source-head">
                <button type="button" className="skills-source-toggle" aria-expanded={open} aria-controls={`skills-source-${s.id}`} onClick={() => setExpanded((prev) => new Map(prev).set(s.id, !open))}>
                  <span className="skills-chevron" aria-hidden="true"><IconChevronRight /></span><span className={`skills-source-icon skills-icon-${s.id}`} aria-hidden="true">{s.name.slice(0, 1)}</span><strong>{s.name}</strong><span className="skills-source-count">{s.visible.length} 个技能</span><span className="skills-source-path" title={s.root}>{s.root}</span>
                </button>
                <button type="button" className="skills-folder btn-ghost small" aria-label={`打开 ${s.name} 技能目录`} title={s.exists ? "在资源管理器中打开目录" : "目录不存在"} disabled={!s.exists} onClick={() => void reveal(s.root)}>打开</button>
              </div>
              {open && <div id={`skills-source-${s.id}`} className="skills-source-body">
                {s.diagnostics.map((d, i) => <p key={i} className="skills-diagnostic">{d}</p>)}
                {!s.visible.length && <p className="skills-source-empty">{s.exists ? "这个目录还没有技能。" : "本机尚无这个技能目录。"}</p>}
                {s.visible.map((skill) => {
                  const key = `${s.id}:${skill.path}`;
                  return <article key={skill.path} className="skills-item" data-testid="skill-item">
                    <div className="skills-item-top"><button type="button" className="skills-item-name" aria-expanded={selected === key} onClick={() => setSelected(selected === key ? null : key)}>{skill.name}</button>{skill.diagnostics.length > 0 && <span className="skills-warning skills-item-badge">有诊断</span>}<button type="button" className="btn-ghost small" aria-label={`查看 ${skill.name} 说明`} onClick={() => viewFile({ file: { path: skill.path } }, null)}>查看说明 ↗</button></div>
                    <p className={selected === key ? "skills-description expanded" : "skills-description"}>{skill.description || "未提供技能描述"}</p>
                    {selected === key && <><code className="skills-item-path">{skill.path}</code>{skill.diagnostics.map((d, i) => <p className="skills-diagnostic" key={i}>{d}</p>)}</>}
                  </article>;
                })}
              </div>}
            </div>;
          })}</div>
          {catalog.notes.map((note, i) => <p className="settings-hint" key={i}>{note}</p>)}
          <p className="skills-footnote">按目录展示，同一技能可能出现在多个来源中。模型实际加载的技能以会话中的 <code>$</code> 菜单为准。</p>
        </>}
      </>}
      {notice && <p className="skills-error" role="status">{notice}</p>}
    </div>
  </section>;
}

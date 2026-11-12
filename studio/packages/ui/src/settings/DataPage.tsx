import { useCallback, useEffect, useState } from "react";
import { DATA_KIND_LABEL, type ArchivedEntry, type DataKind, type PurgeSummary, type PurgeBatchSummary } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { onHostEvent } from "../host/events.js";
import { ConfirmDialog } from "../lib/ConfirmDialog.js";
import { formatDay } from "../task/Archived.js";

// 设置 → 数据管理 (2026-10-14): what is archived (projects, topics, tasks, sessions), restored to where it was or
// deleted for good. Deleting asks first and says what goes with it.

const FILTERS: { id: DataKind | "all"; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "workspace", label: "项目" },
  { id: "topic", label: "专题" },
  { id: "task", label: "任务" },
  { id: "session", label: "会话" },
];

/** Events after which the list may have changed. */
const REFRESH = new Set(["workspace.upserted", "topic.upserted", "task.upserted", "session.upserted", "data.purged"]);

function restore(link: HostLink, e: ArchivedEntry): Promise<unknown> {
  if (e.kind === "workspace") return call(link, "POST /api/workspaces/:id/unarchive", { id: e.id });
  if (e.kind === "topic") return call(link, "POST /api/topics/:id/unarchive", { id: e.id });
  if (e.kind === "task") return call(link, "POST /api/tasks/:id/unarchive", { id: e.id });
  return call(link, "POST /api/sessions/:id/unarchive", { id: e.id });
}

/** "3 个任务、5 个会话、120 条对话记录". */
function takes(s: PurgeSummary): string {
  const parts = [
    s.kind !== "topic" && s.topics ? `${s.topics} 个专题` : "",
    s.kind !== "task" && s.tasks ? `${s.tasks} 个任务` : "",
    s.sessions ? `${s.sessions} 个会话` : "",
    s.items ? `${s.items} 条对话记录` : "",
    s.attachments ? `${s.attachments} 张贴进对话的图片` : "",
  ].filter(Boolean);
  return parts.length ? parts.join("、") : "没有别的内容";
}

function batchTakes(s: PurgeBatchSummary): string {
  return [[s.workspaces, "个项目"], [s.topics, "个专题"], [s.tasks, "个任务"], [s.sessions, "个会话"], [s.items, "条对话记录"], [s.attachments, "张贴进对话的图片"]].filter(([n]) => n).map(([n, label]) => `${n} ${label}`).join("、");
}

export function DataPage({ link }: { link: HostLink }) {
  const [entries, setEntries] = useState<ArchivedEntry[] | null>(null);
  const [filter, setFilter] = useState<DataKind | "all">("all");
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [confirm, setConfirm] = useState<{ entry: ArchivedEntry; summary: PurgeSummary } | null>(null);
  const [batchConfirm, setBatchConfirm] = useState<{ entries: ArchivedEntry[]; summary: PurgeBatchSummary; legacy?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [retentionDays, setRetentionDays] = useState<1 | 3 | 5 | 7 | null>(7);
  const [retentionLoaded, setRetentionLoaded] = useState(false);
  const [retentionSaving, setRetentionSaving] = useState(false);

  useEffect(() => {
    let active = true;
    setRetentionLoaded(false);
    call(link, "GET /api/data/retention").then((settings) => {
      if (!active) return;
      setRetentionDays(settings.taskRetentionDays);
      setRetentionLoaded(true);
    }).catch((err: unknown) => {
      if (active) setMessage({ text: `读取自动删除设置失败：${err instanceof HostApiError ? err.message : String(err)}`, error: true });
    });
    return () => { active = false; };
  }, [link]);

  const load = useCallback(() => {
    call(link, "GET /api/data/archived")
      .then(setEntries)
      .catch((err: unknown) => setMessage({ text: err instanceof HostApiError ? err.message : String(err), error: true }));
  }, [link]);

  useEffect(() => {
    load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onHostEvent((e) => {
      if (!REFRESH.has(e.type)) return;
      clearTimeout(timer);
      timer = setTimeout(load, 150);
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [load]);

  const fail = (err: unknown) => setMessage({ text: err instanceof HostApiError ? err.message : String(err), error: true });

  async function saveRetention(value: string) {
    const days = value === "never" ? null : Number(value) as 1 | 3 | 5 | 7;
    setRetentionSaving(true);
    setMessage(null);
    try {
      const settings = await call(link, "PUT /api/data/retention", {}, { taskRetentionDays: days });
      setRetentionDays(settings.taskRetentionDays);
      setMessage({ text: days === null ? "已关闭归档任务自动删除" : `已设置归档任务 ${days} 天后自动删除` });
    } catch (err) {
      fail(err);
    } finally {
      setRetentionSaving(false);
    }
  }

  async function onRestore(e: ArchivedEntry) {
    setBusy(e.id);
    setMessage(null);
    try {
      await restore(link, e);
      setMessage({ text: `已恢复${DATA_KIND_LABEL[e.kind]}「${e.title}」` });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  async function askDelete(e: ArchivedEntry) {
    setBusy(e.id);
    setMessage(null);
    try {
      const summary = await call(link, "GET /api/data/purge", {}, undefined, { kind: e.kind, id: e.id });
      setConfirm({ entry: e, summary });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  async function onDelete() {
    if (!confirm) return;
    setBusy(confirm.entry.id);
    try {
      const done = await call(link, "POST /api/data/purge", {}, { kind: confirm.entry.kind, id: confirm.entry.id });
      setConfirm(null);
      setMessage({ text: `已彻底删除${DATA_KIND_LABEL[done.kind]}「${done.title}」` });
    } catch (err) {
      setConfirm(null);
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  async function askDeleteAll() {
    if (!entries?.length || busy) return;
    setBusy("batch");
    setMessage(null);
    try {
      try {
        const summary = await call(link, "POST /api/data/purge-preview", {}, { entries });
        setBatchConfirm({ entries, summary });
      } catch (err) {
        // A renderer refresh can precede a Host restart. Only an absent route enables compatibility mode.
        if (!(err instanceof HostApiError && err.status === 404 && err.message.includes("no route for POST /api/data/purge-preview"))) throw err;
        const summary: PurgeBatchSummary = { workspaces: 0, topics: 0, tasks: 0, sessions: 0, items: 0, attachments: 0 };
        const keys = { workspace: "workspaces", topic: "topics", task: "tasks", session: "sessions" } as const;
        for (const entry of entries) summary[keys[entry.kind]]++;
        setBatchConfirm({ entries, summary, legacy: true });
      }
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  async function onDeleteAll() {
    if (!batchConfirm || busy) return;
    setBusy("batch");
    try {
      if (batchConfirm.legacy) {
        let deleted = 0;
        let pending = batchConfirm.entries;
        while (pending.length) {
          const deferred: ArchivedEntry[] = [];
          const reasons: string[] = [];
          for (const entry of pending) {
            try {
              await call(link, "POST /api/data/purge", {}, { kind: entry.kind, id: entry.id });
              deleted++;
            } catch (err) {
              if (err instanceof HostApiError && err.code === "conflict") {
                deferred.push(entry);
                reasons.push(`${DATA_KIND_LABEL[entry.kind]}「${entry.title}」：${err.message}`);
                continue;
              }
              // An earlier owner deletion may already have removed an overlapping archived entry.
              if (err instanceof HostApiError && err.status === 404 && err.code === "not_found" && !err.message.includes("no route")) {
                deleted++;
                continue;
              }
              setMessage({ text: `已删除 ${deleted} 项，剩余 ${batchConfirm.entries.length - deleted} 项未处理。删除${DATA_KIND_LABEL[entry.kind]}「${entry.title}」失败：${err instanceof Error ? err.message : String(err)}`, error: true });
              return;
            }
          }
          // Retry blocked owners only after some of their dependencies have actually been removed.
          if (deferred.length === pending.length) {
            setMessage({ text: `已删除 ${deleted} 项，剩余 ${deferred.length} 项未处理。仍有依赖阻止删除：${reasons.slice(0, 3).join("；")}。`, error: true });
            return;
          }
          pending = deferred;
        }
        setMessage({ text: `已彻底删除：${batchTakes(batchConfirm.summary)}及其所属记录。` });
      } else {
        const done = await call(link, "POST /api/data/purge-batch", {}, { entries: batchConfirm.entries });
        setMessage({ text: `已彻底删除：${batchTakes(done)}。` });
      }
    } catch (err) {
      fail(err);
    } finally {
      setBatchConfirm(null);
      setBusy(null);
      load();
    }
  }

  const shown = (entries ?? []).filter((e) => filter === "all" || e.kind === filter);
  const count = (k: DataKind | "all") => (entries ?? []).filter((e) => k === "all" || e.kind === k).length;

  return (
    <section className="settings-section" aria-label="数据管理">
      <span className="settings-heading">数据管理</span>
      <span className="settings-hint">
        已归档的项目、专题、任务和会话。恢复后回到原处；彻底删除后找不回来。项目文件夹里的文件，以及 Codex、Claude Code 自己保存的对话记录，都不会被删除。
      </span>
      <label className="settings-row">
        <span className="settings-label">归档任务自动删除</span>
        <select className="field" aria-label="归档任务自动删除" value={retentionDays ?? "never"} disabled={!retentionLoaded || retentionSaving} onChange={(e) => void saveRetention(e.target.value)}>
          {[1, 3, 5, 7].map((days) => <option key={days} value={days}>{days} 天后自动删除</option>)}
          <option value="never">不自动删除</option>
        </select>
        {retentionSaving && <span className="settings-hint" role="status">保存中…</span>}
      </label>
      <span className="settings-hint">从任务归档时开始计时，已有的归档任务也适用。到期后彻底删除任务及所属的已归档会话，删除后不能恢复；提前恢复任务可取消自动删除。</span>
      <div className="data-toolbar">
        <div role="radiogroup" aria-label="类型" className="chips">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" role="radio" className="chip" aria-checked={filter === f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label} {count(f.id)}
            </button>
          ))}
        </div>
        <button type="button" className="btn-ghost small danger" disabled={!entries?.length || busy !== null} onClick={() => void askDeleteAll()} data-testid="data-delete-all" title="彻底删除所有类型的已归档内容">全部删除</button>
      </div>
      {message && (
        <span className={message.error ? "form-error" : "settings-hint"} role={message.error ? "alert" : "status"} data-testid="data-message">
          {message.text}
        </span>
      )}
      {entries === null ? (
        <span className="settings-hint">读取中…</span>
      ) : shown.length === 0 ? (
        <span className="settings-hint" data-testid="data-empty">
          {filter === "all" ? "没有已归档的内容。" : `没有已归档的${DATA_KIND_LABEL[filter]}。`}
        </span>
      ) : (
        <ul className="data-list" data-testid="data-list">
          {shown.map((e) => (
            <li key={`${e.kind}:${e.id}`} className="data-row" data-testid="data-row" data-kind={e.kind}>
              <span className="data-kind">{DATA_KIND_LABEL[e.kind]}</span>
              <span className="data-main">
                <span className="data-title">{e.title}</span>
                <span className="data-meta">{[e.context, `${formatDay(e.archivedAt)} 归档`].filter(Boolean).join(" · ")}</span>
              </span>
              <span className="data-actions">
                <button type="button" className="btn-ghost small" disabled={busy !== null} onClick={() => void onRestore(e)} data-testid="data-restore">
                  恢复
                </button>
                <button type="button" className="btn-ghost small danger" disabled={busy !== null} onClick={() => void askDelete(e)} data-testid="data-delete">
                  彻底删除
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {batchConfirm && (
        <ConfirmDialog title="彻底删除全部已归档内容？" action="全部删除" danger busy={busy === "batch"} onCancel={() => setBatchConfirm(null)} onConfirm={() => void onDeleteAll()} testId="data-delete-all-confirm">
          <ul className="confirm-risks">
            <li>删除所有类型的已归档内容，不受当前类型筛选影响：{batchTakes(batchConfirm.summary)}。</li>
            {batchConfirm.legacy && <li>当前后台使用逐项删除，所属记录一并清理；依赖阻挡的条目会暂缓，删除其他条目后重试。仍有依赖的内容会保留，其他失败会停止；已经删除的内容不会恢复。</li>}
            <li>只删除 Studio 里的记录，项目文件夹本身和里面的文件不动。</li>
            <li>Codex、Claude Code 自己保存的对话记录不会被删除。</li>
            <li>删除后不能恢复。仅删除本次确认的条目及其所属记录。</li>
          </ul>
        </ConfirmDialog>
      )}
      {confirm && (
        <ConfirmDialog
          title={`彻底删除${DATA_KIND_LABEL[confirm.entry.kind]}「${confirm.entry.title}」？`}
          action="彻底删除"
          danger
          busy={busy === confirm.entry.id}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void onDelete()}
          testId="data-delete-confirm"
        >
          <ul className="confirm-risks">
            <li>一起删除：{takes(confirm.summary)}。</li>
            {confirm.entry.kind === "workspace" && <li>只删除 Studio 里的记录（任务、会话、批注、文件标记），项目文件夹本身和里面的文件不动。</li>}
            <li>Codex、Claude Code 自己保存的对话记录不会被删除。</li>
            <li>删除后不能恢复。</li>
          </ul>
        </ConfirmDialog>
      )}
    </section>
  );
}

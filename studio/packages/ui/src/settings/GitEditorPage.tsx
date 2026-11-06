import { useEffect, useState } from "react";
import type { GitEditorState } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";

/** The Git client belongs to this computer; the branch link opens the project's repository in it. */
export function GitEditorPage({ link }: { link: HostLink }) {
  const [state, setState] = useState<GitEditorState | null>(null);
  const [manual, setManual] = useState(false);
  const [path, setPath] = useState("");
  const [operation, setOperation] = useState<"loading" | "detecting" | "saving" | null>("loading");
  const busy = operation !== null;
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const fail = (err: unknown, prefix = "") => setMessage({ text: prefix + (err instanceof HostApiError && err.status === 404 ? "当前后台尚未加载 Git 编辑器功能。请等会话结束后，退出并重新打开 Studio，再点击「自动检测」。" : err instanceof HostApiError ? err.message : String(err)), error: true });
  const shownEditor = manual ? state?.selected : state?.detected[0];

  function apply(next: GitEditorState) {
    setState(next);
    setManual(!!next.configuredPath);
    setPath(next.configuredPath ?? "");
  }

  useEffect(() => {
    let live = true;
    setOperation("loading");
    void call(link, "GET /api/git-editor").then((next) => { if (live) apply(next); }).catch((err: unknown) => { if (live) fail(err); }).finally(() => { if (live) setOperation(null); });
    return () => { live = false; };
  }, [link]);

  async function detect() {
    setManual(false);
    setOperation("detecting");
    setMessage(null);
    try {
      const next = await call(link, "GET /api/git-editor");
      // Detect again on every click, including when automatic mode is already selected. Keep the saved choice until 保存.
      setState(next);
      setMessage({ text: next.detected.length ? `检测到 ${next.detected.map((editor) => editor.name).join("、")}。点击保存，使用自动检测结果。` : "未检测到支持的 Git 编辑器。请切换到「指定程序」选择 .exe 文件。" });
    } catch (err) {
      fail(err, "检测失败：");
    } finally {
      setOperation(null);
    }
  }

  async function save() {
    setOperation("saving");
    setMessage(null);
    try {
      apply(await call(link, "PUT /api/git-editor", {}, { path: manual ? path.trim() : null }));
      setMessage({ text: "已保存。点击任务标题下的分支名，即可打开仓库。" });
    } catch (err) {
      fail(err);
    } finally {
      setOperation(null);
    }
  }

  async function pick() {
    try {
      const chosen = await window.amo?.pickGitEditor?.();
      if (chosen) { setPath(chosen); setManual(true); setMessage(null); }
    } catch (err) {
      fail(err);
    }
  }

  return (
    <section className="settings-section" aria-label="Git 编辑器" data-testid="git-editor-settings">
      <span className="settings-heading">Git 编辑器</span>
      <span className="settings-hint">点击任务标题下的分支名，用这里选的 Git 编辑器打开该项目的仓库。</span>
      <div className="settings-row">
        <span className="settings-label">打开方式</span>
        <div role="radiogroup" aria-label="Git 编辑器打开方式" className="chips">
          <button type="button" role="radio" className="chip" aria-checked={!manual} aria-pressed={!manual} disabled={busy} onClick={() => void detect()}>自动检测</button>
          <button type="button" role="radio" className="chip" aria-checked={manual} aria-pressed={manual} disabled={busy} onClick={() => { setManual(true); setMessage(null); }}>指定程序</button>
        </div>
      </div>
      <span className="settings-hint">自动查找 Fork、Sourcetree、GitHub Desktop 和 GitKraken；装了多个时，可以在下面指定常用的那个。</span>
      {state && (
        <div className="settings-row" data-testid="git-editor-current">
          <span className="settings-label">{!manual && state.configuredPath ? "检测结果" : "当前使用"}</span>
          <span className="settings-hint" style={{ overflowWrap: "anywhere" }}>{shownEditor ? `${shownEditor.name} · ${shownEditor.path}` : "没有找到可用的 Git 编辑器，请指定程序。"}</span>
        </div>
      )}
      {!!state?.detected.length && (
        <div className="settings-row">
          <span className="settings-label">检测到</span>
          <div className="chips">
            {state.detected.map((editor) => <button type="button" key={editor.path} className="chip" title={editor.path} disabled={busy} onClick={() => { setManual(true); setPath(editor.path); setMessage(null); }}>{editor.name}</button>)}
          </div>
        </div>
      )}
      {manual && <>
        <label className="settings-label" htmlFor="git-editor-path">程序路径</label>
        <div className="settings-row">
          <input id="git-editor-path" className="field" value={path} onChange={(e) => { setPath(e.target.value); setMessage(null); }} placeholder="例如 C:\\Users\\你的用户名\\AppData\\Local\\Fork\\current\\Fork.exe" disabled={busy} />
          {window.amo?.pickGitEditor && <button type="button" className="btn-ghost small" onClick={() => void pick()} disabled={busy}>选择程序…</button>}
        </div>
        <span className="settings-hint">选择 Git 编辑器的 .exe 文件。其他程序会把仓库路径作为启动参数接收。</span>
      </>}
      <div className="settings-row end">
        <button type="button" className="btn-primary small" onClick={() => void save()} disabled={busy || !state || (manual && !path.trim())}>保存</button>
      </div>
      {operation && <span className="settings-hint" role="status">{operation === "detecting" ? "正在检测 Git 编辑器…" : operation === "saving" ? "正在保存…" : "正在读取 Git 编辑器…"}</span>}
      {message && <span className={message.error ? "form-error" : "settings-hint"} role={message.error ? "alert" : "status"}>{message.text}</span>}
    </section>
  );
}

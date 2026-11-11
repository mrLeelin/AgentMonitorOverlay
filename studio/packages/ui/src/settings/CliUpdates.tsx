import { useEffect, useState } from "react";
import type { MaintenanceCliStatus } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";

const running = (item: MaintenanceCliStatus) => item.state === "checking" || item.state === "updating";

function statusText(item: MaintenanceCliStatus): string {
  if (item.state === "updating") return "更新中…";
  if (item.state === "checking") return "检查中…";
  if (item.state === "error") return "操作失败";
  if (!item.path) return "未安装";
  if (item.state === "updated") return "已更新";
  if (item.updateAvailable) return "有新版本";
  if (item.currentVersion && item.latestVersion) return "已是最新";
  if (item.currentVersion) return "无法检查更新";
  return "版本未知";
}

/** Only this page checks CLI releases; the Host keeps an in-progress update when the page is closed. */
export function CliUpdates({ link }: { link: HostLink }) {
  const [items, setItems] = useState<MaintenanceCliStatus[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = items?.some(running) ?? false;

  useEffect(() => {
    let alive = true;
    setItems(null);
    setError(null);
    call(link, "GET /api/maintenance/clis").then((result) => { if (alive) setItems(result.items); }, (err: unknown) => { if (alive) setError(String(err instanceof Error ? err.message : err)); });
    return () => { alive = false; };
  }, [link]);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await call(link, "GET /api/maintenance/clis");
        if (alive) { setItems(result.items); setError(null); }
      } catch (err) {
        if (alive) setError(`读取更新进度失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (alive) timer = setTimeout(() => void poll(), 1500);
      }
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => { alive = false; clearTimeout(timer); };
  }, [link, active]);

  async function check() {
    setPending(true);
    setError(null);
    try { setItems((await call(link, "POST /api/maintenance/clis/check", {}, undefined)).items); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setPending(false); }
  }

  async function update(cli: MaintenanceCliStatus["cli"]) {
    setPending(true);
    setError(null);
    try {
      const result = await call(link, "POST /api/maintenance/clis/update", {}, { cli });
      setItems((previous) => previous?.map((item) => item.cli === cli ? result : item) ?? [result]);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setPending(false); }
  }

  return (
    <section className="settings-section" aria-label="CLI 更新">
      <div className="settings-row">
        <span className="settings-heading">CLI 更新</span>
        <span className="spacer" />
        <button type="button" className="btn-ghost small" onClick={() => void check()} disabled={pending || active || !items && !error}>检查更新</button>
      </div>
      <span className="settings-hint">查看本机 CLI 的版本，点击对应按钮更新。更新完成后，重新打开 CLI 即可使用新版本。</span>
      {!items && !error && <span className="settings-hint" role="status">正在检查 CLI 版本…</span>}
      {items && <div className="cli-update-list">
        {items.map((item) => <div className="cli-update-item" key={item.cli} data-testid={`cli-update-${item.cli}`}>
          <div className="cli-update-main">
            <div className="settings-row">
              <span className="cli-update-name">{item.name}</span>
              <span className={`cli-update-state${item.updateAvailable ? " available" : ""}${item.state === "error" ? " failed" : ""}`} role="status">{statusText(item)}</span>
            </div>
            <span className="settings-hint cli-update-versions">当前 <code>{item.currentVersion ?? "—"}</code><span>最新 <code>{item.latestVersion ?? "—"}</code></span></span>
            {item.path && <code className="settings-hint maintenance-path" title={item.path}>{item.path}</code>}
            {item.message && <span className={item.state === "error" ? "form-error cli-update-message" : "settings-hint cli-update-message"} role={item.state === "error" ? "alert" : undefined}>{item.message}</span>}
          </div>
          <button type="button" className={item.updateAvailable && item.canUpdate ? "btn-primary small" : "btn-ghost small"} disabled={pending || active || !item.canUpdate || !item.updateAvailable} title={item.updateCommand ?? item.message ?? undefined} onClick={() => void update(item.cli)} data-testid={`cli-update-button-${item.cli}`}>
            {item.state === "updating" ? "更新中…" : "更新"}
          </button>
        </div>)}
      </div>}
      {error && <span className="form-error" role="alert">{error}</span>}
    </section>
  );
}

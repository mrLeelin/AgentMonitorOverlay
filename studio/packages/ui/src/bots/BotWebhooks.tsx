import { useState } from "react";
import type { BotWebhook } from "@amo-studio/protocol";
import { call, copyText, type HostLink } from "../host/client.js";

export function BotWebhooks({ link, id }: { link: HostLink; id: string }) {
  const [hooks, setHooks] = useState<BotWebhook[]>([]);
  const [newHook, setNewHook] = useState<BotWebhook & { token: string }>();
  const [allowResult, setAllowResult] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try { await fn(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  return <details className="settings-section" onToggle={(event) => {
    if (event.currentTarget.open) void act(async () => setHooks(await call(link, "GET /api/bots/:id/webhooks", { id })));
    else setNewHook(undefined);
  }}>
    <summary className="settings-heading">Webhook 接单</summary>
    <p className="settings-hint">通过团队中转接收外部事件。发送 JSON 字段 `eventId` 和 `text`，在请求头中使用 Webhook 的 Bearer 密钥。</p>
    <div className="settings-row">
      <label><input type="checkbox" checked={allowResult} onChange={(e) => setAllowResult(e.target.checked)} /> 允许外部读取结论</label>
      <button type="button" className="btn-primary small" disabled={busy} onClick={() => void act(async () => {
        const hook = await call(link, "POST /api/bots/:id/webhooks", { id }, { allowResult });
        const { token: _token, ...summary } = hook;
        setNewHook(hook);
        setHooks((old) => [...old, summary]);
      })}>生成 Webhook</button>
    </div>
    {newHook && <div className="bot-request" role="status">
      <span>密钥只显示一次。</span>
      <input aria-label="Webhook 密钥" className="field" readOnly value={newHook.token} />
      <button className="btn-ghost small" type="button" onClick={() => void act(() => copyText(newHook.token))}>复制密钥</button>
    </div>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {hooks.map((hook) => <div className="settings-row" key={hook.id}>
      <code className="bot-hook-url">{hook.url}</code><span className="settings-hint">{hook.allowResult ? "可读结论" : "仅状态"}</span>
      <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void act(() => copyText(hook.url))}>复制地址</button>
      <button type="button" className="btn-ghost small" disabled={busy} onClick={() => {
        if (!window.confirm("撤销此 Webhook？外部请求将立即停止接收。")) return;
        void act(async () => { await call(link, "DELETE /api/bots/:id/webhooks/:hookId", { id, hookId: hook.id }); setHooks((old) => old.filter((entry) => entry.id !== hook.id)); if (newHook?.id === hook.id) setNewHook(undefined); });
      }}>撤销</button>
    </div>)}
  </details>;
}

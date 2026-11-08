import { useEffect, useState } from "react";
import type { NetworkSettings, NetworkTestResult } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";

export function NetworkPage({ link, value }: { link: HostLink; value?: NetworkSettings }) {
  const [mode, setMode] = useState<NetworkSettings["mode"]>(value?.mode ?? "inherit");
  const [proxyUrl, setProxyUrl] = useState(value?.proxyUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<NetworkTestResult | null>(null);
  useEffect(() => { setMode(value?.mode ?? "inherit"); setProxyUrl(value?.proxyUrl ?? ""); }, [value?.mode, value?.proxyUrl]);

  async function run(test: boolean) {
    setBusy(true); setMessage(""); setResult(null);
    const network = { mode, proxyUrl };
    try {
      if (test) setResult(await call(link, "POST /api/settings/network/test", {}, network));
      else {
        await call(link, "PUT /api/settings", {}, { network });
        setMessage("已保存。新启动的模型后台使用此设置；已运行的后台重新启动后生效。");
      }
    } catch (err) { setMessage(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  async function apply() {
    setBusy(true); setMessage(""); setResult(null);
    try {
      await call(link, "POST /api/settings/network/apply");
      setMessage("已释放空闲 Codex 后台，下次发送消息时会使用已保存的网络设置启动。");
    } catch (err) { setMessage(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  return <section className="settings-section" aria-label="网络">
    <span className="settings-heading">模型连接代理</span>
    <span className="settings-hint">用于 Studio 启动的 Codex、Claude 和 DeepSeek。本机连接始终绕过代理。</span>
    <label className="settings-row"><span className="settings-label">连接方式</span>
      <select className="field" style={{ width: "auto" }} aria-label="连接方式" value={mode} disabled={busy} onChange={(e) => { setMode(e.target.value as NetworkSettings["mode"]); setMessage(""); setResult(null); }}>
        <option value="inherit">跟随启动环境</option><option value="manual">手动代理</option><option value="direct">直接连接</option>
      </select>
    </label>
    {mode === "inherit" && <span className="settings-hint">使用启动 Studio 时的代理环境变量，不会自动读取 Windows 系统代理。</span>}
    {mode === "manual" && <>
      <label className="settings-row"><span className="settings-label">代理地址</span><input className="field" aria-label="代理地址" style={{ flex: 1, minWidth: 0 }} value={proxyUrl} disabled={busy} placeholder="http://127.0.0.1:7890" onChange={(e) => { setProxyUrl(e.target.value); setMessage(""); setResult(null); }} /></label>
      <span className="settings-hint">填写代理软件的 HTTP / HTTPS 地址，HTTPS 请求也可使用 http:// 地址。暂不支持带账号密码的代理。</span>
    </>}
    <div className="settings-row"><button type="button" className="btn-primary small" disabled={busy} onClick={() => void run(false)}>保存</button><button type="button" className="btn-ghost small" disabled={busy} onClick={() => void run(true)}>{busy ? "处理中…" : "测试连接"}</button></div>
    <span className="settings-hint">保存不会重启后台或打断会话。已有模型后台继续使用旧设置，新建会话也可能复用已有后台。</span>
    <div className="settings-row"><button type="button" className="btn-ghost small" disabled={busy || mode !== (value?.mode ?? "inherit") || (mode === "manual" && proxyUrl !== value?.proxyUrl)} onClick={() => void apply()}>应用到空闲 Codex 后台</button></div>
    <span className="settings-hint">请先保存，再结束 Codex 正在运行或交给终端的会话，点击上面的按钮。Claude 和 DeepSeek 已有会话需关闭后重新打开；不会重启 Studio 后台。</span>
    <span className="settings-hint">测试使用当前填写的设置，无需保存，不发送对话或消耗模型额度。服务有响应不代表登录及模型权限正常；自定义渠道需在实际使用时确认。</span>
    {message && <p role="status">{message}</p>}
    {result && <div role="status"><p>{result.proxy}</p>{result.checks.map((c) => <p key={c.name}>{c.name}：{c.ok ? "可访问" : "未连通"} — {c.message}</p>)}</div>}
  </section>;
}

import { useEffect, useState } from "react";
import type { CanvasReturnStatus } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { onHostEvent, onHostReconnect } from "../host/events.js";

const EMPTY: CanvasReturnStatus = { receipts: [], rounds: [] };

/** One subscription for the board; receipts do not participate in optimistic canvas saves. */
export function useCanvasReturns(link: HostLink, topicId: string) {
  const [status, setStatus] = useState(EMPTY);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false, revision = 0;
    setStatus(EMPTY);
    setError("");
    const load = async () => {
      const request = ++revision;
      try {
        const result = await call(link, "GET /api/topics/:id/canvas/returns", { id: topicId });
        if (!disposed && request === revision) { setStatus(result); setError(""); }
      } catch { if (!disposed && request === revision) setError("自动回传状态未能加载"); }
    };
    void load();
    const off = onHostEvent((e) => {
      if (e.type === "canvas.returns.updated" && e.topicId === topicId) void load();
      if (e.type === "item.updated" && e.item.id.startsWith("i-canvas-return")) void load();
    });
    const reconnect = onHostReconnect(() => void load());
    return () => { disposed = true; off(); reconnect(); };
  }, [link, topicId]);
  const retry = async () => {
    try { setStatus(await call(link, "POST /api/topics/:id/canvas/returns/retry", { id: topicId }, undefined)); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "重试回传失败"); }
  };
  return { status, error, retry };
}

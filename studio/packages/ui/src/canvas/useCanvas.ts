import { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasDoc } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { onHostEvent, onHostReconnect } from "../host/events.js";
import { rebaseCanvas } from "./rebase.js";

/**
 * A topic's canvas document with optimistic saves.
 *
 * Saves are queued. A newer Host version can include independent edits, so retain those and reapply fields that are
 * still valid against the version edited here. A competing edit to the same field stays as saved on the Host.
 */
export function useCanvas(link: HostLink, topicId: string) {
  const [doc, setDoc] = useState<CanvasDoc | null>(null);
  const [conflict, setConflict] = useState(false);
  /** Why the last save was refused (other than a conflict); the canvas was reloaded. */
  const [error, setError] = useState("");
  const latest = useRef<CanvasDoc | null>(null);
  latest.current = doc;
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const server = useRef<CanvasDoc | null>(null);
  const pending = useRef(0);

  const adopt = useCallback((doc: CanvasDoc) => {
    if (server.current?.id !== doc.id || server.current.version <= doc.version) server.current = doc;
    if (!pending.current) { latest.current = server.current; setDoc(server.current); }
    return server.current;
  }, []);
  const load = useCallback(() => call(link, "GET /api/topics/:id/canvas", { id: topicId }).then(adopt), [link.url, link.token, topicId, adopt]);

  useEffect(() => {
    // Another topic: start from its own document, not the previous one's versions.
    setDoc(null);
    server.current = null;
    const loadCurrent = () => void load().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    loadCurrent();
    const off = onHostEvent((e) => {
      if (e.type === "canvas.updated" && e.canvas.id === topicId) adopt(e.canvas);
    });
    const offReconnect = onHostReconnect(loadCurrent);
    return () => {
      off();
      offReconnect();
    };
  }, [load, topicId, adopt]);

  const save = useCallback(
    (next: CanvasDoc, basedOn?: CanvasDoc): Promise<CanvasDoc> => {
      const base = basedOn ?? latest.current ?? next;
      pending.current++;
      latest.current = next;
      setDoc(next);
      const run = async () => {
        const put = (doc: CanvasDoc) => call(link, "PUT /api/topics/:id/canvas", { id: topicId }, doc);
        const commit = async (current: CanvasDoc) => {
          const edit = rebaseCanvas(base, next, current);
          setConflict(edit.skipped);
          return edit.doc === current ? current : adopt(await put(edit.doc));
        };
        try {
          const current = server.current ?? base;
          const saved = await commit(current).catch(async (err: unknown) => {
            if (err instanceof HostApiError && err.status === 409 && !err.details) return await commit(await load());
            throw err;
          });
          setError("");
          return saved;
        } catch (err) {
          if (err instanceof HostApiError && err.status === 409 && !err.details) setConflict(true);
          else setError(err instanceof Error ? err.message : String(err));
          await load().catch(() => undefined);
          throw err;
        } finally {
          pending.current--;
          if (!pending.current) { latest.current = server.current; setDoc(server.current); }
        }
      };
      const result = queue.current.then(run, run);
      queue.current = result.catch(() => undefined);
      return result;
    },
    [link.url, link.token, load, topicId, adopt],
  );

  return { doc, save, conflict, dismissConflict: () => setConflict(false), error, dismissError: () => setError("") };
}

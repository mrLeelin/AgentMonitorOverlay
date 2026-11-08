import { useEffect, useMemo, useState } from "react";
import type { CanvasDoc } from "@amo-studio/protocol";
import { readStoredJson, writeStoredJson } from "../lib/stored.js";
import { parseSeenItems, reviewChanges, reviewSnapshot, type ItemChange, type SeenItems } from "./changes.js";

export function useReviewChanges(doc: CanvasDoc | null, topicId: string, hostUrl: string, enabled: boolean) {
  const key = `amo.canvasSeen.v1:${hostUrl}:${topicId}`;
  const current = useMemo(() => doc?.id === topicId ? reviewSnapshot(doc) : null, [doc, topicId]);
  const [baseline, setBaseline] = useState<{ key: string; seen: SeenItems } | null>(null);
  useEffect(() => {
    if (!enabled || !current || baseline?.key === key) return;
    const stored = parseSeenItems(readStoredJson(key));
    const seen = stored ?? current;
    // First visit establishes a baseline; opening again never acknowledges unread changes.
    if (!stored) writeStoredJson(key, seen);
    setBaseline({ key, seen });
  }, [key, current, enabled, baseline]);
  useEffect(() => {
    if (!enabled) return;
    const sync = (event: StorageEvent) => {
      if (event.key !== key && event.key !== null) return;
      const seen = parseSeenItems(readStoredJson(key));
      setBaseline(seen ? { key, seen } : null);
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [key, enabled]);
  const changes = useMemo(() => enabled && current && baseline?.key === key ? reviewChanges(current, baseline.seen) : new Map<string, ItemChange>(), [enabled, current, baseline, key]);
  const acknowledge = (id?: string) => {
    if (!enabled || !current || baseline?.key !== key) return;
    if (id && !Object.hasOwn(current, id)) return;
    // Merge other windows' acknowledgements before marking one card read.
    const seen = id ? { ...(parseSeenItems(readStoredJson(key)) ?? baseline.seen), [id]: current[id]! } : current;
    writeStoredJson(key, seen);
    setBaseline({ key, seen });
  };
  return { changes, acknowledge };
}

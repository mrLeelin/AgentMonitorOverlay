import type { CanvasDoc, CanvasItem } from "@amo-studio/protocol";

const fields = ["标题", "正文", "结论", "状态", "引用"] as const;
export type SeenItems = Record<string, string[]>;
export interface ItemChange { label: "新增" | "已更新"; detail: string }

// Store fingerprints, not a second copy of potentially long review text. Two independent 32-bit accumulators.
function fingerprint(value: string): string {
  let a = 2166136261;
  let b = 5381;
  for (let i = 0; i < value.length; i++) {
    a = Math.imul(a ^ value.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ value.charCodeAt(i);
  }
  return `${value.length}:${a >>> 0}:${b >>> 0}`;
}

export function reviewSnapshot(doc: CanvasDoc): SeenItems {
  return Object.fromEntries(doc.nodes.filter((n): n is CanvasItem => n.kind === "item").map((n) => [n.id, [n.title, n.body ?? "", n.conclusion ?? "", n.status, JSON.stringify(n.refs ?? [])].map(fingerprint)]));
}

export function parseSeenItems(value: unknown): SeenItems | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (!entries.every(([, v]) => Array.isArray(v) && v.length === fields.length && v.every((s) => typeof s === "string" && /^\d+:\d+:\d+$/.test(s) && s.length < 80))) return null;
  return Object.fromEntries(entries);
}

export function reviewChanges(current: SeenItems, seen: SeenItems): Map<string, ItemChange> {
  const result = new Map<string, ItemChange>();
  for (const [id, values] of Object.entries(current)) {
    const previous = Object.hasOwn(seen, id) ? seen[id] : undefined;
    if (!previous) result.set(id, { label: "新增", detail: "新增审阅条目，尚未标为已看" });
    else {
      const changed = fields.filter((_, i) => values[i] !== previous[i]);
      if (changed.length) result.set(id, { label: "已更新", detail: `自上次标为已看后，${changed.join("、")}有变化` });
    }
  }
  return result;
}

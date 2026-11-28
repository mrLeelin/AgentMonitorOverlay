import type { CanvasDoc } from "@amo-studio/protocol";

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Reapply fields touched here if the latest canvas still has their original values. */
export function rebaseCanvas(base: CanvasDoc, intended: CanvasDoc, latest: CanvasDoc) {
  let skipped = false;
  let changed = false;
  const merge = <T extends { id: string }>(before: readonly T[], after: readonly T[], current: readonly T[]): T[] => {
    const old = new Map(before.map((item) => [item.id, item]));
    const edited = new Map(after.map((item) => [item.id, item]));
    const existing = new Set(current.map((item) => item.id));
    const result: T[] = [];
    for (const item of current) {
      const original = old.get(item.id), desired = edited.get(item.id);
      if (!original) { result.push(item); if (desired && !equal(item, desired)) skipped = true; continue; }
      if (!desired) {
        if (equal(item, original)) { changed = true; continue; }
        skipped = true; result.push(item); continue;
      }
      const next = { ...item };
      const fields = new Set([...Object.keys(original), ...Object.keys(desired)]) as Set<keyof T>;
      for (const key of fields) {
        if (equal(original[key], desired[key]) || equal(item[key], desired[key])) continue;
        if (equal(item[key], original[key])) {
          if (Object.hasOwn(desired, key)) next[key] = desired[key];
          else delete next[key];
          changed = true;
        } else skipped = true;
      }
      result.push(next);
    }
    for (const item of after) {
      if (existing.has(item.id)) continue;
      const original = old.get(item.id);
      if (!original) { result.push(item); changed = true; }
      else if (!equal(original, item)) skipped = true;
    }
    return result;
  };
  const groups = merge(base.groups, intended.groups, latest.groups);
  const nodes = merge(base.nodes, intended.nodes, latest.nodes);
  const edges = merge(base.edges, intended.edges, latest.edges);
  const links = merge(base.links ?? [], intended.links ?? [], latest.links ?? []);
  const groupIds = new Set(groups.map((group) => group.id));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const latestGroupIds = new Set(latest.groups.map((group) => group.id));
  const latestNodeIds = new Set(latest.nodes.map((node) => node.id));
  const oldUngrouped = new Map(latest.nodes.filter((node) => node.groupId && !latestGroupIds.has(node.groupId)).map((node) => [node.id, node.groupId]));
  const oldDangling = new Map((latest.links ?? []).filter((link) => !latestNodeIds.has(link.from) || !latestNodeIds.has(link.to)).map((link) => [link.id, link]));
  if (nodes.some((node) => node.groupId && !groupIds.has(node.groupId) && oldUngrouped.get(node.id) !== node.groupId) ||
    links.some((link) => (!nodeIds.has(link.from) || !nodeIds.has(link.to)) && !equal(oldDangling.get(link.id), link))) return { doc: latest, skipped: true };
  return { doc: changed ? { ...latest, groups, nodes, edges, links } : latest, skipped };
}

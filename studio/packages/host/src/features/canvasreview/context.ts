import { REVIEW_STATUSES, type CanvasDoc, type CanvasItem, type Task } from "@amo-studio/protocol";

const brief = (text: string, limit = 600): string => {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > limit ? `${value.slice(0, limit)}…（已截断）` : value;
};

/** Only explicit neighbours: grouping and placement do not establish a semantic relationship. */
export function discussionContext(doc: CanvasDoc, item: CanvasItem, taskById: (id: string) => Task | undefined): string[] {
  const neighbours = new Map<string, string[]>();
  for (const link of doc.links ?? []) {
    const id = link.to === item.id ? link.from : link.from === item.id ? link.to : null;
    if (!id || id === item.id || !doc.nodes.some((n) => n.id === id)) continue;
    const relation = link.to === item.id ? "普通连线：关联卡 → 本卡" : "普通连线：本卡 → 关联卡";
    const labels = neighbours.get(id) ?? [];
    const label = `${relation}${link.label ? `；标签：${brief(link.label, 200)}` : ""}`;
    if (!labels.includes(label) && labels.length < 3) labels.push(label);
    neighbours.set(id, labels);
  }
  if (!neighbours.size) return [];
  const lines = ["", "直接关联卡片（开聊时的快照；普通连线只表达标签含义，不代表依赖或已确认结论）："];
  for (const [id, relations] of [...neighbours].slice(0, 8)) {
    const node = doc.nodes.find((n) => n.id === id)!;
    lines.push(`- ${relations.join("；")}（卡片 id：${id}）`);
    if (node.kind === "item") {
      lines.push(`  #${node.num}「${brief(node.title, 200)}」【${REVIEW_STATUSES.find((s) => s.id === node.status)?.label ?? node.status}】`, `  ${node.conclusion ? `结论：${brief(node.conclusion)}` : `尚无结论；正文摘要：${brief(node.body || "（无正文）")}`}`);
      if (node.refs?.length) lines.push(`  引用：${node.refs.slice(0, 3).map((r) => brief(r, 200)).join("、")}`);
    } else if (node.kind === "note") lines.push(`  便签：${brief(node.text)}`);
    else {
      const task = taskById(node.taskId);
      lines.push(`  ${node.kind === "ref" ? "引用任务" : "任务"}：${task ? brief(task.title, 200) : "（任务已不存在）"}（任务 id：${node.taskId}）`);
    }
  }
  if (neighbours.size > 8) lines.push(`另有 ${neighbours.size - 8} 张直接关联卡未展开。`);
  lines.push("需要完整内容或最新结论时用 canvas_read 核对；这里只提供关联背景，写回时只更新本次讨论的条目。");
  return lines;
}

import type { CanvasDoc, Id } from "@amo-studio/protocol";
import { ConfirmDialog } from "../lib/ConfirmDialog.js";

/** Card and group ids share the canvas document's id namespace. */
export type CanvasDeletion = { nodes: ReadonlySet<Id>; lines: ReadonlySet<string> };

/** Count against the current document: cards or lines may have gone while confirmation was open. */
export function DeleteSelectionDialog({ doc, selection, onCancel, onConfirm }: { doc: CanvasDoc; selection: CanvasDeletion; onCancel(): void; onConfirm(): void }) {
  const nodes = doc.nodes.filter((n) => selection.nodes.has(n.id));
  const groups = doc.groups.filter((g) => selection.nodes.has(g.id));
  const links = (doc.links ?? []).filter((l) => selection.lines.has(`link:${l.id}`) || selection.nodes.has(l.from) || selection.nodes.has(l.to));
  const dependencies = doc.edges.filter((e) => selection.lines.has(`edge:${e.id}`));
  const tasks = nodes.filter((n) => n.kind === "task").length;
  const notes = nodes.filter((n) => n.kind === "note").length;
  const refs = nodes.filter((n) => n.kind === "ref").length;
  const items = nodes.filter((n) => n.kind === "item").length;
  const counts = [groups.length ? `${groups.length} 个分组` : "", nodes.length ? `${nodes.length} 张卡片` : "", links.length ? `${links.length} 条连线` : "", dependencies.length ? `${dependencies.length} 条依赖线` : ""].filter(Boolean);
  const what = [
    groups.length ? `${groups.length} 个选中的分组会删除，组内未选中的卡片留在原处并移出分组` : "",
    tasks ? `${tasks} 张任务卡片从画布上拿掉，任务本身保留` : "",
    notes ? `${notes} 张便签会删除` : "",
    refs ? `${refs} 张引用卡片会删除，引用的任务不受影响` : "",
    items ? `${items} 条审阅条目会删除，条目上的提问和提示一并收起` : "",
    links.length ? `${links.length} 条普通连线会删除（包含被移除卡片上的连线）` : "",
    dependencies.length ? `${dependencies.length} 条选中的依赖线会删除，对应的任务依赖会解除` : "任务依赖保留",
  ].filter(Boolean);
  return (
    <ConfirmDialog title={counts.length ? `删除 ${counts.join("、")}？` : "选中的对象已不在画布上"} action="确认删除" danger onCancel={onCancel} onConfirm={onConfirm} testId="canvas-delete-confirm">
      {counts.length ? (
        <ul className="confirm-risks" data-testid="canvas-delete-what">
          {what.map((line) => <li key={line}>{line}</li>)}
        </ul>
      ) : <p>选中的对象已经被移除，可以取消并返回画布。</p>}
    </ConfirmDialog>
  );
}

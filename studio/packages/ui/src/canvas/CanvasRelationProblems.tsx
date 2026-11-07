import { canvasRelationIssues, canvasRelationMessage, type CanvasDoc, type CanvasNode, type CanvasRelationIssue, type Id, type Task } from "@amo-studio/protocol";
import { useMemo } from "react";

/** Explicit per-line repair: labels and other relation types must never disappear in an automatic cleanup. */
export function CanvasRelationProblems({ doc, tasks, onLocate, onRemove }: { doc: CanvasDoc; tasks: readonly Task[]; onLocate(node: CanvasNode): void; onRemove(source: CanvasRelationIssue["source"], id: Id): void }) {
  const issues = useMemo(() => canvasRelationIssues(doc), [doc]);
  if (!issues.length) return null;
  return <details className="canvas-relation-issues" data-testid="canvas-relation-issues">
    <summary>连线需要检查（{issues.length}）</summary>
    <p>这些旧连线不影响移动和保存。请定位核对文字后逐条删除，或右键反过来修复；不同文字和关系不会自动合并。</p>
    {issues.map((issue) => <div key={`${issue.source}:${issue.code}:${issue.ids.join(":")}`}>
      <span>{canvasRelationMessage(doc, issue, tasks)}</span>
      {issue.ids.map((id) => {
        const relation = issue.source === "link" ? doc.links?.find((l) => l.id === id) : doc.edges.find((e) => e.id === id);
        const node = relation && doc.nodes.find((n) => issue.source === "link" ? n.id === relation.from : n.kind === "task" && n.taskId === relation.from);
        const label = relation && "label" in relation ? relation.label : undefined;
        return <div className="dep-row" key={id} data-relation-id={id}><span>{id}{label ? ` · ${label}` : " · 无文字"}</span><button type="button" className="link-btn" onClick={() => node && onLocate(node)} disabled={!node}>定位</button><button type="button" className="link-btn" onClick={() => onRemove(issue.source, id)}>删除此线</button></div>;
      })}
    </div>)}
  </details>;
}

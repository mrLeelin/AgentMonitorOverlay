import { useId, useMemo } from "react";
import { SESSION_LOOK } from "../lib/status.js";
import { reviewRelationPath, type ReviewRelations as Relations } from "./review-relations.js";

export function ReviewRelations({ model, onOpen }: { model: Relations; onOpen(taskId: string, sessionId?: string): void }) {
  const marker = `review-arrow-${useId().replace(/:/g, "")}`;
  const lines = useMemo(() => model.lines.map((line) => ({ ...line, ...reviewRelationPath(line, model.obstacles) })), [model]);
  return <>
    <svg className="canvas-edges canvas-review-lines" aria-hidden="true">
      <defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M1 1 L9 5 L1 9" fill="none" stroke="var(--text-dim)" /></marker></defs>
      {lines.map((line) => {
        const b = line.points[line.points.length - 1]!;
        return <g key={line.id} data-testid={line.label === "整理出" ? "canvas-source-line" : "canvas-discussion-line"}>
          <path d={line.d} fill="none" stroke="var(--text-dim)" strokeWidth="1.5" strokeDasharray="9 3 2 3" markerEnd={`url(#${marker})`} />
          <text x={b.x - 26} y={b.y - 8} textAnchor="middle" className="canvas-review-line-label">{line.label}</text>
        </g>;
      })}
    </svg>
    {[...model.sources.map((c) => ({ ...c, source: true })), ...model.discussions.map((c) => ({ ...c, source: false }))].map((card) => <button
      key={`${card.source}:${card.id}`} type="button" className="canvas-review-relation-card" style={{ left: card.rect.x, top: card.rect.y, width: card.rect.w, height: card.rect.h }}
      data-testid={card.source ? "canvas-source-card" : "canvas-discussion-card"} disabled={card.missing}
      onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onClick={() => card.taskId && onOpen(card.taskId, card.sessionId)} title={card.title}>
      <span className="canvas-review-relation-kind">{card.source ? `${card.lead ? "主控 · " : ""}来源任务` : "讨论会话"}</span>
      <strong>{card.title}</strong>
      <span>{card.source ? card.missing ? "来源不可用" : "打开来源" : card.session ? `${card.session.archivedAt ? "已归档 · " : ""}${SESSION_LOOK[card.session.status].label}` : "已不在"}</span>
    </button>)}
  </>;
}

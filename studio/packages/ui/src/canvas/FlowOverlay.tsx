import type { Point } from "@amo-studio/protocol";
import type { TaskFlow } from "./task-flow.js";

/** CSS moves short highlights along the existing path, so dragging and zooming need no animation loop. */
export function FlowOverlay({ d, at, flow, animate }: { d: string; at: Point; flow: TaskFlow | null; animate: boolean }) {
  if (!flow) return null;
  const width = flow.label.length * 12 + 24;
  return <g className="canvas-task-flow" data-state={flow.state} data-direction={animate ? flow.direction : undefined} data-testid="canvas-task-flow" pointerEvents="none">
    <path className="canvas-flow-track" d={d} fill="none" />
    {animate && flow.direction && <path className="canvas-flow-pulse" d={d} fill="none" />}
    <g className="canvas-flow-label" transform={`translate(${at.x}, ${at.y})`}>
      <rect x={-width / 2} y={-11} width={width} height={22} rx={11} />
      <circle cx={-width / 2 + 10} cy={0} r={2.5} />
      <text x={5} y={0} dominantBaseline="central" textAnchor="middle">{flow.label}</text>
    </g>
  </g>;
}

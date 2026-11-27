import { Fragment, useLayoutEffect, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { CodeTokens } from "../lib/CodeTokens.js";
import type { CodeToken } from "../lib/highlight.js";
import { AddButton, Hunk, Notes, type LinesProps } from "./DiffView.js";
import { LazyChunks } from "./LazyChunks.js";
import { CHUNK_ROWS } from "./overview.js";
import { riderHunks, type RiderHunk, type RiderLine, type RiderMark } from "./riderDiff.js";
import { scrollParent } from "./reveal.js";
import { tokensOf } from "./splitview.js";
import "./rider.css";

type Side = "old" | "new";
interface Group {
  kind: RiderLine["kind"];
  old: RiderLine[];
  new: RiderLine[];
}

/** Keep the zero-height end of an insertion/deletion in the flow, at its exact position between source lines. */
function groupsOf(hunk: RiderHunk): Group[] {
  const groups: Group[] = [];
  let left = 0;
  let right = 0;
  function take(kind: Group["kind"], leftEnd: number, rightEnd: number) {
    if (left !== leftEnd || right !== rightEnd) groups.push({ kind, old: hunk.left.slice(left, leftEnd), new: hunk.right.slice(right, rightEnd) });
    left = leftEnd;
    right = rightEnd;
  }
  for (const band of hunk.bands) {
    take("context", band.leftStart, band.rightStart);
    take(band.kind, band.leftEnd, band.rightEnd);
  }
  take("context", hunk.left.length, hunk.right.length);
  return groups;
}

/** Each changed span can cross several syntax tokens, or fall inside one. Walk both sets of boundaries once. */
function MarkedCode({ text, tokens, marks }: { text: string; tokens: readonly CodeToken[] | undefined; marks: readonly RiderMark[] }) {
  if (!marks.length) return <CodeTokens text={text} tokens={tokens} />;
  let tokenIndex = 0;
  let tokenStart = 0;
  let position = 0;
  function take(to: number) {
    const from = position;
    position = to;
    if (!tokens) return text.slice(from, to);
    const parts: CodeToken[] = [];
    while (tokenIndex < tokens.length && tokenStart < to) {
      const token = tokens[tokenIndex]!;
      const end = tokenStart + token.text.length;
      const value = token.text.slice(Math.max(0, from - tokenStart), to - tokenStart);
      if (value) parts.push({ ...token, text: value });
      if (end > to) break;
      tokenStart = end;
      tokenIndex++;
    }
    return <CodeTokens text={text.slice(from, to)} tokens={parts} />;
  }
  const content: ReactNode[] = [];
  for (const mark of marks) {
    content.push(<Fragment key={mark.start}>{take(mark.start)}<mark>{take(mark.end)}</mark></Fragment>);
  }
  return <>{content}{take(text.length)}</>;
}

function SourceLine({ cell, side, props }: { cell: RiderLine; side: Side; props: LinesProps }) {
  const { row, index, kind, marks } = cell;
  const owns = side === "new" || row.line.kind === "del";
  const number = side === "old" ? row.line.oldLine : row.line.newLine;
  return (
    <>
      <div className={`gr-rider-line${props.active === index ? " active" : ""}`} data-row={index} data-line={owns ? row.key : undefined}
        data-kind={kind} data-testid={`rider-line-${side}`} onClick={(e) => { if (!(e.target as Element).closest("button")) props.onActivate(index); }}>
        <div className="gr-rider-code"><MarkedCode text={row.line.text} tokens={tokensOf(props.tokens, row.line, side)} marks={marks} /></div>
        <div className="gr-rider-number">
          <span className="gr-no">{number}</span>
          {owns && !props.readOnly && <AddButton row={row} open={props.draftAt === row.key} onDraft={props.onDraft} />}
        </div>
      </div>
      {owns && (row.key === props.draftAt || props.placed.has(row.key)) && <Notes row={row} props={props} />}
    </>
  );
}

function ColumnGroup({ cells, side, props }: { cells: RiderLine[]; side: Side; props: LinesProps }) {
  const draw = (cell: RiderLine) => <SourceLine key={cell.row.key} cell={cell} side={side} props={props} />;
  if (cells.length <= CHUNK_ROWS * 2) return <div className="gr-rider-group">{cells.map(draw)}</div>;
  const keep = cells.flatMap(({ index, row }, i) => index === props.active || row.key === props.draftAt || props.placed.has(row.key) ? [i] : []);
  return <div className="gr-rider-group"><LazyChunks items={cells} file={`${props.diff.path}|${side}|${cells[0]!.row.key}`}
    size={CHUNK_ROWS} guess={() => 20} chunkClass="gr-chunk" keep={keep} render={draw} /></div>;
}

function RibbonHunk({ hunk, index, props }: { hunk: RiderHunk; index: number; props: LinesProps }) {
  const groups = useMemo(() => groupsOf(hunk), [hunk]);
  const old = useRef<HTMLDivElement>(null);
  const next = useRef<HTMLDivElement>(null);
  const bridge = useRef<SVGSVGElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const left = old.current;
    const right = next.current;
    const svg = bridge.current;
    const el = body.current;
    if (!left || !right || !svg || !el || !hunk.bands.length) return;
    const scroll = scrollParent(el);
    if (!scroll) return;
    let segments: Array<{ top: number; height: number; oldTop: number; oldHeight: number; newTop: number; newHeight: number }> = [];
    let synced = false;
    let height = 0;
    let oldShift = NaN;
    let newShift = NaN;
    const draw = () => {
      // Ease the reading point into the viewport as this hunk enters it. On a trailing insertion
      // the shorter column's final line then sits just above that point and remains readable.
      const scrolled = Math.max(0, scroll.getBoundingClientRect().top - el.getBoundingClientRect().top);
      const y = synced ? Math.min(height, scrolled + Math.min(scrolled, scroll.clientHeight * 0.4)) : 0;
      const at = segments.find((s) => s.top + s.height > y) ?? segments.at(-1);
      if (!at || !at.height) return;
      const fraction = (y - at.top) / at.height;
      const dyOld = y - (at.oldTop + at.oldHeight * fraction);
      const dyNew = y - (at.newTop + at.newHeight * fraction);
      if (dyOld === oldShift && dyNew === newShift) return;
      oldShift = dyOld;
      newShift = dyNew;
      left.style.translate = `0 ${dyOld}px`;
      right.style.translate = `0 ${dyNew}px`;
      let path = 0;
      segments.forEach((s, i) => {
        if (groups[i]!.kind === "context") return;
        const a = s.oldTop + dyOld, b = s.newTop + dyNew;
        const c = a + s.oldHeight, d = b + s.newHeight;
        svg.children[path++]!.setAttribute("d", `M0 ${a} C25 ${a} 75 ${b} 100 ${b} V${d} C75 ${d} 25 ${c} 0 ${c} Z`);
      });
    };
    // For a hunk taller than the viewport, its one scrollbar traverses each group's longer side.
    // The other revision travels proportionally through the paired lines, stopping at a pure insertion/deletion.
    const measure = () => {
      let top = 0, oldTop = 0, newTop = 0;
      segments = groups.map((_, i) => {
        const oldHeight = left.children[i]!.getBoundingClientRect().height;
        const newHeight = right.children[i]!.getBoundingClientRect().height;
        const size = Math.max(oldHeight, newHeight);
        const segment = { top, height: size, oldTop, oldHeight, newTop, newHeight };
        top += size;
        oldTop += oldHeight;
        newTop += newHeight;
        return segment;
      });
      synced = top > scroll.clientHeight;
      height = synced ? top : Math.max(oldTop, newTop);
      el.style.minHeight = `${height}px`;
      svg.setAttribute("viewBox", `0 0 100 ${height || 1}`);
      oldShift = NaN;
      draw();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    for (const column of [left, right]) for (const item of column.children) observer.observe(item);
    scroll.addEventListener("scroll", draw, { passive: true });
    return () => {
      observer.disconnect();
      scroll.removeEventListener("scroll", draw);
      el.style.minHeight = "";
      left.style.translate = "";
      right.style.translate = "";
    };
  }, [groups, hunk]);

  const column = (side: Side) => <div className={`gr-rider-column ${side}`} ref={side === "old" ? old : next} role="group" aria-label={side === "old" ? "修改前" : "修改后"}>
    {groups.map((group, i) => <ColumnGroup key={i} cells={group[side]} side={side} props={props} />)}
  </div>;
  return <>
    {hunk.header && <Hunk header={(index && !hunk.header.hidden ? "⋯  " : "") + hunk.header.header} hidden={hunk.header.hidden} />}
    <div className="gr-rider-body" ref={body}>
      {column("old")}
      <div className="gr-rider-bridge" aria-hidden="true">
        <svg ref={bridge} preserveAspectRatio="none">{hunk.bands.map((band, i) => <path key={i} data-kind={band.kind} />)}</svg>
      </div>
      {column("new")}
    </div>
  </>;
}

export function RiderLines(props: LinesProps) {
  const hunks = useMemo(() => riderHunks(props.rows), [props.rows]);
  const gutter = useMemo(() => {
    let largest = 0;
    for (const row of props.rows) if (row.kind === "line") largest = Math.max(largest, row.line.oldLine ?? 0, row.line.newLine ?? 0);
    return `${String(largest).length + 1}ch`;
  }, [props.rows]);
  const keep = hunks.flatMap((hunk, i) => {
    const pinned = (cell: RiderLine) => cell.index === props.active || cell.row.key === props.draftAt || props.placed.has(cell.row.key);
    return hunk.left.some(pinned) || hunk.right.some(pinned) ? [i] : [];
  });
  return <div className="gr-lines gr-rider" data-testid="diff-rider" style={{ "--rider-number": gutter } as CSSProperties}>
    <div className="gr-rider-labels"><span>修改前</span><span>修改后</span></div>
    <LazyChunks items={hunks} size={1} file={`${props.diff.path}|rider`} keep={keep} chunkClass="gr-chunk"
      guess={(hunk) => 28 + 20 * Math.max(hunk.left.length, hunk.right.length)}
      render={(hunk, i) => <RibbonHunk key={hunk.key} hunk={hunk} index={i} props={props} />} />
  </div>;
}

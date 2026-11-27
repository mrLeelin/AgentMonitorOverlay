import type { DiffRow } from "./logic.js";
import type { SideCell } from "./splitview.js";

export interface RiderMark { start: number; end: number }
export interface RiderBand {
  kind: "change" | "add" | "del";
  leftStart: number; leftEnd: number;
  rightStart: number; rightEnd: number;
}
export interface RiderLine extends SideCell {
  kind: "context" | RiderBand["kind"];
  marks: RiderMark[];
}
export interface RiderHunk {
  key: string;
  header: Extract<DiffRow, { kind: "hunk" }> | null;
  left: RiderLine[];
  right: RiderLine[];
  bands: RiderBand[];
}

type Match = [left: number, right: number];

/** Ordered alignment, maximizing the sum of positive match weights. Callers bound the table size. */
function orderedMatches(oldCount: number, newCount: number, weight: (i: number, j: number) => number): Match[] {
  if (!oldCount || !newCount) return [];
  const stride = newCount + 1;
  const best = new Uint32Array((oldCount + 1) * stride);
  for (let i = oldCount - 1; i >= 0; i--) {
    for (let j = newCount - 1; j >= 0; j--) {
      const at = i * stride + j;
      best[at] = Math.max(best[at + stride]!, best[at + 1]!, weight(i, j) + best[at + stride + 1]!);
    }
  }
  const matches: Match[] = [];
  let i = 0;
  let j = 0;
  while (i < oldCount && j < newCount) {
    const at = i * stride + j;
    const w = weight(i, j);
    if (w > 0 && best[at] === w + best[at + stride + 1]!) {
      matches.push([i++, j++]);
    } else if (best[at] === best[at + stride]) i++;
    else j++;
  }
  return matches;
}

/** Score the unchanged ends of a signature or expression; limit the work for generated lines. */
function lineSimilarity(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  let prefix = 0;
  let suffix = 0;
  while (prefix < Math.min(length, 80) && a[prefix] === b[prefix]) prefix++;
  while (suffix < Math.min(length - prefix, 80) && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++;
  const same = prefix + suffix;
  const score = Math.round(100 * same / Math.min(160, Math.max(1, a.length, b.length)));
  return same >= 4 && score >= 45 ? score : 0;
}

/** Same indentation-independent text wins over any fuzzy matches in the changed run. */
function matchLines(left: RiderLine[], right: RiderLine[]): Match[] {
  if (!left.length || !right.length) return [];
  const before = left.map((l) => l.row.line.text.trim());
  const after = right.map((l) => l.row.line.text.trim());
  if (before.length * after.length > 16_384) {
    // Large rewrites: keep unambiguous anchors in source order, without building a quadratic table.
    const positions = new Map<string, number>();
    after.forEach((text, j) => positions.set(text, positions.has(text) ? -1 : j));
    const anchors: Match[] = [];
    let last = -1;
    before.forEach((text, i) => {
      const j = positions.get(text) ?? -1;
      if (j > last && text) { anchors.push([i, j]); last = j; }
    });
    // Between anchors, a bulk rename commonly leaves all line positions intact.
    const matches: Match[] = [];
    let oldStart = 0;
    let newStart = 0;
    for (let a = 0; a <= anchors.length; a++) {
      const [oldEnd, newEnd] = anchors[a] ?? [before.length, after.length];
      if (oldEnd - oldStart === newEnd - newStart) {
        for (let i = oldStart, j = newStart; i < oldEnd; i++, j++) {
          if (lineSimilarity(before[i]!, after[j]!)) matches.push([i, j]);
        }
      }
      if (a < anchors.length) matches.push([oldEnd, newEnd]);
      oldStart = oldEnd + 1;
      newStart = newEnd + 1;
    }
    return matches;
  }
  const exact = 101 * Math.min(before.length, after.length);
  return orderedMatches(before.length, after.length, (i, j) => {
    const a = before[i]!;
    const b = after[j]!;
    if (a === b) return a ? exact : 1;
    return lineSimilarity(a, b);
  });
}

/** Offsets are UTF-16 offsets, as used by the syntax highlighter and String.slice(). */
function markWords(left: RiderLine, right: RiderLine): void {
  const a = left.row.line.text;
  const b = right.row.line.text;
  if (a === b) return;
  // Minified or generated lines can be several MB long: the changed line background is sufficient there.
  if (Math.max(a.length, b.length) > 8192) return;
  const words = /[\p{L}\p{M}\p{N}_$]+|\s|./gu;
  const oldWords = a.match(words) ?? [];
  const newWords = b.match(words) ?? [];
  const shorter = Math.min(oldWords.length, newWords.length);
  let first = 0;
  let suffix = 0;
  while (first < shorter && oldWords[first] === newWords[first]) first++;
  while (suffix < shorter - first && oldWords[oldWords.length - 1 - suffix] === newWords[newWords.length - 1 - suffix]) suffix++;
  const oldMiddle = oldWords.slice(first, oldWords.length - suffix);
  const newMiddle = newWords.slice(first, newWords.length - suffix);
  const matches = oldMiddle.length * newMiddle.length > 4096 ? [] : orderedMatches(oldMiddle.length, newMiddle.length, (i, j) => oldMiddle[i] === newMiddle[j] ? 1 : 0);
  const offset = oldWords.slice(0, first).join("").length;
  const markGaps = (line: RiderLine, tokens: string[], side: 0 | 1) => {
    let word = 0;
    let end = offset;
    for (let m = 0; m <= matches.length; m++) {
      const next = matches[m]?.[side] ?? tokens.length;
      const start = end;
      while (word < next) end += tokens[word++]!.length;
      if (end > start) line.marks.push({ start, end });
      if (word < tokens.length) end += tokens[word++]!.length;
    }
  };
  markGaps(left, oldMiddle, 0);
  markGaps(right, newMiddle, 1);
}

/** Index the two columns independently. A pure insertion/deletion tapers to a boundary on the shorter side. */
function connectRun(hunk: RiderHunk, oldFrom: number, newFrom: number): void {
  const left = hunk.left.slice(oldFrom);
  const right = hunk.right.slice(newFrom);
  const matches = matchLines(left, right);
  let oldAt = 0;
  let newAt = 0;
  const band = (oldTo: number, newTo: number, paired: boolean) => {
    if (oldAt === oldTo && newAt === newTo) return;
    const kind = oldAt === oldTo ? "add" : newAt === newTo ? "del" : "change";
    hunk.bands.push({ kind, leftStart: oldFrom + oldAt, leftEnd: oldFrom + oldTo, rightStart: newFrom + newAt, rightEnd: newFrom + newTo });
    if (kind === "change") {
      for (let i = oldAt; i < oldTo; i++) left[i]!.kind = kind;
      for (let j = newAt; j < newTo; j++) right[j]!.kind = kind;
      if (paired || (oldTo - oldAt === 1 && newTo - newAt === 1)) {
        for (let i = oldAt; i < oldTo; i++) markWords(left[i]!, right[newAt + i - oldAt]!);
      }
    }
    oldAt = oldTo;
    newAt = newTo;
  };
  for (let m = 0; m < matches.length;) {
    let [i, j] = matches[m++]!;
    band(i, j, false);
    // Adjacent paired lines make a single ribbon, even when one column starts farther down the screen.
    while (matches[m]?.[0] === i + 1 && matches[m]?.[1] === j + 1) { i++; j++; m++; }
    band(i + 1, j + 1, true);
  }
  band(left.length, right.length, false);
}

export function riderHunks(rows: readonly DiffRow[]): RiderHunk[] {
  const hunks: RiderHunk[] = [];
  let hunk: RiderHunk | undefined;
  let oldFrom = 0;
  let newFrom = 0;
  const flush = () => {
    if (hunk && (hunk.left.length !== oldFrom || hunk.right.length !== newFrom)) connectRun(hunk, oldFrom, newFrom);
  };
  for (const [index, row] of rows.entries()) {
    if (row.kind === "hunk" || !hunk) {
      flush();
      hunk = { key: row.key, header: row.kind === "hunk" ? row : null, left: [], right: [], bands: [] };
      hunks.push(hunk);
      oldFrom = 0;
      newFrom = 0;
      if (row.kind === "hunk") continue;
    }
    const line: RiderLine = { row, index, kind: row.line.kind, marks: [] };
    if (line.kind === "context") {
      flush();
      oldFrom = hunk.left.push(line);
      newFrom = hunk.right.push(line);
    } else if (line.kind === "del") hunk.left.push(line);
    else hunk.right.push(line);
  }
  flush();
  return hunks;
}

import type { FileDiff, SessionItem } from "@amo-studio/protocol";

// What a turn changed (stage 12, S12-C): the files its edit calls touched, with line counts and the diff of the turn,
// and a diff read as rows for the preview's 本轮改动 view.

/** One file a turn changed: its edits' diffs joined, counts summed. */
export interface ChangedFile extends FileDiff {
  /** How many edit calls touched it. */
  edits: number;
}

const keyOf = (path: string) => path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
const patchLines = (diff: string) => diff.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
const isRawAddition = (change: FileDiff["change"], lines: readonly string[]) => change === "add" && !lines.some((line) => /^[-+@]/.test(line));

export function recordedEdits(item: SessionItem): readonly FileDiff[] {
  if (item.type !== "tool" || item.status !== "completed") return [];
  const kind = item.kind ?? (item.name === "edit" || item.name === "write" ? "edit" : null);
  return kind === "edit" ? item.files ?? [] : [];
}

/** Keep the original patches so multiple edits to the same lines can be read in order. */
export function recordedChanges(items: readonly SessionItem[]): Array<ChangedFile & { patches: FileDiff[] }> {
  const files = new Map<string, ChangedFile & { patches: FileDiff[] }>();
  for (const item of items) {
    for (const f of recordedEdits(item)) {
      const key = keyOf(f.path);
      const cur = files.get(key);
      // Codex may record new-file content as plain text, so its unified-diff count can be zero.
      let added = f.added;
      if (!added && f.change === "add" && f.diff) {
        const lines = patchLines(f.diff);
        if (isRawAddition(f.change, lines)) added = lines.length;
      }
      if (!cur) {
        files.set(key, { path: f.path, change: f.change, added, removed: f.removed, edits: 1, patches: [f] });
        continue;
      }
      cur.added += added;
      cur.removed += f.removed;
      cur.edits++;
      cur.change = f.change === "delete" ? "delete" : cur.patches[0]!.change === "add" ? "add" : "update";
      cur.patches.push(f);
    }
  }
  return [...files.values()];
}

/** The files the turn's finished edit calls changed, in the order they were first touched. */
export function turnChanges(items: readonly SessionItem[]): ChangedFile[] {
  return recordedChanges(items).map(({ patches, ...file }) => {
    let diff = patches[0]!.diff;
    for (const patch of patches.slice(1)) {
      if (patch.diff) diff = diff ? `${diff.replace(/\n$/, "")}\n${patch.diff}` : patch.diff;
    }
    return diff === undefined ? file : { ...file, diff };
  });
}

export type DiffRowKind = "add" | "del" | "ctx" | "hunk";

/** One row of a diff, with the line it has in the new file when the diff tells (hunk headers). */
export interface DiffRow {
  kind: DiffRowKind;
  text: string;
  newLine?: number;
}

/**
 * A unified diff as rows. Hunk headers (`@@ -1,4 +1,6 @@`) give the new file's line numbers; diffs without them (a
 * replaced block) have none. A new file whose "diff" is just its text shows every line as added.
 */
export function diffRows(file: Pick<FileDiff, "change" | "diff">): DiffRow[] {
  if (!file.diff) return [];
  const lines = patchLines(file.diff);
  if (isRawAddition(file.change, lines)) return lines.map((text, i) => ({ kind: "add", text, newLine: i + 1 }));
  const rows: DiffRow[] = [];
  let next: number | undefined;
  for (const line of lines) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("\\ ") || line.startsWith("diff --git") || line.startsWith("index ")) continue;
    if (line.startsWith("@@")) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      next = m ? Number(m[1]) : undefined;
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    if (line.startsWith("-")) {
      rows.push({ kind: "del", text: line.slice(1) });
      continue;
    }
    const kind: DiffRowKind = line.startsWith("+") ? "add" : "ctx";
    const text = kind === "add" || line.startsWith(" ") ? line.slice(1) : line;
    rows.push({ kind, text, ...(next !== undefined ? { newLine: next } : {}) });
    if (next !== undefined) next++;
  }
  return rows;
}

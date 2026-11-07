import type { FileDiff, GitDiffHunk, GitFileDiff } from "@amo-studio/protocol";
import { diffRows } from "../files/changes.js";

/** Render only the recorded patch. The current file and Git HEAD may have changed since this turn. */
export function turnDiff(file: FileDiff): GitFileDiff {
  const lines: GitFileDiff["lines"] = [];
  const hunks: GitDiffHunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  let hunk: GitDiffHunk | null = null;
  for (const row of diffRows(file)) {
    if (row.kind === "hunk") {
      const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row.text);
      if (header) {
        oldLine = Number(header[1]);
        newLine = Number(header[2]);
      }
      hunk = null;
      continue;
    }
    if (!hunk) {
      hunk = { start: lines.length, end: lines.length, oldStart: oldLine, newStart: newLine, oldCount: 0, newCount: 0 };
      hunks.push(hunk);
    }
    const kind = row.kind === "ctx" ? "context" : row.kind;
    lines.push({ kind, text: row.text, oldLine: kind === "add" ? null : oldLine++, newLine: kind === "del" ? null : newLine++ });
    hunk.end = lines.length;
    if (kind !== "add") hunk.oldCount++;
    if (kind !== "del") hunk.newCount++;
  }
  return { range: "working", path: file.path, binary: false, tooLarge: false, lines, hunks };
}

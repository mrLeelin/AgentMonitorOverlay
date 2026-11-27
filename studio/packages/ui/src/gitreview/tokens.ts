import { useEffect, useState } from "react";
import type { GitDiffLine, GitFileDiff } from "@amo-studio/protocol";
import { highlightTexts, hurry } from "../lib/highlight-client.js";
import { languageForPath } from "../lib/highlight-core.js";
import { diffTokensAsync, type DiffTokens } from "./splitview.js";

// A diff's colours, worked out in the highlight worker once per diff and kept with it: the diff shows at once in
// plain text, the colours follow; a diff read ahead is coloured ahead too, so it opens coloured.

const done = new WeakMap<GitFileDiff, DiffTokens | null>();
const pending = new WeakMap<GitFileDiff, Promise<DiffTokens | null>>();

/** The diff's colours (null: none for this file). `urgent` puts it before the diffs read ahead. */
export function diffTokensFor(diff: GitFileDiff, urgent = false): Promise<DiffTokens | null> {
  if (done.has(diff)) return Promise.resolve(done.get(diff)!);
  const on = pending.get(diff);
  if (on) {
    if (urgent) hurry(diff);
    return on;
  }
  const lang = languageForPath(diff.path);
  if (!lang || diff.binary || diff.tooLarge) {
    done.set(diff, null);
    return Promise.resolve(null);
  }
  const p = diffTokensAsync(diff.lines, (texts) => highlightTexts(texts, lang, { urgent, key: diff })).then(
    (tokens) => {
      done.set(diff, tokens);
      pending.delete(diff);
      return tokens;
    },
    () => {
      pending.delete(diff);
      return null;
    },
  );
  pending.set(diff, p);
  return p;
}

/** The colours of the diff in front: null until they are ready (the view shows plain text meanwhile). */
export function useDiffTokens(diff: GitFileDiff | null): DiffTokens | null {
  const [, ready] = useState(0);
  useEffect(() => {
    if (!diff || done.has(diff)) return;
    let live = true;
    void diffTokensFor(diff, true).then(() => live && ready((n) => n + 1));
    return () => {
      live = false;
    };
  }, [diff]);
  return (diff && done.get(diff)) ?? null;
}

/** The same line number can hold different code across edits. Each rendered line uses its own patch's grammar state. */
export async function recordedTokensFor(diffs: readonly GitFileDiff[], signal?: AbortSignal): Promise<DiffTokens | null> {
  if (diffs.length === 1) return diffTokensFor(diffs[0]!, true);
  const owners = new WeakMap<GitDiffLine, DiffTokens>();
  for (const diff of diffs) {
    if (signal?.aborted) return null;
    const tokens = await diffTokensFor(diff, true);
    if (tokens) for (const line of diff.lines) owners.set(line, tokens);
  }
  return (line, side) => owners.get(line)?.(line, side);
}

export function useRecordedTokens(diffs: readonly GitFileDiff[]): DiffTokens | null {
  const [ready, setReady] = useState<{ diffs: readonly GitFileDiff[]; tokens: DiffTokens | null } | null>(null);
  useEffect(() => {
    if (!diffs.length) return;
    const controller = new AbortController();
    void recordedTokensFor(diffs, controller.signal).then((tokens) => {
      if (!controller.signal.aborted) setReady({ diffs, tokens });
    });
    return () => controller.abort();
  }, [diffs]);
  return ready?.diffs === diffs ? ready.tokens : null;
}

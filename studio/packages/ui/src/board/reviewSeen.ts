import { useEffect, useSyncExternalStore } from "react";
import type { Task } from "@amo-studio/protocol";
import { readStored, writeStored } from "../lib/stored.js";

const PREFIX = "amo.taskReviewSeen.";
const EVENT = "amo:task-review-seen";
const memory = new Map<string, string>();

/** Older Hosts have no round field: keep one reminder for their existing review, without using mutable updatedAt. */
export function reviewRound(task: Task): string | null {
  return task.column === "review" && !task.archivedAt ? (task.reviewEnteredAt ?? task.createdAt) : null;
}

function read(id: string): string | null {
  return memory.get(id) ?? readStored(PREFIX + id);
}

function subscribe(notify: () => void): () => void {
  const storage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(PREFIX)) {
      if (event.key === null) memory.clear();
      else memory.delete(event.key.slice(PREFIX.length));
      notify();
    }
  };
  window.addEventListener("storage", storage);
  window.addEventListener(EVENT, notify);
  return () => {
    window.removeEventListener("storage", storage);
    window.removeEventListener(EVENT, notify);
  };
}

export function useReviewUnseen(task: Task): boolean {
  const seen = useSyncExternalStore(subscribe, () => read(task.id));
  const round = reviewRound(task);
  return round !== null && seen !== round;
}

/** Count the task page being visible as a visit, including a round finishing while the person is still there. */
export function useMarkReviewSeen(task: Task): void {
  const round = reviewRound(task);
  useEffect(() => {
    if (!round) return;
    const mark = () => {
      if (document.visibilityState !== "visible" || read(task.id) === round) return;
      memory.set(task.id, round);
      writeStored(PREFIX + task.id, round);
      window.dispatchEvent(new Event(EVENT));
    };
    mark();
    document.addEventListener("visibilitychange", mark);
    window.addEventListener("focus", mark);
    return () => {
      document.removeEventListener("visibilitychange", mark);
      window.removeEventListener("focus", mark);
    };
  }, [task.id, round]);
}

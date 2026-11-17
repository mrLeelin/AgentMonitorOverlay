import { expect, it } from "vitest";
import type { MessagePurpose } from "@amo-studio/protocol";
import { joinsPurpose } from "./message-purpose.js";

// Which message may join a running turn of which purpose (2026-11-17, plans/done/lead-instructions-mid-turn.md): work and
// reopen both write and restart the task, so either joins the other; a read-only inquiry or a notification only its own.
it("lets work and reopen join each other, and keeps inquiries and notifications to their own turns", () => {
  const purposes: MessagePurpose[] = ["work", "reopen", "inquiry", "notification"];
  const joins = Object.fromEntries(purposes.map((p) => [p, purposes.filter((active) => joinsPurpose(p, active))]));
  expect(joins).toEqual({
    work: ["work", "reopen"],
    reopen: ["work", "reopen"],
    inquiry: ["inquiry"],
    notification: ["notification"],
  });
});

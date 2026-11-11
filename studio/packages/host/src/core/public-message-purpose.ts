import type { MessagePurpose } from "@amo-studio/protocol";
import { HostError } from "./shared.js";

/** notification is reserved for trusted internal producers, never a public permission switch. */
export function publicMessagePurpose(value: unknown): Exclude<MessagePurpose, "notification"> | undefined {
  if (value === undefined) return undefined;
  if (value !== "inquiry" && value !== "work" && value !== "reopen") throw new HostError("bad_request", "purpose 必须是 inquiry、work 或 reopen；notification 仅限内部状态通知。");
  return value;
}

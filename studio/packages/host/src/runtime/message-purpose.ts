import type { Id, MessagePurpose } from "@amo-studio/protocol";
import type { Store } from "../store/store.js";

const PURPOSE_KEY = "message-purpose:";
type PurposeState = { active?: MessagePurpose; pending?: MessagePurpose; turnId?: Id };
function state(store: Store, sessionId: Id): PurposeState {
  try { return JSON.parse(store.getKv(PURPOSE_KEY + sessionId)?.value ?? "{}"); } catch { return {}; }
}
export function currentMessagePurpose(store: Store, sessionId: Id): MessagePurpose {
  return state(store, sessionId).active ?? "work";
}
export const keepsAcceptance = (purpose: MessagePurpose): boolean => purpose === "inquiry" || purpose === "notification";
export function mergeMessagePurposes(purposes: readonly MessagePurpose[]): MessagePurpose {
  return purposes.includes("reopen") ? "reopen" : purposes.includes("work") ? "work" : purposes.includes("inquiry") ? "inquiry" : "notification";
}
export function pendingMessagePurpose(store: Store, sessionId: Id): MessagePurpose {
  const old = state(store, sessionId); return old.pending ?? old.active ?? "work";
}
export function queueMessagePurpose(store: Store, sessionId: Id, purpose: MessagePurpose, running: boolean): void {
  const old = state(store, sessionId);
  // Merely queueing work must not unlock the still-running inquiry. Actual consumption promotes its purpose.
  const pending = running && old.pending ? mergeMessagePurposes([old.pending, purpose]) : purpose;
  store.setKv(PURPOSE_KEY + sessionId, JSON.stringify({ ...old, pending, active: running ? old.active ?? "work" : purpose }));
}
export function consumeMessagePurpose(store: Store, sessionId: Id, purpose: MessagePurpose, running: boolean): MessagePurpose {
  const old = state(store, sessionId), active = running ? mergeMessagePurposes([old.active ?? "work", purpose]) : purpose;
  store.setKv(PURPOSE_KEY + sessionId, JSON.stringify({ ...old, active, ...(!running ? { pending: purpose } : {}) }));
  return active;
}
export function startTurnPurpose(store: Store, sessionId: Id, turnId: Id): MessagePurpose {
  const old = state(store, sessionId), purpose = old.pending ?? old.active ?? "work";
  store.setKv(PURPOSE_KEY + sessionId, JSON.stringify({ active: purpose, turnId }));
  return purpose;
}

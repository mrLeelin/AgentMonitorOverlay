import type { Id, MessagePurpose, SessionItem } from "@amo-studio/protocol";
import { MESSAGE_PURPOSE_PREFIX } from "../store/kv-keys.js";
import type { Store } from "../store/store.js";

type PurposeState = { active?: MessagePurpose; pending?: MessagePurpose; turnId?: Id; botConversation?: boolean; pendingBotConversation?: boolean };
function state(store: Store, sessionId: Id): PurposeState {
  try { return JSON.parse(store.getKv(MESSAGE_PURPOSE_PREFIX + sessionId)?.value ?? "{}"); } catch { return {}; }
}

export function isBotConversationInput(item: SessionItem | undefined): boolean {
  return item?.type === "user" && (item.botLetter?.kind === "mention" || item.botLetter?.kind === "reply");
}
export function currentMessagePurpose(store: Store, sessionId: Id): MessagePurpose {
  return state(store, sessionId).active ?? "work";
}
export const keepsAcceptance = (purpose: MessagePurpose): boolean => purpose === "inquiry" || purpose === "notification";
/**
 * Whether a message may join a running turn of `active` purpose. Work and reopen both write and restart the task, so
 * either joins the other (2026-11-17: the Free 主控's work 传话 waited out a 23-minute reopen turn); others must match.
 */
export const joinsPurpose = (purpose: MessagePurpose, active: MessagePurpose): boolean => purpose === active || (!keepsAcceptance(purpose) && !keepsAcceptance(active));
export function mergeMessagePurposes(purposes: readonly MessagePurpose[]): MessagePurpose {
  return purposes.includes("reopen") ? "reopen" : purposes.includes("work") ? "work" : purposes.includes("inquiry") ? "inquiry" : "notification";
}
export function pendingMessagePurpose(store: Store, sessionId: Id): MessagePurpose {
  const old = state(store, sessionId); return old.pending ?? old.active ?? "work";
}
export function queueMessagePurpose(store: Store, sessionId: Id, purpose: MessagePurpose, running: boolean, botConversation = false): void {
  const old = state(store, sessionId);
  // Merely queueing work must not unlock the still-running inquiry. Actual consumption promotes its purpose.
  const pending = running && old.pending ? mergeMessagePurposes([old.pending, purpose]) : purpose;
  store.setKv(MESSAGE_PURPOSE_PREFIX + sessionId, JSON.stringify({ ...old, pending, active: running ? old.active ?? "work" : purpose, pendingBotConversation: !running && botConversation }));
}
export function consumeMessagePurpose(store: Store, sessionId: Id, purpose: MessagePurpose, running: boolean, hasOrdinaryInput: boolean): MessagePurpose {
  const old = state(store, sessionId), active = running ? mergeMessagePurposes([old.active ?? "work", purpose]) : purpose;
  store.setKv(MESSAGE_PURPOSE_PREFIX + sessionId, JSON.stringify({ ...old, active, ...(!running ? { pending: purpose } : {}), ...(hasOrdinaryInput ? { botConversation: false } : {}) }));
  return active;
}
export function startTurnPurpose(store: Store, sessionId: Id, turnId: Id): MessagePurpose {
  const old = state(store, sessionId), purpose = old.pending ?? old.active ?? "work";
  // A native turn without a queued Bot input can be a Goal continuation or work sent from the attached CLI.
  store.setKv(MESSAGE_PURPOSE_PREFIX + sessionId, JSON.stringify({ active: purpose, turnId, ...(old.pendingBotConversation ? { botConversation: true } : {}) }));
  return purpose;
}

import type { Id } from "@amo-studio/protocol";
import type { Store } from "../../store/store.js";

export function isBotTask(store: Store, taskId: Id | null): boolean {
  return !!taskId && !!store.db.prepare("SELECT id FROM studio_bots WHERE task_id = ?").get(taskId);
}

export function isBotHome(store: Store, id: Id): boolean {
  return !!store.db.prepare("SELECT id FROM studio_bots WHERE home_session_id = ?").get(id);
}

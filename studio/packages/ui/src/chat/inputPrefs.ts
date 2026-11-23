import { useSyncExternalStore } from "react";
import { readStored, writeStored } from "../lib/stored.js";

export const ENTER_MODES = {
  send: (_send: string, newline: string) => `Enter 发送，${newline} 换行`,
  multiline: (send: string, newline: string) => `单行 Enter / 多行 ${send} 发送，${newline} 换行`,
  newline: (send: string, newline: string) => `${send} 发送，Enter 或 ${newline} 换行`,
};

export const NEWLINE_SHORTCUTS = { shift: "Shift+Enter", ctrl: "Ctrl+Enter" };
type NewlineShortcut = keyof typeof NEWLINE_SHORTCUTS;
type EnterMode = keyof typeof ENTER_MODES;

export function sendChord(newline: NewlineShortcut): NewlineShortcut {
  return newline === "shift" ? "ctrl" : "shift";
}

export function primaryEnterKey(mode: EnterMode, newline: NewlineShortcut, multiline: boolean): "plain" | NewlineShortcut {
  return mode === "send" || (mode === "multiline" && !multiline) ? "plain" : sendChord(newline);
}

export const PRIMARY_ENTER_LABELS = { plain: "Enter", ...NEWLINE_SHORTCUTS };

export function todoCtrlConflict(mode: EnterMode, newline: NewlineShortcut): "换行" | "开始" | undefined {
  if (newline === "ctrl") return "换行";
  if (mode !== "send") return "开始";
}

export const CHAT_SHORTCUTS = (Object.keys(ENTER_MODES) as EnterMode[]).flatMap((mode) =>
  (Object.keys(NEWLINE_SHORTCUTS) as NewlineShortcut[]).map((newline) => ({
    id: `${mode}-${newline}`, mode, newline,
    label: ENTER_MODES[mode](NEWLINE_SHORTCUTS[sendChord(newline)], NEWLINE_SHORTCUTS[newline]),
  })),
);

export const FOLLOWUP_MODES = { queue: "本轮结束后发送", insert: "插入当前回合" };

export const TODO_SHORTCUTS = { off: "关闭", alt: "Alt+Enter", ctrlShift: "Ctrl+Shift+Enter", ctrl: "Ctrl+Enter" };

const keys = {
  enter: "amo.composer.enter",
  newline: "amo.composer.newline",
  followup: "amo.composer.followup",
  todo: "amo.composer.todo",
};
const eventName = "amo:composer-prefs";

function subscribe(change: () => void): () => void {
  window.addEventListener(eventName, change);
  window.addEventListener("storage", change);
  return () => {
    window.removeEventListener(eventName, change);
    window.removeEventListener("storage", change);
  };
}

function useInputPref<T extends Record<string, unknown>>(key: keyof typeof keys, choices: T, fallback: keyof T): [keyof T, (value: keyof T) => void] {
  const current = useSyncExternalStore(subscribe, () => {
    const stored = readStored(keys[key]);
    return stored && Object.hasOwn(choices, stored) ? stored as keyof T : fallback;
  });
  return [current, (value) => {
    writeStored(keys[key], String(value));
    window.dispatchEvent(new Event(eventName));
  }];
}

export const useEnterMode = () => useInputPref("enter", ENTER_MODES, "send");
export const useNewlineShortcut = () => useInputPref("newline", NEWLINE_SHORTCUTS, "shift");
export const useFollowupMode = () => useInputPref("followup", FOLLOWUP_MODES, "queue");
export function useTodoShortcut(mode: EnterMode, newline: NewlineShortcut) {
  const [todo, setTodo] = useInputPref("todo", TODO_SHORTCUTS, "off");
  return [todo === "ctrl" && todoCtrlConflict(mode, newline) ? "off" : todo, setTodo] as const;
}

export function useTaskEnter(text: string, canFile = true) {
  const [mode] = useEnterMode();
  const [newline] = useNewlineShortcut();
  const [todo] = useTodoShortcut(mode, newline);
  const multiline = text.includes("\n");
  return {
    startKey: primaryEnterKey(mode, newline, multiline),
    todoShortcut: todo,
    action(key: KeyPress): "start" | "todo" | undefined {
      if (chatEnterAction(key, mode, newline, multiline) === "send") return "start";
      if (canFile && enterKey(key) === todo) return "todo";
    },
  };
}

export function setChatShortcuts(mode: EnterMode, newline: NewlineShortcut): void {
  // Keep both existing preferences readable and update them together for local subscribers.
  writeStored(keys.enter, mode);
  writeStored(keys.newline, newline);
  window.dispatchEvent(new Event(eventName));
}

type KeyPress = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">;

export function enterKey(key: KeyPress): "plain" | NewlineShortcut | "alt" | "ctrlShift" | undefined {
  if (key.key !== "Enter") return;
  const ctrl = key.ctrlKey || key.metaKey;
  if (key.altKey) return ctrl || key.shiftKey ? undefined : "alt";
  if (ctrl) return key.shiftKey ? "ctrlShift" : "ctrl";
  return key.shiftKey ? "shift" : "plain";
}

export function chatEnterAction(key: KeyPress, mode: EnterMode, newline: NewlineShortcut, multiline: boolean): "send" | "opposite" | "now" | undefined {
  const chord = enterKey(key);
  if (chord === "ctrlShift") return "opposite";
  if (chord === primaryEnterKey(mode, newline, multiline)) return "send";
  if (chord === sendChord(newline)) return mode === "send" ? "now" : "send";
}

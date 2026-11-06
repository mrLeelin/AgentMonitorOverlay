import { useEffect, useState } from "react";
import { readStored, writeStored } from "./stored.js";

// UI theme: light (the default: direction A, 纸感编辑部), dark, or following the system. Stored per install (this window profile's localStorage, which the
// workbench and Focus windows share); applied as data-theme on <html>, which app.css reads.

export type ThemePref = "system" | "light" | "dark";

const KEY = "amo.theme";
const LOCAL_EVENT = "amo:theme";

export function themePref(): ThemePref {
  const v = readStored(KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "light";
}

export function applyTheme(pref: ThemePref = themePref()): void {
  if (pref === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = pref;
}

export function setThemePref(pref: ThemePref): void {
  writeStored(KEY, pref);
  applyTheme(pref);
  window.dispatchEvent(new Event(LOCAL_EVENT));
}

/** Focus's sun button switches the displayed colour, including while following the system. */
export function toggleTheme(): void {
  const theme = document.documentElement.dataset.theme;
  const dark = theme === "dark" || (!theme && window.matchMedia("(prefers-color-scheme: dark)").matches);
  setThemePref(dark ? "light" : "dark");
}

/** Keep the settings selection in step with choices made in Focus or this window. */
export function useThemePref(): ThemePref {
  const [theme, setTheme] = useState(themePref);
  useEffect(() => {
    const follow = () => setTheme(themePref());
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY || e.key === null) follow();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(LOCAL_EVENT, follow);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(LOCAL_EVENT, follow);
    };
  }, []);
  return theme;
}

/** Keeps a window in step when another window (workbench ↔ Focus) changes the theme. */
export function followThemeChanges(): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY || e.key === null) applyTheme();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

export const THEME_LABELS: Record<ThemePref, string> = { system: "跟随系统", light: "浅色", dark: "深色" };

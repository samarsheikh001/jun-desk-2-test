import { useSyncExternalStore } from "react";

/**
 * The dashboard's light/dark switch. "system" follows the OS; "light" and "dark" are saved in
 * this browser (localStorage, per device, not per account). The result is <html data-theme>,
 * which web/desk.css keys dark mode on. index.html applies the same rule before first paint.
 */
export type ThemePref = "system" | "light" | "dark";

export const THEME_PREFS: readonly ThemePref[] = ["system", "light", "dark"];
export const THEME_LABEL: Record<ThemePref, string> = { system: "System", light: "Light", dark: "Dark" };

const KEY = "jun-theme";
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

function readPref(): ThemePref {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

let pref = readPref();

function apply(): void {
  document.documentElement.dataset.theme = pref === "dark" || (pref === "system" && darkQuery.matches) ? "dark" : "light";
}

function changed(): void {
  apply();
  listeners.forEach((l) => l());
}

export function setThemePref(next: ThemePref): void {
  pref = next;
  try {
    if (next === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    // storage blocked: still applies for this page
  }
  changed();
}

// The OS switching while on System, and another desk tab changing the setting.
darkQuery.addEventListener("change", () => pref === "system" && apply());
window.addEventListener("storage", (e) => {
  if (e.key !== KEY && e.key !== null) return;
  pref = readPref();
  changed();
});
apply();

export function useThemePref(): ThemePref {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pref,
  );
}

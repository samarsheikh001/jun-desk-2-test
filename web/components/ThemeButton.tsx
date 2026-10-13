import { MonitorIcon, MoonIcon, SunIcon } from "@/components/icons";
import { SidebarMenuButton } from "@/components/ui/sidebar.tsx";
import { setThemePref, THEME_LABEL, THEME_PREFS, useThemePref } from "../lib/theme.ts";

const ICON = { system: MonitorIcon, light: SunIcon, dark: MoonIcon } as const;

/** Sidebar switch: System → Light → Dark. */
export function ThemeButton() {
  const pref = useThemePref();
  const next = THEME_PREFS[(THEME_PREFS.indexOf(pref) + 1) % THEME_PREFS.length]!;
  const Icon = ICON[pref];
  const title = `Theme: ${THEME_LABEL[pref]} (switch to ${THEME_LABEL[next]})`;
  return (
    <SidebarMenuButton type="button" className="theme-switch" onClick={() => setThemePref(next)} aria-label={title} tooltip={title}>
      <Icon />
      <span>Theme: {THEME_LABEL[pref]}</span>
    </SidebarMenuButton>
  );
}

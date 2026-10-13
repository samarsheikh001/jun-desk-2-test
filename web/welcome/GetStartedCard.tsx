import { useState } from "react";
import { navigate } from "../lib/router.ts";
import { STEP_ORDER, type Onboarding } from "./WelcomePage.tsx";
import { ChevronDownIcon, FlashIcon } from "@/components/icons";

// T-11: the sidebar's "Get started" checklist (after Widgo's): progress bar, % badge, and a
// link per step to where it's done. The header folds the list away (not remembered, like theirs).

const STEPS: Record<(typeof STEP_ORDER)[number], { label: string; href: string }> = {
  account: { label: "Create your account", href: "/welcome" },
  knowledge: { label: "Add your docs", href: "/knowledge" },
  ai: { label: "Turn on the AI", href: "/settings/ai" },
  brand: { label: "Make the widget yours", href: "/appearance" },
  install: { label: "Install on your site", href: "/appearance/install" },
  team: { label: "Invite your team", href: "/welcome" },
};

export function GetStartedCard({ onboarding }: { onboarding: Onboarding }) {
  const [open, setOpen] = useState(true);
  const done = STEP_ORDER.filter((k) => onboarding.steps[k]).length;
  const percent = Math.round((done / STEP_ORDER.length) * 100);

  return (
    <div className="gs-card">
      <div className="gs-track"><div className="gs-fill" style={{ width: `${percent}%` }} /></div>
      <button type="button" data-plain className="gs-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <h4>
          <FlashIcon className="gs-bolt" />
          Get started
        </h4>
        <span className="gs-meta">
          <span className="gs-percent">{percent}%</span>
          <ChevronDownIcon className={`gs-chevron ${open ? "open" : ""}`} />
        </span>
      </button>
      {open && (
        <div className="gs-list">
          {STEP_ORDER.map((key, i) => {
            const { label, href } = STEPS[key];
            const ok = onboarding.steps[key];
            return (
              <a key={key} href={href} className="gs-step" onClick={(e) => { e.preventDefault(); navigate(href); }}>
                <span className={`gs-n ${ok ? "done" : ""}`}>{ok ? "✓" : i + 1}</span>
                <span className={ok ? "gs-done" : undefined}>{label}</span>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}

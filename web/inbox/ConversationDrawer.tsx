import { useEffect, useState, type ReactNode } from "react";
import { isTypingTarget } from "../lib/bridge.ts";

// Widgo's conversation drawer: a blurred backdrop and a panel sliding in from the right (200 ms),
// 65% wide (at least 840px; the full width on phones). Its contents are the thread (InboxPage).
// Esc closes it, unless something else used the key first (the composer leaves its input, the
// tag field, an open dialog).

export function ConversationDrawer({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true));
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || isTypingTarget(e.target) || document.querySelector("dialog[open]")) return;
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <>
      <div className={`cv-backdrop ${shown ? "shown" : ""}`} onClick={onClose} />
      <div className={`cv-drawer ${shown ? "shown" : ""}`} role="dialog" aria-label={label}>
        {children}
      </div>
    </>
  );
}

export function DrawerClose({ onClose }: { onClose: () => void }) {
  return <button type="button" data-plain className="cv-close" onClick={onClose} aria-label="Close" title="Close (Esc)">✕</button>;
}

import type { ReactNode } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet.tsx";

// The Knowledge page's side panels (after Chatbase's Sources page): one right-hand sheet for
// adding a source, a source's details and the search tester. 3/4 of the window, capped at
// 576 / 768 / 1024 px by breakpoint (full width on phones); it slides all the way in.

export function KbSheet({
  open,
  onOpenChange,
  icon,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Add panels show the source type's icon in a box; the details panel has a plain title + description. */
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="kb-sheet">
        <SheetHeader className={icon ? "kb-sheet-head with-icon" : "kb-sheet-head"}>
          {icon && <span className="kb-sheet-icon" aria-hidden="true">{icon}</span>}
          <div className="kb-sheet-titles">
            <SheetTitle className="kb-sheet-title">{title}</SheetTitle>
            {description && <SheetDescription className="kb-sheet-desc">{description}</SheetDescription>}
          </div>
        </SheetHeader>
        {children}
      </SheetContent>
    </Sheet>
  );
}

/** Scrolling middle of a sheet. */
export function KbSheetBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={`kb-sheet-body${className ? ` ${className}` : ""}`}>{children}</div>;
}

/** Bottom bar with the panel's actions. */
export function KbSheetFooter({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={`kb-sheet-foot${className ? ` ${className}` : ""}`}>{children}</div>;
}

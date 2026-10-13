import type { ReactNode, Ref } from "react";

// The settings dialog's building blocks, after Town's (D-35): sections split by hairlines, each a
// title and description, then rows with the label on the left and the control on the right.

/** One settings card: a title and description, an optional action on the right, then its rows. */
export function SettingsCard({ title, description, action, id, className, ref, children }: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  id?: string;
  className?: string;
  ref?: Ref<HTMLElement>;
  children?: ReactNode;
}) {
  return (
    <section className={`settings-card${className ? ` ${className}` : ""}`} id={id} ref={ref}>
      <div className="settings-card-head">
        <div className="settings-card-text">
          <h2>{title}</h2>
          {description && <div className="settings-card-desc">{description}</div>}
        </div>
        {action && <div className="settings-card-action">{action}</div>}
      </div>
      {children && <div className="settings-card-body">{children}</div>}
    </section>
  );
}

/** A setting: label and description on the left, its control on the right (stacked on phones). */
export function SettingRow({ label, description, htmlFor, wide, children }: {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  /** The control takes the full width under the label (long inputs). */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`setting-row${wide ? " setting-row-wide" : ""}`}>
      <div className="setting-row-text">
        {htmlFor ? <label htmlFor={htmlFor} className="setting-row-label">{label}</label> : <span className="setting-row-label">{label}</span>}
        {description && <div className="setting-row-desc">{description}</div>}
      </div>
      <div className="setting-row-control">{children}</div>
    </div>
  );
}

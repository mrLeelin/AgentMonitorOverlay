import type { ReactNode } from "react";

/**
 * 设置行 (2026-11-23 设置整理): the label in a column of its own, so every control on a page starts at the same place,
 * and the hint right under the control it explains (closer to it than to the next row). Where the page is narrow the
 * label goes above the control (settings.css).
 */
export function SettingField({ label, htmlFor, hint, testId, children }: {
  label: ReactNode;
  /** The id of the select or text field: the label then names it (getByLabel finds it, a click focuses it). */
  htmlFor?: string;
  hint?: ReactNode;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <div className="setting-field" data-testid={testId}>
      {htmlFor ? <label className="setting-field-label" htmlFor={htmlFor}>{label}</label> : <span className="setting-field-label">{label}</span>}
      <div className="setting-field-control">
        {children}
        {hint && <span className="settings-hint">{hint}</span>}
      </div>
    </div>
  );
}

/**
 * The buttons acting on the rows above (保存, 测试连接…), in the controls' column so they start where the controls
 * do; what they mean and how it went (`below`) right under them. Settings that apply on a click have none.
 */
export function SettingActions({ children, below }: { children: ReactNode; below?: ReactNode }) {
  return (
    <div className="setting-field setting-actions">
      <span className="setting-field-label" />
      <div className="setting-field-control">
        <div className="settings-row">{children}</div>
        {below}
      </div>
    </div>
  );
}

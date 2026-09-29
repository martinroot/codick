/**
 * Bootstrap 5 component surface for the dashboard.
 *
 * Each export mirrors the prop contract the dashboard already uses from
 * `@nous-research/ui`, so call sites migrate by swapping the import path
 * alone — no JSX rewrites. Styling is Bootstrap's: `btn`, `card`, `badge`,
 * `form-control`, `form-select` and friends, themed through the
 * `--bs-*` custom properties in `src/styles/bootstrap-theme.css` rather
 * than a second palette.
 *
 * The shims exist so the removal of the old design system is a per-page
 * decision, not a flag day: once a page's markup reads as Bootstrap, its
 * import moves to a plain `bootstrap-*` class and this layer stops
 * shadowing it.
 */

import * as React from "react";
import * as ReactDOM from "react-dom";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Button                                                              */
/* ------------------------------------------------------------------ */

export interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "prefix" | "suffix"> {
  /** Destructive emphasis — Bootstrap's `btn-danger`. */
  destructive?: boolean | null;
  /** Borderless emphasis — Bootstrap's `btn-link`-ish transparent button. */
  ghost?: boolean | null;
  /** High-contrast emphasis against a filled surface. */
  invert?: boolean | null;
  /** Outlined emphasis — Bootstrap's `btn-outline-*`. */
  outlined?: boolean | null;
  size?: "xs" | "sm" | "default" | "icon" | null;
  prefix?: React.ReactNode;
  suffix?: React.ReactNode;
}

const BUTTON_SIZE_CLASS: Record<NonNullable<ButtonProps["size"]>, string> = {
  xs: "btn-sm py-0 px-2",
  sm: "btn-sm",
  default: "",
  icon: "p-0 d-inline-flex align-items-center justify-content-center",
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    children,
    className,
    destructive,
    ghost,
    invert,
    outlined,
    prefix,
    size = "default",
    suffix,
    type = "button",
    ...props
  },
  ref,
) {
  const sizeClass = BUTTON_SIZE_CLASS[size ?? "default"];
  const iconSize = size === "icon" ? "btn-icon" : "";

  let variant = "btn-primary";
  if (destructive) variant = "btn-danger";
  else if (outlined) variant = "btn-outline-secondary";
  else if (ghost) variant = "btn-ghost";
  else if (invert) variant = "btn-invert";

  return (
    <button
      ref={ref}
      type={type}
      className={cn("btn", variant, sizeClass, iconSize, className)}
      {...props}
    >
      {prefix ? <span className="btn-prefix">{prefix}</span> : null}
      {children}
      {suffix ? <span className="btn-suffix">{suffix}</span> : null}
    </button>
  );
});

/* ------------------------------------------------------------------ */
/* Card                                                                */
/* ------------------------------------------------------------------ */

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("card", className)} {...props} />;
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("card-header", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("card-title", className)} {...props} />;
}

export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("card-text text-body-secondary", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("card-body", className)} {...props} />;
}

/* ------------------------------------------------------------------ */
/* Badge                                                               */
/* ------------------------------------------------------------------ */

export type BadgeTone = "default" | "destructive" | "outline" | "secondary" | "success" | "warning";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

const BADGE_TONE_CLASS: Record<BadgeTone, string> = {
  default: "text-bg-primary",
  destructive: "text-bg-danger",
  outline: "bg-transparent border border-current text-body",
  secondary: "text-bg-secondary",
  success: "text-bg-success",
  warning: "text-bg-warning",
};

export function Badge({ className, tone = "default", ...props }: BadgeProps) {
  return <span className={cn("badge", BADGE_TONE_CLASS[tone], className)} {...props} />;
}

/* ------------------------------------------------------------------ */
/* Form controls                                                        */
/* ------------------------------------------------------------------ */

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, type = "text", ...props }, ref) {
    // `form-control` covers text-like inputs; checkbox/radio keep the
    // native control so Bootstrap's `.form-check` can wrap them.
    if (type === "checkbox" || type === "radio") {
      return <input ref={ref} type={type} className={cn("form-check-input", className)} {...props} />;
    }
    return <input ref={ref} type={type} className={cn("form-control", className)} {...props} />;
  },
);

export const Label = React.forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(
  function Label({ className, ...props }, ref) {
    return <label ref={ref} className={cn("form-label", className)} {...props} />;
  },
);

export interface SelectOptionProps {
  children: React.ReactNode;
  value: string;
}

/**
 * Declarative marker only — it never renders. `Select` reads its
 * children, so the option list stays plain data.
 */
export function SelectOption(_props: SelectOptionProps): null {
  return null;
}

export interface SelectProps {
  children?: React.ReactNode;
  className?: string;
  disabled?: boolean;
  id?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  style?: React.CSSProperties;
  value?: string;
}

export function Select({
  children,
  className,
  disabled,
  id,
  onValueChange,
  placeholder,
  style,
  value,
}: SelectProps) {
  const options = React.Children.toArray(children).filter(
    (child): child is React.ReactElement<SelectOptionProps> =>
      React.isValidElement(child) && child.type === SelectOption,
  );

  return (
    <select
      className={cn("form-select", className)}
      disabled={disabled}
      id={id}
      onChange={(event) => onValueChange?.(event.target.value)}
      style={style}
      value={value}
    >
      {placeholder ? (
        <option disabled value="">
          {placeholder}
        </option>
      ) : null}
      {options.map((option) => {
        const { children: optionLabel, value: optionValue } = option.props;
        return (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        );
      })}
    </select>
  );
}

export const Switch = React.forwardRef<
  HTMLInputElement,
  Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> & {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  }
>(function Switch({ checked, className, onCheckedChange, onClick, ...props }, ref) {
  return (
    <div className={cn("form-check form-switch", className)}>
      <input
        ref={ref}
        aria-checked={checked}
        checked={checked}
        className="form-check-input"
        onChange={(event) => onCheckedChange(event.target.checked)}
        onClick={onClick}
        role="switch"
        type="checkbox"
        {...props}
      />
    </div>
  );
});

export const Checkbox = React.forwardRef<
  HTMLInputElement,
  Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange"> & {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  }
>(function Checkbox({ checked, className, onCheckedChange, ...props }, ref) {
  return (
    <input
      ref={ref}
      checked={checked}
      className={cn("form-check-input", className)}
      onChange={(event) => onCheckedChange?.(event.target.checked)}
      type="checkbox"
      {...props}
    />
  );
});

/* ------------------------------------------------------------------ */
/* Typography                                                           */
/* ------------------------------------------------------------------ */

export interface TypographyOwnProps {
  compressed?: boolean | null;
  courier?: boolean | null;
  expanded?: boolean | null;
  mondwest?: boolean | null;
  mono?: boolean | null;
  sans?: boolean | null;
  variant?: "sm" | "md" | "lg" | "xl" | null;
}

export type TypographyProps<T extends React.ElementType = "span"> = TypographyOwnProps &
  Omit<React.ComponentPropsWithoutRef<T>, "color">;

const TYPOGRAPHY_VARIANT_CLASS: Record<string, string> = {
  sm: "fs-sm",
  md: "",
  lg: "fs-lg",
  xl: "fs-xl",
};

function Typography<T extends React.ElementType = "span">({
  as,
  className,
  compressed,
  courier,
  expanded,
  mondwest,
  mono,
  sans,
  variant = "md",
  ...props
}: TypographyProps<T> & { as?: T }) {
  const Tag = (as ?? "span") as React.ElementType;
  return (
    <Tag
      className={cn(
        "typography",
        TYPOGRAPHY_VARIANT_CLASS[variant as string] ?? "",
        mono && "font-monospace",
        courier && "typography-courier",
        sans && "font-sans",
        expanded && "typography-expanded",
        compressed && "typography-compressed",
        mondwest && "typography-mondwest",
        className,
      )}
      {...props}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Layout primitives                                                    */
/* ------------------------------------------------------------------ */

export interface ListItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
}

export const ListItem = React.forwardRef<HTMLButtonElement, ListItemProps>(function ListItem(
  { active, className, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      aria-current={active ? "true" : undefined}
      className={cn("list-group-item list-group-item-action", active && "active", className)}
      type="button"
      {...props}
    />
  );
});

export interface SeparatorProps extends React.HTMLAttributes<HTMLDivElement> {
  orientation?: "horizontal" | "vertical";
}

export function Separator({ className, orientation = "horizontal", ...props }: SeparatorProps) {
  return (
    <div
      aria-orientation={orientation}
      className={cn(orientation === "vertical" ? "vr" : "hr", className)}
      role="separator"
      {...props}
    />
  );
}

export interface SegmentedOption<T extends string> {
  label: string;
  value: T;
}

export interface SegmentedProps<T extends string> {
  className?: string;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  size?: "md" | "sm";
  value: T;
}

export function Segmented<T extends string>({
  className,
  onChange,
  options,
  size = "md",
  value,
}: SegmentedProps<T>) {
  return (
    <div
      className={cn("btn-group", size === "sm" ? "btn-group-sm" : "segmented", className)}
      role="group"
    >
      {options.map((option) => (
        <button
          aria-pressed={option.value === value}
          className={cn("btn", option.value === value ? "btn-primary active" : "btn-ghost")}
          key={option.value}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function FilterGroup({ children, className, label }: { children: React.ReactNode; className?: string; label: string }) {
  return (
    <fieldset className={cn("filter-group", className)}>
      <legend className="form-label">{label}</legend>
      {children}
    </fieldset>
  );
}

export interface TabsProps {
  children: (active: string, setActive: (value: string) => void) => React.ReactNode;
  className?: string;
  defaultValue: string;
}

export function Tabs({ children, className, defaultValue }: TabsProps) {
  const [active, setActive] = React.useState(defaultValue);
  return <div className={cn("tabs", className)}>{children(active, setActive)}</div>;
}

export function TabsList({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("nav nav-tabs", className)} role="tablist" {...props} />;
}

export interface TabsTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active: boolean;
  value: string;
}

export function TabsTrigger({ active, className, value: _value, ...props }: TabsTriggerProps) {
  return (
    <button
      aria-selected={active}
      className={cn("nav-link", active && "active")}
      role="tab"
      type="button"
      {...props}
    />
  );
}

export interface StatsProps extends React.ComponentProps<"div"> {
  items: {
    label: string | { key: string; node: React.ReactNode };
    value: string | { key: string; node: React.ReactNode };
  }[];
  flip?: boolean;
}

export function Stats({ className, items, flip, ...props }: StatsProps) {
  return (
    <div className={cn("stats", flip && "stats-flip", className)} {...props}>
      {items.map((item, index) => (
        <div className="stat" key={index}>
          <span className="stat-label">
            {typeof item.label === "string" ? item.label : item.label.node}
          </span>
          <span className="stat-value">
            {typeof item.value === "string" ? item.value : item.value.node}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Feedback surfaces                                                    */
/* ------------------------------------------------------------------ */

export interface ConfirmDialogProps {
  cancelLabel?: string;
  confirmLabel?: string;
  description?: string;
  destructive?: boolean;
  loading?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  open: boolean;
  title: string;
}

export function ConfirmDialog({
  cancelLabel = "Cancel",
  confirmLabel = "Confirm",
  description,
  destructive,
  loading,
  onCancel,
  onConfirm,
  open,
  title,
}: ConfirmDialogProps) {
  if (!open) return null;

  return (
    <>
      <div
        aria-hidden
        className="modal-backdrop fade show"
        onClick={onCancel}
        role="presentation"
      />
      <div
        aria-modal="true"
        aria-labelledby="hermes-confirm-title"
        aria-describedby={description ? "hermes-confirm-description" : undefined}
        className="modal fade show d-block"
        role="dialog"
      >
        <div className="modal-dialog modal-dialog-centered">
          <div className="modal-content">
            <div className="modal-header">
              <h2 className="modal-title h5" id="hermes-confirm-title">
                {title}
              </h2>
              <button
                aria-label="Close"
                className="btn-close"
                disabled={loading}
                onClick={onCancel}
                type="button"
              />
            </div>
            {description ? (
              <div className="modal-body" id="hermes-confirm-description">
                <p className="mb-0">{description}</p>
              </div>
            ) : null}
            <div className="modal-footer">
              <button className="btn btn-outline-secondary" disabled={loading} onClick={onCancel} type="button">
                {cancelLabel}
              </button>
              <button
                className={cn("btn", destructive ? "btn-danger" : "btn-primary")}
                disabled={loading}
                onClick={onConfirm}
                type="button"
              >
                {loading ? <Spinner className="me-2" /> : null}
                {confirmLabel}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export interface BottomSheetProps {
  backdropDismissLabel?: string;
  children: React.ReactNode;
  onClose: () => void;
  open: boolean;
  title: string;
}

export function BottomSheet({ children, onClose, open, title }: BottomSheetProps) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose, open]);

  if (!open) return null;

  return ReactDOM.createPortal(
    <div className="bottom-sheet-layer">
      <div aria-hidden className="modal-back fade show" onClick={onClose} role="presentation" />
      <section aria-modal="true" aria-label={title} className="bottom-sheet show" role="dialog">
        <div className="bottom-sheet-grabber" />
        <header className="bottom-sheet-header">
          <h2 className="h5 mb-0">{title}</h2>
          <button aria-label="Close" className="btn-close" onClick={onClose} type="button" />
        </header>
        <div className="bottom-sheet-body">{children}</div>
      </section>
    </div>,
    document.body,
  );
}

export function Toast({ toast }: { toast: { message: string; type: "error" | "success" } | null }) {
  if (!toast) return null;
  return ReactDOM.createPortal(
    <div aria-live="polite" className="toast-container position-fixed bottom-0 end-0 p-3">
      <div
        className={cn("toast show", toast.type === "error" ? "text-bg-danger" : "text-bg-success")}
        role="status"
      >
        <div className="toast-body">{toast.message}</div>
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ */
/* Spinner                                                             */
/* ------------------------------------------------------------------ */

export interface SpinnerProps extends React.HTMLAttributes<HTMLSpanElement> {
  name?: string;
  style?: React.CSSProperties;
}

export function Spinner({ className, name, style, ...props }: SpinnerProps) {
  return (
    <span
      aria-hidden={props["aria-label"] ? undefined : "true"}
      className={cn("spinner-border spinner-border-sm align-middle", className)}
      role={props["aria-label"] ? "status" : undefined}
      style={style}
      {...props}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Copy-to-clipboard                                                    */
/* ------------------------------------------------------------------ */

export interface CopyButtonProps {
  children?: React.ReactNode;
  className?: string;
  copiedLabel?: string;
  label?: string;
  resetDelayMs?: number;
  text: string;
}

export function CopyButton({
  children,
  className,
  copiedLabel = "Copied!",
  label = "Copy",
  resetDelayMs = 2000,
  text,
}: CopyButtonProps) {
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), resetDelayMs);
    return () => window.clearTimeout(timer);
  }, [copied, resetDelayMs]);

  return (
    <Button
      className={className}
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
      }}
      outlined
      size="sm"
    >
      {children ?? (copied ? copiedLabel : label)}
    </Button>
  );
}

export function CommandBlock({ className, code, label }: { className?: string; code: string; label: string }) {
  return (
    <div className={cn("command-block", className)}>
      <div className="d-flex align-items-center justify-content-between mb-2">
        <span className="form-label mb-0">{label}</span>
        <CopyButton text={code} />
      </div>
      <pre className="command-block-code">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Portal + selection switcher (no-ops kept for import parity)          */
/* ------------------------------------------------------------------ */

export function SelectionSwitcher(): null {
  return null;
}

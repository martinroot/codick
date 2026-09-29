/**
 * The three symbols the app imported from the old design system that have
 * no visual component to port — two hooks and one heading alias. They
 * lived in `@nous-research/ui` and came along with it when the import
 * paths were rewritten; here they are Bootstrap-native and package-free.
 */

import { useCallback, useEffect, useState } from "react";

import { Typography, type TypographyOwnProps } from "./primitives";

/**
 * True while the viewport is narrower than `width`.
 *
 * The old package's version of this ran a resize listener through its own
 * context. `matchMedia` is the right tool: the browser does the
 * breakpoint arithmetic, and it fires only when the answer actually
 * changes rather than on every resize event.
 */
export function useBelowBreakpoint(width: number): boolean {
  const query = `(max-width: ${width - 0.02}px)`;
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    setMatches(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

export interface ConfirmDeleteState<TId = string> {
  /** The row the dialog was opened for, or null for a bulk delete. */
  pendingId: TId | null;
  isOpen: boolean;
  isDeleting: boolean;
  /** Open the dialog for `id`, or call with no argument for a bulk delete. */
  requestDelete: (id?: TId) => void;
  cancel: () => void;
  /** Runs `onDelete` and reports whether it is still in flight. */
  confirm: () => Promise<void>;
}

export interface UseConfirmDeleteOptions<TId> {
  /**
   * Declared with method syntax on purpose. That makes the parameter
   * bivariant, so a call site whose handler takes a narrower id — a `key`,
   * a `serverName` — is still assignable. Function property syntax would be
   * checked contravariantly under `strictFunctionTypes` and reject every
   * one of them.
   */
  onDelete(id: TId): Promise<void>;
}

/**
 * The delete-confirmation state machine.
 *
 * Dialogs cannot be closed while the request is in flight — dismissing
 * one mid-delete leaves the list showing a row that is about to vanish.
 * That guard is why this is a hook rather than three `useState` calls at
 * every call site.
 *
 * Generic over the id type because `plugins/registry.ts` constrains it:
 * the plugin contract is `useConfirmDelete<TId>({ onDelete })`, and a
 * `string | null` signature is not assignable to that. Accepts the
 * callback either bare or in an options object; the old package took the
 * object, and the bare form reads better where a page already has one.
 */
export function useConfirmDelete<TId = string>(
  options: UseConfirmDeleteOptions<TId>,
): ConfirmDeleteState<TId>;
export function useConfirmDelete<TId = string>(
  onDelete: (id: TId) => Promise<void>,
): ConfirmDeleteState<TId>;
export function useConfirmDelete<TId = string>(
  options: UseConfirmDeleteOptions<TId> | ((id: TId) => Promise<void>),
): ConfirmDeleteState<TId> {
  const onDelete: (id: TId) => Promise<void> =
    typeof options === "function" ? options : options.onDelete;

  const [pendingId, setPendingId] = useState<TId | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  // A bulk delete carries no id, so "open" cannot be inferred from
  // `pendingId` — that is null in exactly the same situation as "closed".
  const [isOpen, setIsOpen] = useState(false);

  const requestDelete = useCallback((id?: TId) => {
    setPendingId(id ?? null);
    setIsOpen(true);
  }, []);

  const cancel = useCallback(() => {
    if (isDeleting) return;
    setIsOpen(false);
  }, [isDeleting]);

  const confirm = useCallback(async () => {
    if (isDeleting) return;
    setIsDeleting(true);
    try {
      await onDelete(pendingId as TId);
      setIsOpen(false);
    } finally {
      setIsDeleting(false);
    }
  }, [isDeleting, onDelete, pendingId]);

  return {
    pendingId,
    isOpen,
    isDeleting,
    requestDelete,
    cancel,
    confirm,
  };
}

/**
 * The old package exposed a per-level `H2` module. Bootstrap owns heading
 * semantics and type scale, so this is a thin alias over `Typography`
 * with the level fixed — the call sites read as a heading, which is what
 * they mean.
 *
 * Props extend the native `h2` attributes rather than `Typography`'s own,
 * because the call sites pass `children`, `variant` and `mondwest` through
 * from the component they were extracted from.
 */
export interface H2Props
  extends Omit<React.ComponentProps<"h2">, "className">,
    Omit<TypographyOwnProps, "className"> {
  className?: string;
  variant?: TypographyOwnProps["variant"];
  mondwest?: boolean;
}

export function H2({ className, ...props }: H2Props) {
  return (
    <Typography
      as="h2"
      className={["h4 fw-semibold mb-0", className].filter(Boolean).join("  ")}
      {...(props as TypographyOwnProps)}
    />
  );
}

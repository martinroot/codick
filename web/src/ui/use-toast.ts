/**
 * Toast state hook.
 *
 * Same contract as the old design system's `use-toast`: a page calls
 * `showToast(message, type)` and renders `<Toast toast={toast} />` once
 * near its root. The timer clears the toast after `duration` ms, and a
 * new toast restarts the countdown rather than stacking.
 */

import * as React from "react";

export type ToastType = "error" | "success";

export interface ToastPayload {
  message: string;
  type: ToastType;
}

export function useToast(duration = 4000): {
  showToast: (message: string, type: ToastType) => void;
  toast: ToastPayload | null;
} {
  const [toast, setToast] = React.useState<ToastPayload | null>(null);
  const timerRef = React.useRef<number | null>(null);

  React.useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const showToast = React.useCallback(
    (message: string, type: ToastType) => {
      setToast({ message, type });
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        setToast(null);
        timerRef.current = null;
      }, duration);
    },
    [duration],
  );

  return { showToast, toast };
}

import { type ClassValue, clsx } from "clsx";

/**
 * Class-name joiner.
 *
 * `tailwind-merge` used to sit here to make the last utility win, which
 * only made sense while Tailwind generated the utilities. With the
 * framework gone there is nothing to merge against: the generated
 * `ui/legacy-utilities.css` rules and Bootstrap's own cascade resolve
 * each class on their own, so a plain clsx join is the honest
 * implementation.
 */
export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

/* The Mondwest brand face is gone. Every one of these three helpers
 * existed only to apply it, and the class they injected resolved to
 * nothing, so they were carrying empty strings through every call site
 * that spread one into a className. They now contribute no styling of
 * their own — callers that need a type role use Bootstrap's utilities. */
export const themedFont = "";

/** Body copy — nothing to add beyond what the element already has. */
export const themedBody = "";

/** Brand chrome — a weight, which is the part that survives the move. */
export const themedChrome = "fw-semibold";

/** Relative time from a Unix epoch timestamp (seconds). */
export function timeAgo(ts: number): string {
  const delta = Date.now() / 1000 - ts;
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  if (delta < 172800) return "yesterday";
  return `${Math.floor(delta / 86400)}d ago`;
}

/** Relative time from an ISO-8601 timestamp string. */
export function isoTimeAgo(iso: string): string {
  const delta = (Date.now() - new Date(iso).getTime()) / 1000;
  if (delta < 0 || Number.isNaN(delta)) return "unknown";
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

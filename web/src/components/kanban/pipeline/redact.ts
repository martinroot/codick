/** What the Data/API tab is allowed to show (spec §10).
 *
 * The spec says the tab shows ``run_id``, ``step_id``, ``request_id``,
 * ``response_schema``, an example response, the collected data and the validation
 * errors — and then says **not** to show secrets, credentials, system
 * instructions or private filesystem paths, "and that is a check, not a
 * convention".
 *
 * So this is a check. A convention is a comment; a comment does not stop a
 * later field from being added to a payload that a Copy button then puts on the
 * clipboard. The tab runs every value it is about to render through
 * `assertDisplayable` and refuses the ones that fail, so the failure is a
 * visible refusal rather than a leak nobody notices.
 *
 * ## What is refused, and why each one
 *
 * - **Private filesystem paths.** An absolute home path leaks the username and
 *   the layout, and in a screenshot it is the one thing that identifies the
 *   machine.
 * - **Credential-shaped strings.** Keys and tokens are refused whether they look
 *   like a known provider's format or not, because the tab's job is to show a
 *   schema and a draft answer, and neither ever needs a secret.
 * - **System instructions.** A step's instruction is the agent's own prompt; the
 *   tab is a debugging surface, not a place to re-publish it.
 *
 * Refusal names the offending *key path*, never the value, so the diagnostic
 * does not print the secret it just refused.
 */

/** A value the tab must not render, located by its path in the payload. */
export interface Disclosure {
  path: string;
  kind: "path" | "credential" | "instructions";
  reason: string;
}

const CREDENTIAL_KEY = /(pass(word|phrase)?|secret|token|api[-_]?key|credential|private[-_]?key|authorization|bearer|session[-_]?id)/i;
const INSTRUCTION_KEY = /(system[-_]?prompt|system[-_]?instruction|instruction|prompt|persona)/i;
const PATH_KEY = /(^|_)(path|file|filename|filepath|dir|directory|home|root)($|_)/i;

/** `/home/alice/…`, `/root/…`, `C:\Users\…` — a home-anchored absolute path. */
const ABSOLUTE_PATH = /(^|[\s"'(=])\/(?:home|root|Users|var\/folders|mnt|media)\/[^\s"')]*/;
/** A Windows user profile, and a UNC path. */
const WINDOWS_PATH = /[A-Za-z]:\\Users\\[^\s"')]+|^\\\\[^\s"')]+/;

/** A provider-shaped key, in a string value. Format-agnostic on purpose.
 *
 * Two shapes, because the providers disagree: most emit a separator after the
 * prefix (`sk-…`, `ghp_…`, `xoxb-…`) while AWS access key ids are a bare `AKIA`
 * plus 16 uppercase alphanumerics. Demanding a separator matched everything
 * except the one format with none, which is the format that leaked.
 */
const CREDENTIAL_SEPARATED = /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|gho|AIza|xox[baprs])[-_][A-Za-z0-9_-]{8,}/;
const CREDENTIAL_BARE = /\bAKIA[0-9A-Z]{16}\b/;
/** A JWT, and a `key=value` assignment that hands over a secret. */
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/;
const ASSIGNMENT_SECRET = /\b(?:api[_-]?key|token|secret|password)\s*[=:]\s*\S{6,}/i;

function walk(value: unknown, path: string, out: Disclosure[]): void {
  if (typeof value === "string") {
    if (ABSOLUTE_PATH.test(value) || WINDOWS_PATH.test(value)) {
      out.push({ path, kind: "path", reason: "absolute home path" });
    }
    if (CREDENTIAL_SEPARATED.test(value) || CREDENTIAL_BARE.test(value)
      || JWT.test(value) || ASSIGNMENT_SECRET.test(value)) {
      out.push({ path, kind: "credential", reason: "credential-shaped value" });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, out));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const here = path ? `${path}.${key}` : key;
      // The key alone is enough: a field named `password` is a secret wherever it
      // comes from, and a field that merely *mentions* one should be renamed by
      // the author rather than quietly rendered.
      if (CREDENTIAL_KEY.test(key)) {
        out.push({ path: here, kind: "credential", reason: `key is named like a credential (${key})` });
      } else if (INSTRUCTION_KEY.test(key) && typeof nested === "string" && nested.trim() !== "") {
        out.push({ path: here, kind: "instructions", reason: `key is named like a system instruction (${key})` });
      } else if (PATH_KEY.test(key) && typeof nested === "string" && looksAbsolute(nested)) {
        out.push({ path: here, kind: "path", reason: `key is named like a path (${key})` });
      } else {
        walk(nested, here, out);
      }
    }
  }
}

function looksAbsolute(value: string): boolean {
  return ABSOLUTE_PATH.test(value) || WINDOWS_PATH.test(value);
}

/** Everything in `payload` the tab must not render. Empty means it is safe. */
export function findDisclosures(payload: unknown): Disclosure[] {
  const out: Disclosure[] = [];
  walk(payload, "", out);
  return out;
}

export class DisclosureError extends Error {
  readonly disclosures: Disclosure[];
  constructor(disclosures: Disclosure[]) {
    const first = disclosures[0];
    super(
      `refusing to display ${first.path}: ${first.reason} (${disclosures.length} total)`
    );
    this.name = "DisclosureError";
    this.disclosures = disclosures;
  }
}

/**
 * Throw unless the payload is safe to show. Use this at the point of rendering,
 * not at the point of building — a field added later is caught by the call that
 * displays it.
 */
export function assertDisplayable(payload: unknown): void {
  const found = findDisclosures(payload);
  if (found.length > 0) throw new DisclosureError(found);
}

/** True when the payload is safe. For callers that would rather hide a tab. */
export function isDisplayable(payload: unknown): boolean {
  return findDisclosures(payload).length === 0;
}

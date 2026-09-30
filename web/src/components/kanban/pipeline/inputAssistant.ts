/** The input assistant (spec §7).
 *
 * ## What it is allowed to do, and what it is not
 *
 * The spec says the assistant "helps collect `response_schema` and nothing
 * else: it does not change the template, the route or other steps' results, and
 * it never invents a value the user did not give. An empty answer the user means
 * is stated explicitly, not filled in."
 *
 * So it reads the user's own words and lifts values out of them. It does not
 * generate. `approved: true` may be read from a line the user typed; it may
 * **not** be inferred from "looks good to me", because that is a guess about a
 * decision the user has not made, and a guess written into a run's snapshot is
 * indistinguishable afterwards from one the user actually made.
 *
 * That asymmetry is the whole design. Being helpful here means being *literal*,
 * and the cost of being clever is an approval nobody gave.
 *
 * ## The three states of a field
 *
 * - **filled** — the user's own words, mapped to the field.
 * - **blank by choice** — the user explicitly wrote it empty, so it stays empty
 *   and the form says so. Not a missing value to nag about.
 * - **unfilled** — nobody said anything about it. Reported, never defaulted.
 */

export type FieldState = "filled" | "blank_by_choice" | "unfilled" | "kept";

export interface DraftField {
  name: string;
  state: FieldState;
  value: unknown;
  /** The line the value came from, so the user can see where it came from. */
  from: string | null;
}

export interface Draft {
  values: Record<string, unknown>;
  fields: DraftField[];
  /** Fields nobody mentioned. Named, not filled. */
  unfilled: string[];
  /** Fields the user deliberately left empty. */
  blankByChoice: string[];
}

const BLANK_MARKERS = new Set([
  "",
  "-",
  "—",
  "n/a",
  "na",
  "none",
  "null",
  "nil",
  "(empty)",
  "(blank)",
  "пусто",
  "нет",
  "пропустить",
]);

const TRUE_WORDS = new Set(["true", "yes", "y", "да", "ок", "окей", "одобряю", "approve", "approved"]);
const FALSE_WORDS = new Set(["false", "no", "n", "нет", "не", "отклонить", "rejected", "reject"]);

/**
 * A boolean, only when the user's own token is one of the words that mean it.
 *
 * "looks good" is not in either set on purpose. Reading an approval out of it
 * would be inventing the one value in the response that must not be invented.
 */
export function literalBoolean(raw: string): boolean | null {
  const token = raw.trim().toLowerCase();
  if (TRUE_WORDS.has(token)) return true;
  if (FALSE_WORDS.has(token)) return false;
  return null;
}

/** A number, only when the whole token is the number. */
export function literalNumber(raw: string): number | null {
  const token = raw.trim();
  if (!/^-?\d+(\.\d+)?$/.test(token)) return null;
  const parsed = Number(token);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `topic: sales`, `topic = sales`, `topic: да` — one assignment per line. */
export function parseAssignments(text: string): { name: string; raw: string; line: string }[] {
  const out: { name: string; raw: string; line: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*[-*]?\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*[:=]\s*(.*)$/.exec(line);
    if (match) out.push({ name: match[1], raw: match[2], line: line.trim() });
  }
  return out;
}

/** What one assignment turned out to be — and refusing to conflate them. */
type Coerced =
  | { kind: "value"; value: unknown }
  /** The user wrote a blank marker: a deliberate empty. */
  | { kind: "blank" }
  /**
   * The user wrote something this field cannot take — prose where a boolean
   * belongs, say. Not a blank and not a value: calling it a blank would tell the
   * user they had chosen emptiness when they had in fact said something the
   * assistant did not understand.
   */
  | { kind: "unrecognised"; said: string };

function coerce(kind: string, raw: string): Coerced {
  if (BLANK_MARKERS.has(raw.trim().toLowerCase())) return { kind: "blank" };
  if (kind === "boolean") {
    const bool = literalBoolean(raw);
    return bool === null ? { kind: "unrecognised", said: raw.trim() } : { kind: "value", value: bool };
  }
  if (kind === "number") {
    const num = literalNumber(raw);
    return num === null ? { kind: "unrecognised", said: raw.trim() } : { kind: "value", value: num };
  }
  return { kind: "value", value: raw.trim() };
}

/**
 * Lift what the user wrote into the schema's fields.
 *
 * `current` is the form as it stands: a field the user already filled in the
 * form is `kept` and is never overwritten by a draft, because the form is the
 * answer and the draft is only a reading of their prose.
 */
export function draftFromText(
  fields: { name: string; kind: string }[],
  text: string,
  current: Record<string, unknown> = {}
): Draft {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const values: Record<string, unknown> = {};
  const sources = new Map<string, string>();
  const unrecognised = new Map<string, string>();

  for (const { name, raw, line } of parseAssignments(text)) {
    const field = byName.get(name);
    // An assignment to a field the schema does not declare is ignored rather than
    // smuggled in: the response is validated against this schema, and a value
    // for a field that is not in it is a typo, not an answer.
    if (!field) continue;
    if (name in current) continue;
    const coerced = coerce(field.kind, raw);
    if (coerced.kind === "blank") {
      // Stated empty. Recorded as the choice it is, and kept out of `values`.
      sources.set(name, line);
      continue;
    }
    if (coerced.kind === "unrecognised") {
      // Said, but not something this field can take. Not filled, and not a
      // deliberate blank: the note has to say the words were not understood.
      unrecognised.set(name, line);
      continue;
    }
    values[name] = coerced.value;
    sources.set(name, line);
  }

  const out: DraftField[] = fields.map((field) => {
    if (field.name in current) {
      return { name: field.name, state: "kept", value: current[field.name], from: null };
    }
    if (field.name in values) {
      return { name: field.name, state: "filled", value: values[field.name], from: sources.get(field.name) ?? null };
    }
    const source = sources.get(field.name);
    if (source !== undefined) {
      return { name: field.name, state: "blank_by_choice", value: null, from: source };
    }
    // Said something unusable, or said nothing. Both leave the field unfilled;
    // the note distinguishes them.
    return {
      name: field.name,
      state: "unfilled",
      value: null,
      from: unrecognised.get(field.name) ?? null,
    };
  });

  return {
    values,
    fields: out,
    unfilled: out.filter((f) => f.state === "unfilled").map((f) => f.name),
    blankByChoice: out.filter((f) => f.state === "blank_by_choice").map((f) => f.name),
  };
}

/** The sentence the chat shows under a field, or null when it needs none. */
export function noteFor(field: DraftField): string | null {
  switch (field.state) {
    case "unfilled":
      return field.from
        ? `You wrote “${field.from}”, but it is not a value this field takes — nothing was filled in.`
        : "You have not said anything about this — it will be sent empty.";
    case "blank_by_choice":
      return "You left this empty on purpose, so it will be sent empty.";
    case "filled":
      return field.from ? `Read from “${field.from}”.` : null;
    case "kept":
      return "Kept the value you typed in the form.";
  }
}

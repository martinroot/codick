/** Form fields generated from a template's `inputs_schema` (spec §9).
 *
 * ## Why generate rather than hand-write
 *
 * The panel runs any imported template, including one the author has never seen.
 * A form written per template cannot do that, and a template whose inputs are
 * silently ignored is worse than no form: the run starts with defaults the author
 * did not choose and finds out at the review.
 *
 * So the fields come from the schema, and anything the schema does not describe
 * is reported as *unsupported* rather than dropped — an invisible input is a
 * missing input.
 */

export type FieldKind = "string" | "number" | "boolean" | "object" | "unsupported";

export interface InputField {
  name: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  description: string | null;
  /** For a boolean, whether the checkbox starts ticked. */
  defaultValue: boolean | null;
  /** For a number. */
  numericMin: number | null;
  numericMax: number | null;
  /** True when the schema says nothing usable about this property. */
  unsupported: boolean;
}

/** `topic` → `Topic`, `report_title` → `Report title`. */
export function humanize(name: string): string {
  const spaced = name.replace(/[_-]+/g, " ").trim();
  if (!spaced) return name;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function kindOf(prop: unknown): FieldKind {
  if (!prop || typeof prop !== "object") return "unsupported";
  const schema = prop as Record<string, unknown>;
  const declared = schema.type;
  if (typeof declared === "string") {
    if (declared === "string" || declared === "integer" || declared === "number"
      || declared === "boolean" || declared === "object") {
      return declared === "integer" || declared === "number" ? "number" : declared;
    }
    return "unsupported";
  }
  // A union or a missing `type` is not something this MVP renders; `anyOf` with
  // one usable branch is the common case and is worth one step of unwrapping.
  const anyOf = schema.anyOf;
  if (Array.isArray(anyOf) && anyOf.length > 0) {
    const kinds = new Set(anyOf.map(kindOf));
    if (kinds.size === 1) return [...kinds][0];
  }
  return "unsupported";
}

function numberBound(prop: unknown, key: "minimum" | "maximum"): number | null {
  if (!prop || typeof prop !== "object") return null;
  const value = (prop as Record<string, unknown>)[key];
  return typeof value === "number" ? value : null;
}

/** The fields for a template's `inputs_schema`, in schema order. */
export function fieldsFromInputsSchema(schema: unknown): InputField[] {
  if (!schema || typeof schema !== "object") return [];
  const properties = (schema as Record<string, unknown>).properties;
  if (!properties || typeof properties !== "object") return [];
  const required = new Set(
    Array.isArray((schema as Record<string, unknown>).required)
      ? ((schema as Record<string, unknown>).required as unknown[]).filter(
        (v): v is string => typeof v === "string")
      : []
  );
  const entries = properties as Record<string, unknown>;

  return Object.keys(entries).map((name) => {
    const prop = entries[name];
    const kind = kindOf(prop);
    const description =
      prop && typeof prop === "object" && typeof (prop as Record<string, unknown>).description === "string"
        ? ((prop as Record<string, unknown>).description as string)
        : null;
    const hasDefault =
      prop && typeof prop === "object" && "default" in (prop as Record<string, unknown>);
    const defaultValue =
      kind === "boolean" && hasDefault ? Boolean((prop as Record<string, unknown>).default) : null;

    return {
      name,
      label: humanize(name),
      kind,
      required: required.has(name),
      description,
      defaultValue,
      numericMin: numberBound(prop, "minimum"),
      numericMax: numberBound(prop, "maximum"),
      unsupported: kind === "unsupported",
    };
  });
}

/** Fields the MVP cannot render, named so the panel can say so out loud. */
export function unsupportedFields(fields: InputField[]): InputField[] {
  return fields.filter((f) => f.unsupported);
}

/**
 * Why this run cannot start, by field name.
 *
 * The check has to run against what {@link buildInputs} actually produced, not
 * against the raw form values. They are not the same thing: a required number
 * field holding `"abc"` is present in the form, so a presence check passes, and
 * then `buildInputs` drops it for being non-numeric — and the run starts with a
 * required input silently missing. The author filled the field in, watched it
 * type, and got a report that does not contain it.
 *
 * This is the same reasoning as "unknown is never zero", one layer up: a value
 * that could not be carried is absent, and absent is not valid.
 */
export function inputProblems(
  fields: InputField[],
  values: Record<string, unknown>
): Record<string, string> {
  const built = buildInputs(fields, values);
  const problems: Record<string, string> = {};

  for (const field of fields) {
    const raw = values[field.name];
    if (field.unsupported) {
      // Only a *value* the form cannot render is a blocker. An untouched
      // optional array is not: `buildInputs` omits it, and reporting it would
      // make every run on a template with an optional attachment refuse to
      // start over a field nobody filled in.
      if (field.required || (raw !== undefined && raw !== null
          && !(typeof raw === "string" && raw.trim() === ""))) {
        problems[field.name] = "this input cannot be entered here — use Load JSON";
      }
      continue;
    }
    const missing = raw === undefined || raw === null
      || (typeof raw === "string" && raw.trim() === "");

    if (missing) {
      if (field.required) problems[field.name] = "required";
      continue;
    }
    // Present in the form but absent from the payload: it could not be carried.
    if (!(field.name in built)) {
      problems[field.name] = field.kind === "number"
        ? `not a number: ${JSON.stringify(raw)}`
        : "could not be used as entered";
      continue;
    }
    if (field.kind === "number" && field.numericMin !== null) {
      const value = built[field.name] as number;
      if (value < field.numericMin) {
        problems[field.name] = `must be at least ${field.numericMin}`;
      }
    }
    if (field.kind === "number" && field.numericMax !== null) {
      const value = built[field.name] as number;
      if (value > field.numericMax) {
        problems[field.name] = `must be at most ${field.numericMax}`;
      }
    }
  }
  return problems;
}

/** Missing required values, by field name. */
export function missingRequired(fields: InputField[], values: Record<string, unknown>): string[] {
  return fields
    .filter((f) => f.required)
    .filter((f) => {
      const value = values[f.name];
      if (value === undefined || value === null) return true;
      if (typeof value === "string") return value.trim() === "";
      return false;
    })
    .map((f) => f.name);
}

/**
 * The values to send, coerced and stripped of blanks.
 *
 * Blank optional fields are omitted rather than sent as `""`, because the run's
 * snapshot is what later steps read and an empty string is a value someone
 * chose.
 */
export function buildInputs(
  fields: InputField[],
  values: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.unsupported) continue;
    const raw = values[field.name];
    if (raw === undefined || raw === null) continue;
    if (typeof raw === "string" && raw.trim() === "" && !field.required) continue;
    if (field.kind === "number") {
      const parsed = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (Number.isFinite(parsed)) out[field.name] = parsed;
      continue;
    }
    if (field.kind === "boolean") {
      out[field.name] = Boolean(raw);
      continue;
    }
    out[field.name] = typeof raw === "string" ? raw.trim() : raw;
  }
  return out;
}

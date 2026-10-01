/**
 * #66 — the form and Load JSON must produce the same run, and a form that
 * cannot be carried must refuse rather than quietly shrink.
 *
 * The bug this file is about is an inconsistency between two functions that
 * each look correct alone. `missingRequired` inspects the raw form values, so a
 * required number field holding `"abc"` counts as filled; `buildInputs` then
 * drops it for being non-numeric. Presence check passes, payload omits the
 * field, and the run starts missing an input the author can see on screen.
 */

import { describe, expect, it } from "vitest";

import {
  buildInputs,
  fieldsFromInputsSchema,
  humanize,
  inputProblems,
  missingRequired,
  type FieldKind,
  type InputField,
} from "./inputForm";

const SCHEMA = {
  type: "object",
  properties: {
    report_title: { type: "string", description: "What the report is called" },
    author: { type: "string" },
    page_count: { type: "integer", minimum: 1, maximum: 50 },
    include_summary: { type: "boolean", default: true },
    attachments: { type: "array", items: { type: "string" } },
  },
  required: ["report_title", "page_count"],
};

const fields = fieldsFromInputsSchema(SCHEMA);
const byName = (name: string) => fields.find((f) => f.name === name)!;

function makeField(overrides: Partial<InputField>): InputField {
  return {
    name: "field",
    label: "Field",
    kind: "string" as FieldKind,
    required: false,
    description: null,
    defaultValue: null,
    numericMin: null,
    numericMax: null,
    unsupported: false,
    ...overrides,
  };
}

// --- the gap -----------------------------------------------------------------


describe("inputProblems", () => {
  it("rejects a required number the form could not carry", () => {
    const problems = inputProblems(fields, { report_title: "Weekly", page_count: "abc" });
    expect(problems.page_count).toMatch(/not a number/);
  });

  it("the old presence check passed this exact case", () => {
    // "abc" is a non-blank string, so nothing about it looks missing.
    expect(missingRequired(fields, { report_title: "Weekly", page_count: "abc" })).toEqual([]);
    // Which is precisely why presence alone is not the check.
    expect(buildInputs(fields, { report_title: "Weekly", page_count: "abc" })).not.toHaveProperty(
      "page_count"
    );
  });

  it("a field that is absent from the payload is never silently absent", () => {
    const values = { report_title: "Weekly", page_count: "12" };
    const payload = buildInputs(fields, values);
    for (const name of Object.keys(payload)) {
      expect(inputProblems(fields, values)).not.toHaveProperty(name);
    }
  });

  it("accepts a valid number and reports nothing", () => {
    expect(inputProblems(fields, { report_title: "Weekly", page_count: 12 })).toEqual({});
  });

  it("accepts a numeric string, which is what a text input yields", () => {
    expect(inputProblems(fields, { report_title: "Weekly", page_count: "12" })).toEqual({});
  });

  // --- required ------------------------------------------------------------

  it("names a required field that was never filled", () => {
    const problems = inputProblems(fields, { report_title: "Weekly" });
    expect(problems.page_count).toBe("required");
  });

  it("treats a whitespace-only required field as unfilled", () => {
    expect(inputProblems(fields, { report_title: "   " }).report_title).toBe("required");
  });

  it("treats zero as a value, not as missing", () => {
    const schema = {
      properties: { offset: { type: "integer" } },
      required: ["offset"],
    };
    expect(inputProblems(fieldsFromInputsSchema(schema), { offset: 0 })).toEqual({});
  });

  it("does not complain about an unfilled optional field", () => {
    expect(inputProblems(fields, { report_title: "Weekly", page_count: 3 })).toEqual({});
  });

  // --- range ---------------------------------------------------------------

  it("enforces the schema minimum", () => {
    expect(inputProblems(fields, { report_title: "W", page_count: 0 }).page_count).toMatch(
      /at least 1/
    );
  });

  it("enforces the schema maximum", () => {
    expect(inputProblems(fields, { report_title: "W", page_count: 999 }).page_count).toMatch(
      /at most 50/
    );
  });

  it("accepts the bounds themselves", () => {
    expect(inputProblems(fields, { report_title: "W", page_count: 1 }).page_count).toBeUndefined();
    expect(inputProblems(fields, { report_title: "W", page_count: 50 }).page_count).toBeUndefined();
  });

  // --- unsupported ---------------------------------------------------------

  it("points at an input the form cannot render rather than dropping it", () => {
    const problems = inputProblems(fields, {
      report_title: "Weekly",
      page_count: 3,
      attachments: ["a.pdf"],
    });
    expect(problems.attachments).toMatch(/Load JSON/);
  });

  it("an unrenderable optional input is fine while nobody has filled it", () => {
    // Reporting this would make every run on a template with an optional
    // attachment refuse to start over a field nobody touched.
    const f = [makeField({ name: "odd", kind: "unsupported", unsupported: true })];
    expect(inputProblems(f, {})).toEqual({});
  });

  it("an unrenderable input blocks the moment it carries a value", () => {
    // The author typed something only Load JSON can carry. Silently dropping it
    // would run without an input that is visibly on screen.
    const f = [makeField({ name: "odd", kind: "unsupported", unsupported: true })];
    expect(inputProblems(f, { odd: ["a.pdf"] })).toHaveProperty("odd");
  });

  it("a required unrenderable input blocks even when untouched", () => {
    const f = [makeField({
      name: "odd", kind: "unsupported", unsupported: true, required: true,
    })];
    expect(inputProblems(f, {})).toHaveProperty("odd");
  });
});

// --- the form and Load JSON must agree ---------------------------------------

describe("the form and Load JSON agree", () => {
  it("produces the same payload for the same meaning", () => {
    const typed = buildInputs(fields, {
      report_title: "  Weekly report  ",
      page_count: "12",
      include_summary: true,
    });
    // What pasting the equivalent JSON through Load JSON would send.
    const pasted = { report_title: "Weekly report", page_count: 12, include_summary: true };
    expect(typed).toEqual(pasted);
  });

  it("both paths pass the same validation", () => {
    const typed = { report_title: "Weekly", page_count: 12 };
    const pasted = { report_title: "Weekly", page_count: 12 };
    expect(inputProblems(fields, typed)).toEqual(inputProblems(fields, pasted));
  });

  it("a form left blank sends nothing optional, and JSON can say the same", () => {
    expect(buildInputs(fields, { report_title: "W", page_count: 1, author: "  " })).toEqual({
      report_title: "W",
      page_count: 1,
    });
  });
});

// --- field derivation ---------------------------------------------------------

describe("fieldsFromInputsSchema", () => {
  it("keeps schema order, so the form reads like the template", () => {
    expect(fields.map((f) => f.name)).toEqual([
      "report_title",
      "author",
      "page_count",
      "include_summary",
      "attachments",
    ]);
  });

  it("labels a field for a human", () => {
    expect(byName("report_title").label).toBe("Report title");
    expect(humanize("report_title")).toBe("Report title");
  });

  it("carries the description through as help text", () => {
    expect(byName("report_title").description).toBe("What the report is called");
  });

  it("reads a boolean default from the schema", () => {
    expect(byName("include_summary").defaultValue).toBe(true);
  });

  it("carries numeric bounds so the form and the check agree", () => {
    expect(byName("page_count").numericMin).toBe(1);
    expect(byName("page_count").numericMax).toBe(50);
  });

  it("marks an array it cannot render instead of dropping it", () => {
    expect(byName("attachments").unsupported).toBe(true);
    expect(byName("attachments").kind).toBe("unsupported");
  });

  it("returns nothing for a template with no inputs schema", () => {
    expect(fieldsFromInputsSchema(null)).toEqual([]);
    expect(fieldsFromInputsSchema({})).toEqual([]);
    expect(fieldsFromInputsSchema({ properties: "nope" })).toEqual([]);
  });
});

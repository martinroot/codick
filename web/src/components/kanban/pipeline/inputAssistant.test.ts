import { describe, expect, it } from "vitest";

import {
  draftFromText,
  literalBoolean,
  literalNumber,
  noteFor,
  parseAssignments,
} from "@/components/kanban/pipeline/inputAssistant";

const FIELDS = [
  { name: "topic", kind: "string" },
  { name: "pages", kind: "number" },
  { name: "include_charts", kind: "boolean" },
];

describe("literalBoolean", () => {
  it("reads a decision the user actually wrote", () => {
    for (const yes of ["yes", "да", "true", "одобряю", "approved"]) {
      expect(literalBoolean(yes), yes).toBe(true);
    }
    for (const no of ["no", "нет", "false", "rejected"]) {
      expect(literalBoolean(no), no).toBe(false);
    }
  });

  it("refuses to read a decision out of anything else", () => {
    // "looks good" is the case that matters. Reading `true` from it would put an
    // approval into the run's snapshot that nobody gave, and afterwards it would
    // be indistinguishable from one they did.
    for (const prose of ["looks good", "probably fine", "ship it", "не уверен", "ок, наверное"]) {
      expect(literalBoolean(prose), prose).toBeNull();
    }
  });
});

describe("literalNumber", () => {
  it("reads a bare number and nothing else", () => {
    expect(literalNumber("12")).toBe(12);
    expect(literalNumber("-3.5")).toBe(-3.5);
    expect(literalNumber("12 pages")).toBeNull();
    expect(literalNumber("about ten")).toBeNull();
  });
});

describe("parseAssignments", () => {
  it("reads one assignment per line, in either separator style", () => {
    expect(parseAssignments("topic: sales\npages = 4\n- include_charts: yes")).toEqual([
      { name: "topic", raw: "sales", line: "topic: sales" },
      { name: "pages", raw: "4", line: "pages = 4" },
      { name: "include_charts", raw: "yes", line: "- include_charts: yes" },
    ]);
  });

  it("ignores prose that is not an assignment", () => {
    expect(parseAssignments("please use the sales data\nthanks!")).toEqual([]);
  });
});

describe("draftFromText", () => {
  it("lifts the values the user wrote", () => {
    const draft = draftFromText(FIELDS, "topic: sales\npages: 4\ninclude_charts: yes");
    expect(draft.values).toEqual({ topic: "sales", pages: 4, include_charts: true });
  });

  it("reports a field nobody mentioned instead of defaulting it", () => {
    const draft = draftFromText(FIELDS, "topic: sales");
    expect(draft.unfilled).toEqual(["pages", "include_charts"]);
    expect(draft.values).not.toHaveProperty("pages");
  });

  it("carries a stated empty as the choice it is, not as a gap", () => {
    const draft = draftFromText(FIELDS, "topic: sales\npages: —");
    expect(draft.blankByChoice).toEqual(["pages"]);
    expect(draft.unfilled).toEqual(["include_charts"]);
    expect(draft.values).not.toHaveProperty("pages");
  });

  it("never overrides what the user typed in the form", () => {
    const draft = draftFromText(FIELDS, "topic: from prose", { topic: "from the form" });
    expect(draft.values).not.toHaveProperty("topic");
    expect(draft.fields.find((f) => f.name === "topic")?.state).toBe("kept");
  });

  it("ignores an assignment to a field the schema does not declare", () => {
    // The response is validated against this schema; a value for a field that is
    // not in it is a typo, not an answer.
    const draft = draftFromText(FIELDS, "topic: sales\nsecret_note: something");
    expect(draft.values).not.toHaveProperty("secret_note");
  });

  it("does not invent a boolean out of prose, and does not call it a blank either", () => {
    // The value is not invented — and the field is not reported as a deliberate
    // empty, because the user said something; they said something unusable, and
    // saying so is the only honest note.
    const draft = draftFromText(FIELDS, "topic: sales\ninclude_charts: отличная идея");
    expect(draft.unfilled).toContain("include_charts");
    expect(draft.blankByChoice).not.toContain("include_charts");
    expect(draft.values.include_charts).toBeUndefined();
    const note = noteFor(draft.fields.find((f) => f.name === "include_charts")!);
    expect(note).toMatch(/not a value this field takes/);
    expect(note).toContain("отличная идея");
  });
});

describe("noteFor", () => {
  it("says plainly that an unsaid field will be sent empty", () => {
    const draft = draftFromText(FIELDS, "topic: sales");
    const note = noteFor(draft.fields.find((f) => f.name === "pages")!);
    expect(note).toMatch(/not said anything/);
    expect(note).toMatch(/sent empty/);
  });

  it("distinguishes a deliberate blank from an unanswered field", () => {
    const draft = draftFromText(FIELDS, "topic: sales\npages: пусто");
    const note = noteFor(draft.fields.find((f) => f.name === "pages")!);
    expect(note).toMatch(/on purpose/);
  });

  it("shows the line a value was read from, so it can be checked", () => {
    const draft = draftFromText(FIELDS, "topic: sales");
    const note = noteFor(draft.fields.find((f) => f.name === "topic")!);
    expect(note).toContain("topic: sales");
  });
});

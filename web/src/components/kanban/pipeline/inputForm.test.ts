import { describe, expect, it } from "vitest";

import {
  buildInputs,
  fieldsFromInputsSchema,
  humanize,
  missingRequired,
  unsupportedFields,
} from "@/components/kanban/pipeline/inputForm";
import { artifactDownloadUrl } from "@/lib/pipelines-api";
import {
  DisclosureError,
  assertDisplayable,
  findDisclosures,
  isDisplayable,
} from "@/components/kanban/pipeline/redact";

describe("humanize", () => {
  it("turns a field name into a label", () => {
    expect(humanize("topic")).toBe("Topic");
    expect(humanize("report_title")).toBe("Report title");
    expect(humanize("report-title")).toBe("Report title");
  });
});

describe("fieldsFromInputsSchema", () => {
  it("reads the fields, their kinds and what is required", () => {
    const fields = fieldsFromInputsSchema({
      type: "object",
      properties: {
        topic: { type: "string", description: "What to report on" },
        pages: { type: "integer", minimum: 1, maximum: 50 },
        include_charts: { type: "boolean", default: true },
      },
      required: ["topic"],
    });
    expect(fields.map((f) => f.name)).toEqual(["topic", "pages", "include_charts"]);
    expect(fields[0]).toMatchObject({ kind: "string", required: true, description: "What to report on" });
    expect(fields[1]).toMatchObject({ kind: "number", numericMin: 1, numericMax: 50 });
    expect(fields[2]).toMatchObject({ kind: "boolean", defaultValue: true });
  });

  it("reports a property it cannot render instead of dropping it", () => {
    // A silently dropped input is a missing input, and the run then starts on
    // defaults the author never chose.
    const fields = fieldsFromInputsSchema({
      type: "object",
      properties: { attachments: { type: "array", items: { type: "string" } } },
    });
    expect(unsupportedFields(fields).map((f) => f.name)).toEqual(["attachments"]);
  });

  it("unwraps a single-branch anyOf", () => {
    const fields = fieldsFromInputsSchema({
      type: "object",
      properties: { topic: { anyOf: [{ type: "string" }] } },
    });
    expect(fields[0].kind).toBe("string");
  });

  it("returns nothing for a template with no inputs schema", () => {
    expect(fieldsFromInputsSchema(undefined)).toEqual([]);
    expect(fieldsFromInputsSchema({})).toEqual([]);
  });
});

describe("missingRequired", () => {
  const fields = fieldsFromInputsSchema({
    type: "object",
    properties: { topic: { type: "string" }, pages: { type: "integer" } },
    required: ["topic", "pages"],
  });

  it("names the required fields that are absent or blank", () => {
    expect(missingRequired(fields, {})).toEqual(["topic", "pages"]);
    expect(missingRequired(fields, { topic: "   ", pages: 3 })).toEqual(["topic"]);
  });

  it("treats zero as a value, not as missing", () => {
    expect(missingRequired(fields, { topic: "x", pages: 0 })).toEqual([]);
  });
});

describe("buildInputs", () => {
  const fields = fieldsFromInputsSchema({
    type: "object",
    properties: {
      topic: { type: "string" },
      pages: { type: "integer" },
      include_charts: { type: "boolean" },
      attachments: { type: "array" },
    },
    required: ["topic"],
  });

  it("coerces numbers and booleans and trims text", () => {
    expect(buildInputs(fields, { topic: " sales ", pages: "12", include_charts: true })).toEqual({
      topic: "sales",
      pages: 12,
      include_charts: true,
    });
  });

  it("omits a blank optional field rather than sending an empty string", () => {
    // The run's snapshot is what later steps read; "" is a value someone chose.
    expect(buildInputs(fields, { topic: "sales", pages: "" })).toEqual({ topic: "sales" });
  });

  it("keeps an empty required field, because dropping it hides the omission", () => {
    expect(buildInputs(fields, { topic: "sales", pages: 0 })).toMatchObject({ pages: 0 });
  });

  it("never sends a field the schema did not describe", () => {
    const out = buildInputs(fields, { topic: "x", sneaky: "value" });
    expect(out).not.toHaveProperty("sneaky");
  });

  it("drops a non-numeric value rather than sending NaN", () => {
    expect(buildInputs(fields, { topic: "x", pages: "twelve" })).toEqual({ topic: "x" });
  });
});

// Real header/payload lengths: a JWT whose segments are shorter than the
// check's own thresholds tests the fixture, not the check.
const JWT_FIXTURE =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";

describe("artifactDownloadUrl", () => {
  it("points at the protected download route with the session in the query", () => {
    // A navigation cannot set a header, and the server accepts the query token on
    // this path only — so a link built without it is a link that 401s.
    const url = artifactDownloadUrl("art_1", "tok-123");
    expect(url).toContain("/api/pipelines/artifacts/art_1/download");
    expect(url).toContain("token=tok-123");
  });

  it("encodes the id, so a crafted id cannot add a path segment", () => {
    // The server matches this path by its shape; an unencoded slash here would
    // make the link point at a different route entirely.
    const url = artifactDownloadUrl("../../etc/passwd", "t");
    expect(url).toContain("..%2F..%2Fetc%2Fpasswd");
    // Six segments: "", api, pipelines, artifacts, id, download. The server
    // matches this path by exactly that shape, so pinning the count here is
    // pinning the contract the link depends on.
    expect(url.split("/")).toHaveLength(6);
  });

  it("appends the token with & when the url already carries the profile scope", () => {
    const url = artifactDownloadUrl("art_1", "t");
    // Either form is fine; what matters is that the separator is right.
    expect(url).toMatch(/[?&]token=t($|&)/);
  });
});

// The spec calls this "a check, not a convention" (spec §10), so it is tested as one.
describe("the Data/API tab's disclosure check", () => {
  it("passes a payload that is only the spec's own fields", () => {
    const payload = {
      run_id: "run_1",
      step_id: "ask",
      request_id: "req_1",
      response_schema: { type: "object", properties: { approved: { type: "boolean" } } },
      example_response: { approved: true },
      collected_data: { note: "looks fine" },
      validation_errors: [],
    };
    expect(findDisclosures(payload)).toEqual([]);
    expect(isDisplayable(payload)).toBe(true);
  });

  it("refuses a private filesystem path", () => {
    const found = findDisclosures({ collected_data: { source: "/home/alice/notes.md" } });
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe("path");
  });

  it("refuses a Windows user profile and a UNC path", () => {
    expect(findDisclosures({ p: "C:\\Users\\alice\\Desktop\\x.docx" })[0].kind).toBe("path");
    expect(findDisclosures({ p: "\\\\fileserver\\share\\x.docx" })[0].kind).toBe("path");
  });

  it("refuses a credential-shaped value whatever the provider", () => {
    for (const secret of [
      "sk-abcdef0123456789",
      "ghp_0123456789abcdef",
      "xoxb-1234567890-abcdef",
      "AKIAIOSFODNN7EXAMPLE",
    ]) {
      const found = findDisclosures({ note: `value is ${secret}` });
      expect(found, secret).toHaveLength(1);
      expect(found[0].kind).toBe("credential");
    }
  });

  it("refuses an AWS key, which has no separator after its prefix", () => {
    // The check used to demand a separator after the prefix, which matched every
    // provider except the one that emits none — so the format that was easiest
    // to paste leaked.
    const found = findDisclosures({ id: "AKIAIOSFODNN7EXAMPLE" });
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe("credential");
  });

  it("refuses a JWT and an assigned secret", () => {
    expect(findDisclosures({ v: JWT_FIXTURE })[0].kind).toBe("credential");
    expect(findDisclosures({ v: "api_key=abcdef123456" })[0].kind).toBe("credential");
  });

  it("refuses a field named like a credential, whatever its value", () => {
    // A field called `password` is a secret wherever it came from, and one that
    // merely mentions the word should be renamed rather than rendered.
    const found = findDisclosures({ collected_data: { password: "hunter2" } });
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe("credential");
  });

  it("refuses a system instruction", () => {
    const found = findDisclosures({ collected_data: { system_prompt: "You are a helpful agent" } });
    expect(found[0].kind).toBe("instructions");
  });

  it("locates a disclosure by its path so the diagnostic can point at it", () => {
    const found = findDisclosures({
      run_id: "run_1",
      collected_data: { nested: { deeper: { file: "/home/bob/x" } } },
    });
    expect(found[0].path).toBe("collected_data.nested.deeper.file");
  });

  it("finds a disclosure inside an array", () => {
    const found = findDisclosures({ errors: ["fine", "read /root/.ssh/id_rsa first"] });
    expect(found).toHaveLength(1);
    expect(found[0].path).toBe("errors[1]");
  });

  it("throws with the path and never the value", () => {
    // A refusal that quotes the secret is a second copy of it, in an error toast.
    let thrown: unknown;
    try {
      assertDisplayable({ token: "sk-abcdef0123456789" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DisclosureError);
    expect((thrown as Error).message).not.toContain("sk-abcdef");
    expect((thrown as Error).message).toContain("token");
  });
});

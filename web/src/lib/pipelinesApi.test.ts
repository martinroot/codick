import { describe, expect, it } from "vitest";

import { describeFailure } from "@/lib/pipelines-api";

/**
 * A failed pipeline request has to say what to change, not just that it failed.
 *
 * The FastAPI validation dialect is the one that used to disappear: its body is
 * an array of `{loc, msg}` with no `message` key, so the client fell through to
 * a bare status. These pin every dialect, because "which one did we forget" is
 * only discoverable by hitting the mistake.
 */
describe("describeFailure", () => {
  it("passes through our own detail.message", () => {
    expect(
      describeFailure(409, { message: "template is not runnable", readiness: "unavailable" }),
    ).toBe("template is not runnable");
  });

  it("names the offending path from a FastAPI validation array", () => {
    const detail = [
      { loc: ["body", "inputs", "source_document"], msg: "Input should be a valid string" },
      { loc: ["body", "template_id"], msg: "Field required" },
    ];
    const message = describeFailure(422, detail);
    expect(message).toContain("422");
    expect(message).toContain("body.inputs.source_document");
    expect(message).toContain("Field required");
  });

  it("still reports the status when the validation array is unusable", () => {
    // A body that is not the shape we expect must not silently vanish.
    expect(describeFailure(422, ["unexpected"])).toContain("422");
    expect(describeFailure(500, null)).toBe("pipeline request failed (500)");
    expect(describeFailure(503, {})).toBe("pipeline request failed (503)");
  });

  it("keeps a plain-text body", () => {
    expect(describeFailure(502, "upstream is down")).toBe("upstream is down");
    // A blank body carries no information, so the status stands alone.
    expect(describeFailure(502, "   ")).toBe("pipeline request failed (502)");
  });

  it("falls back to the status when the message is blank", () => {
    // A blank message is not a reason; rendering it would show the operator
    // nothing at all.
    expect(describeFailure(409, { message: "" })).toBe("pipeline request failed (409)");
    expect(describeFailure(409, { message: "   " })).toBe("pipeline request failed (409)");
  });
});
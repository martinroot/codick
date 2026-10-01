import { describe, expect, it } from "vitest";

import { describeFailure, pipelinesApi } from "@/lib/pipelines-api";

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
/**
 * A JSON body with no declared type leaves the wire as `text/plain`, and the
 * server then answers 422 blaming the payload's shape -- an error that reads
 * like the caller's data is malformed when the caller's data is fine. Any
 * caller supplying its own headers has to state the type, and the run-creation
 * call supplies an idempotency key.
 */
describe("pipelinesApi.createRun", () => {
  it("declares JSON when it adds a body alongside its own headers", async () => {
    let seen: RequestInit | undefined;
    const originalFetch = globalThis.fetch;
    // `authedFetch` reads the session token off `window`, which a node test has
    // no business having; the value is irrelevant to the header under test.
    const originalWindow = globalThis.window;
    (globalThis as { window?: unknown }).window = { __HERMES_SESSION_TOKEN__: "test-token" };
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seen = init;
      return new Response(JSON.stringify({ id: "run_1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await pipelinesApi.createRun({ templateId: "lease-dryfill", version: "1.0.1", inputs: {} });
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as { window?: unknown }).window = originalWindow;
    }

    const headers = new Headers(seen?.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Idempotency-Key")).toBeTruthy();
    expect(JSON.parse(seen?.body as string)).toMatchObject({
      template_id: "lease-dryfill",
      version: "1.0.1",
      inputs: {},
    });
  });
});

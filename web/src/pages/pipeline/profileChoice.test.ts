import { describe, expect, it } from "vitest";

import { pick } from "@/pages/pipeline/PipelineDesigner";

/**
 * The model is chosen in the profile, so the select value has to survive the
 * trip into the create call. An empty value is not an error -- it means "keep
 * the default profile's model" -- and a half-split value would send a provider
 * with no model, or a model with no provider.
 */
describe("pick", () => {
  it("splits a chosen provider and model apart", () => {
    expect(pick("openrouter\u0000gpt-4o")).toEqual({
      provider: "openrouter",
      model: "gpt-4o",
      label: "openrouter\u0000gpt-4o",
    });
  });

  it("means 'leave the default alone' when nothing was chosen", () => {
    expect(pick("")).toBeUndefined();
  });

  it("refuses a half-split value rather than sending half a choice", () => {
    expect(pick("openrouter\u0000")).toBeUndefined();
    expect(pick("\u0000gpt-4o")).toBeUndefined();
  });

  it("keeps a model name containing no separators intact", () => {
    expect(pick("local\u0000qwen/qwen3-30b")).toEqual({
      provider: "local",
      model: "qwen/qwen3-30b",
      label: "local\u0000qwen/qwen3-30b",
    });
  });
});

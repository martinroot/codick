import { describe, expect, it } from "vitest";

import type { PipelineTemplateBody } from "@/lib/pipelines-api";
import {
  parseWhen,
  templateToNodes,
  nodesToTemplate,
  newStep,
  type StepNodeData,
} from "@/pages/pipeline/canvas";
import type { Edge, Node } from "@xyflow/react";

/**
 * The round trip is the whole claim of a visual editor: what goes on the canvas
 * is the pipeline, and what comes back off it is the same pipeline. A lossy
 * round trip would quietly rewrite someone's run while they rearranged boxes,
 * which is worse than having no editor.
 */

const template: PipelineTemplateBody = {
  schema_version: "1.0",
  id: "design-app",
  name: "Design app",
  start_step: "brief",
  inputs_schema: { type: "object", properties: {} },
  steps: [
    { id: "brief", type: "agent", title: "Read the brief", profile: "writer", instruction: "list the screens", next: "draft" },
    { id: "draft", type: "delay", title: "Think", seconds: 5, next: "score" },
    { id: "score", type: "condition", title: "Score it", cases: [{ when: { op: "lt", left: "score", right: 8 }, next: "brief" }], default: { next: "ship" } },
    { id: "ship", type: "agent", title: "Ship", instruction: "write the summary", next: null },
  ],
};

function roundTrip(body: PipelineTemplateBody) {
  const { nodes, edges } = templateToNodes(body);
  return nodesToTemplate(nodes, edges, {
    id: body.id ?? "x",
    version: "1.0.0",
    name: body.name ?? "x",
    startStep: body.start_step,
  });
}

describe("template <-> canvas", () => {
  it("keeps every step, with its type and its own fields", () => {
    const out = roundTrip(template);
    expect(out.steps?.map((s) => s.id).sort()).toEqual(["brief", "draft", "score", "ship"]);
    expect(out.start_step).toBe("brief");
    const brief = out.steps?.find((s) => s.id === "brief");
    expect(brief?.type).toBe("agent");
    expect(brief?.profile).toBe("writer");
    expect(brief?.instruction).toBe("list the screens");
  });

  it("keeps a branch, its guard and its target", () => {
    const score = roundTrip(template).steps?.find((s) => s.id === "score");
    expect(score?.type).toBe("condition");
    expect(score?.cases?.[0]?.next).toBe("brief");
    expect(score?.cases?.[0]?.when).toMatchObject({ op: "lt", right: 8 });
    expect(score?.default).toEqual({ next: "ship" });
  });

  it("keeps a delay's seconds, which are the entire step", () => {
    expect(roundTrip(template).steps?.find((s) => s.id === "draft")?.seconds).toBe(5);
  });

  it("survives a second pass unchanged", () => {
    const once = roundTrip(template);
    const twice = roundTrip(once);
    expect(twice.steps).toEqual(once.steps);
    expect(twice.start_step).toBe(once.start_step);
  });

  it("places steps in layers, and a loop does not hang the layout", () => {
    const { nodes } = templateToNodes(template);
    const y = (id: string) => nodes.find((n) => n.id === id)?.position.y ?? 0;
    expect(y("draft")).toBeGreaterThan(y("brief"));
    expect(y("ship")).toBeGreaterThan(y("draft"));
    // `score` points back at `brief`: the cycle must still produce a position.
    expect(Number.isFinite(y("score"))).toBe(true);
  });
});

describe("parseWhen", () => {
  it("reads a numeric comparison back as a number", () => {
    expect(parseWhen("score lt 8")).toEqual({ op: "lt", left: "score", right: 8 });
  });

  it("reads an existence check", () => {
    expect(parseWhen("steps.doc.output.artifact exists")).toEqual({
      op: "exists",
      left: "steps.doc.output.artifact",
    });
  });

  it("keeps text on both sides as text", () => {
    expect(parseWhen("steps.a.output.stage eq review")).toEqual({
      op: "eq",
      left: "steps.a.output.stage",
      right: "review",
    });
  });
});

describe("newStep", () => {
  it("gives a delay a sane default so a new block is already runnable in shape", () => {
    const node = newStep("wait", "delay", { x: 0, y: 0 });
    expect(node.data.kind).toBe("delay");
    expect(node.data.seconds).toBe(3);
  });

  it("survives the trip as a step the validator would accept", () => {
    const nodes: Node<StepNodeData>[] = [
      newStep("a", "agent", { x: 0, y: 0 }),
      newStep("b", "delay", { x: 200, y: 0 }),
    ];
    const edges: Edge[] = [{ id: "e", source: "a", target: "b" }];
    const out = nodesToTemplate(nodes, edges, { id: "t", version: "1.0.0", name: "T" });
    expect(out.steps?.find((s) => s.id === "b")).toMatchObject({ type: "delay", seconds: 3 });
    expect(out.steps?.find((s) => s.id === "a")?.next).toBe("b");
  });
});
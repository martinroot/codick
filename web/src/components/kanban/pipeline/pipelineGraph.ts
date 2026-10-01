import type { PipelineCase, PipelineStepTemplate, PipelineWhen } from "@/lib/pipelines-api";

/**
 * The shape of a pipeline as a person reads it: what runs, in what order, and
 * what each block leads to.
 *
 * The JSON is a flat `steps` array, and declaration order is not execution
 * order -- a condition can jump backwards, a loop can return to an earlier step,
 * and steps nobody reaches are still in the array. Drawing the array in order
 * would therefore draw a shape the run does not take, so the order here comes
 * from walking the transitions from `start_step`.
 *
 * Kept free of React so the awkward parts -- the backward edge, the loop, the
 * step no branch reaches -- can be tested as data.
 */

/** The name a `when` clause is shown under, short enough for a block edge. */
export function describeWhen(when: PipelineWhen | undefined): string {
  if (!when || typeof when !== "object") return "when";
  const op = typeof when.op === "string" ? when.op : "when";
  if ((op === "all" || op === "any") && Array.isArray(when.conditions) && when.conditions.length) {
    const inner = when.conditions.map((c) => describeWhen(c)).join(` ${op === "all" ? "and" : "or"} `);
    return inner.length > 60 ? `${inner.slice(0, 57)}…` : inner;
  }
  const left = operand(when.left);
  const right = operand(when.right);
  if (op === "exists") return `${left} exists`;
  if (right === undefined) return op;
  return `${left} ${op} ${right}`;
}

function operand(value: unknown): string {
  if (value === undefined) return "?";
  if (value === null) return "null";
  if (typeof value === "string") return value.length > 28 ? `${value.slice(0, 25)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export type EdgeKind = "next" | "case" | "default" | "rework";

export interface GraphEdge {
  from: string;
  /** `null` when the step finishes the run. */
  to: string | null;
  label: string;
  kind: EdgeKind;
}

export interface GraphNode {
  step: PipelineStepTemplate;
  /** Execution order, starting at 0. */
  index: number;
  isStart: boolean;
  isEnd: boolean;
  /** True when no branch from `start_step` reaches this step. */
  unreachable: boolean;
  /** Steps that lead here, excluding the walk order. */
  loopsFrom: string[];
}

export interface PipelineGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Step ids named by a transition that the template does not contain. */
  danglingTargets: string[];
}

function outgoing(step: PipelineStepTemplate): GraphEdge[] {
  if (step.type === "condition") {
    const edges: GraphEdge[] = [];
    const cases = Array.isArray(step.cases) ? step.cases : [];
    cases.forEach((c: PipelineCase) => {
      const target = typeof c?.next === "string" ? c.next : null;
      edges.push({
        from: step.id,
        to: target,
        label: describeWhen(c?.when),
        kind: c?.rework === true ? "rework" : "case",
      });
    });
    const fallback = step.default?.next;
    if (step.default?.fail) {
      edges.push({ from: step.id, to: null, label: `fail: ${step.default.fail}`, kind: "default" });
    } else if (typeof fallback === "string") {
      edges.push({ from: step.id, to: fallback, label: "otherwise", kind: "default" });
    } else {
      // A condition with no default still ends the run when nothing matches --
      // that is how the executor treats a fall-through. Drawing only its cases
      // would make a step that can finish look like one that cannot.
      edges.push({ from: step.id, to: null, label: "otherwise", kind: "default" });
    }
    return edges;
  }
  const target = typeof step.next === "string" ? step.next : null;
  return [{ from: step.id, to: target, label: "", kind: "next" }];
}

export function buildPipelineGraph(
  steps: PipelineStepTemplate[],
  startStep?: string,
): PipelineGraph {
  const byId = new Map<string, PipelineStepTemplate>();
  for (const step of Array.isArray(steps) ? steps : []) {
    if (step && typeof step.id === "string" && !byId.has(step.id)) byId.set(step.id, step);
  }

  const edges: GraphEdge[] = [];
  const dangling = new Set<string>();
  for (const step of byId.values()) {
    for (const edge of outgoing(step)) {
      edges.push(edge);
      if (edge.to !== null && !byId.has(edge.to)) dangling.add(edge.to);
    }
  }

  // Walk from the start, following first-time steps only: a cycle must not spin
  // here. Anything the walk misses is a step no branch can reach.
  const order: string[] = [];
  const seen = new Set<string>();
  const start = startStep && byId.has(startStep) ? startStep : byId.keys().next().value;
  if (start !== undefined) {
    const queue: string[] = [start];
    while (queue.length) {
      const id = queue.shift() as string;
      if (seen.has(id) || !byId.has(id)) continue;
      seen.add(id);
      order.push(id);
      for (const edge of edges.filter((e) => e.from === id && e.to !== null)) {
        if (!seen.has(edge.to as string)) queue.push(edge.to as string);
      }
    }
  }

  const position = new Map(order.map((id, i) => [id, i]));
  const nodes: GraphNode[] = order.map((id, index) => {
    const step = byId.get(id) as PipelineStepTemplate;
    const mine = edges.filter((e) => e.from === id);
    const loopsFrom = mine
      .filter((e) => e.to !== null && (position.get(e.to as string) ?? Infinity) <= index)
      .map((e) => e.to as string);
    return {
      step,
      index,
      isStart: index === 0,
      // "Can end here", not "must": a condition with a matching case still
      // finishes the run when nothing matches.
      isEnd: mine.some((e) => e.to === null),
      unreachable: false,
      loopsFrom,
    };
  });

  for (const [id, step] of byId) {
    if (seen.has(id)) continue;
    nodes.push({
      step,
      index: nodes.length,
      isStart: false,
      isEnd: outgoing(step).some((e) => e.to === null),
      unreachable: true,
      loopsFrom: [],
    });
  }

  return { nodes, edges, danglingTargets: [...dangling] };
}

/** One line saying what a block does, from whichever field carries it. */
export function stepSummary(step: PipelineStepTemplate): string {
  if (step.type === "tool") return step.tool ?? "tool step";
  if (step.type === "delay") return step.seconds ? `wait ${step.seconds}s` : "wait";
  if (step.type === "user_input") return step.prompt ?? "ask";
  if (step.instruction) return step.instruction;
  if (step.profile) return `profile: ${step.profile}`;
  return step.type;
}
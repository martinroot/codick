import { Handle, Position, type NodeProps } from "@xyflow/react";

import type { NodeKind } from "./canvas";

/**
 * The block on the canvas.
 *
 * Colour carries meaning here rather than decoration: a glance at a pipeline
 * should say how many things wait on a person, how many branch, how long the
 * run takes. Five types, five hues, one glance.
 */

interface StepNodeShape {
  label: string;
  kind: NodeKind;
  summary: string;
  profile?: string;
  model?: string;
  tool?: string;
  seconds?: number;
}

const KIND_STYLE: Record<NodeKind, { bg: string; border: string; badge: string; icon: string }> = {
  agent: { bg: "#eef2ff", border: "#6366f1", badge: "text-bg-indigo", icon: "◈" },
  tool: { bg: "#ecfdf5", border: "#10b981", badge: "text-bg-success", icon: "⚒" },
  user_input: { bg: "#fffbeb", border: "#f59e0b", badge: "text-bg-warning", icon: "✋" },
  condition: { bg: "#fdf2f8", border: "#ec4899", badge: "text-bg-danger", icon: "⑂" },
  delay: { bg: "#f1f5f9", border: "#64748b", badge: "text-bg-secondary", icon: "◷" },
};

const KIND_NAME: Record<NodeKind, string> = {
  agent: "Agent",
  tool: "Tool",
  user_input: "Person",
  condition: "Branch",
  delay: "Wait",
};

export function StepNode({ data, selected }: NodeProps) {
  const d = data as unknown as StepNodeShape;
  const style = KIND_STYLE[d.kind] ?? KIND_STYLE.agent;
  return (
    <div
      className="rounded-3 border shadow-sm"
      style={{
        background: style.bg,
        borderColor: selected ? style.border : `${style.border}55`,
        borderWidth: selected ? 2 : 1.5,
        minWidth: "15rem",
        maxWidth: "19rem",
      }}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <div className="px-3 pt-2 pb-1 d-flex align-items-center gap-2">
        <span
          className="badge rounded-pill"
          style={{ background: style.border }}
          title={KIND_NAME[d.kind]}
        >
          {style.icon} {KIND_NAME[d.kind]}
        </span>
        {d.kind === "delay" && d.seconds ? (
          <span className="small text-body-secondary">{d.seconds}s</span>
        ) : null}
      </div>
      <div className="px-3 pb-1 fw-semibold" style={{ fontSize: "0.92rem" }}>
        {d.label}
      </div>
      <div className="px-3 pb-2 small text-body-secondary text-truncate" title={d.summary}>
        {d.summary}
      </div>
      {d.profile ? (
        <div
          className="px-3 py-1 border-top small"
          style={{ borderColor: `${style.border}33`, color: style.border }}
        >
          {d.profile}
          {d.model ? ` · ${d.model}` : ""}
        </div>
      ) : null}
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}

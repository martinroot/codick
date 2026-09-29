import { useEffect, useRef, useState } from "react";
import { Brain, Eye, Gauge, Lightbulb, Wrench } from "lucide-react";
import { Spinner } from "@/ui";
import { api } from "@/lib/api";
import type { ModelInfoResponse } from "@/lib/api";
import { compactNumber } from "@hermes/shared";

interface ModelInfoCardProps {
  /** Current model string from config state — used to detect changes */
  currentModel: string;
  /** Bumped after config saves to trigger re-fetch */
  refreshKey?: number;
}

export function ModelInfoCard({
  currentModel,
  refreshKey = 0,
}: ModelInfoCardProps) {
  const [info, setInfo] = useState<ModelInfoResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const lastFetchKeyRef = useRef("");

  useEffect(() => {
    if (!currentModel) return;
    // Re-fetch when model changes OR when refreshKey bumps (after save)
    const fetchKey = `${currentModel}:${refreshKey}`;
    if (fetchKey === lastFetchKeyRef.current) return;
    lastFetchKeyRef.current = fetchKey;
    setLoading(true);
    api
      .getModelInfo()
      .then(setInfo)
      .catch(() => setInfo(null))
      .finally(() => setLoading(false));
  }, [currentModel, refreshKey]);

  if (loading) {
    return (
      <div className="d-flex align-items-center gap-2 py-2 fs-6 text-body-secondary">
        <Spinner className="fs-6" />
        Loading model info…
      </div>
    );
  }

  if (!info || !info.model || info.effective_context_length <= 0) return null;

  const caps = info.capabilities;
  const hasCaps = caps && Object.keys(caps).length > 0;

  return (
    <div className="border border-border/60 bg-muted/30 px-3 py-2.5 stack-2">
      <div className="d-flex align-items-center gap-4 fs-6">
        <div className="d-flex align-items-center gap-2 text-body-secondary">
          <Gauge className="icon-sm" />
          <span className="fw-medium">Context Window</span>
        </div>
        <div className="d-flex align-items-center gap-2">
          <span className="font-monospace fw-semibold text-body-emphasis">
            {compactNumber(info.effective_context_length)}
          </span>
          {info.config_context_length > 0 ? (
            <span className="text-amber-500 fs-6">
              (override — auto: {compactNumber(info.auto_context_length)})
            </span>
          ) : (
            <span className="text-body-tertiary fs-6">
              auto-detected
            </span>
          )}
        </div>
      </div>

      {hasCaps && caps.max_output_tokens && caps.max_output_tokens > 0 && (
        <div className="d-flex align-items-center gap-4 fs-6">
          <div className="d-flex align-items-center gap-2 text-body-secondary">
            <Lightbulb className="icon-sm" />
            <span className="fw-medium">Max Output</span>
          </div>
          <span className="font-monospace fw-semibold text-body-emphasis">
            {compactNumber(caps.max_output_tokens)}
          </span>
        </div>
      )}

      {hasCaps && (
        <div className="d-flex flex-wrap align-items-center gap-2 pt-0.5">
          {caps.supports_tools && (
            <span className="d-inline-flex align-items-center gap-1 bg-success/10 px-2 py-0.5 fs-6 fw-medium text-success">
              <Wrench className="h-2.5 w-2.5" /> Tools
            </span>
          )}
          {caps.supports_vision && (
            <span className="d-inline-flex align-items-center gap-1 bg-blue-500/10 px-2 py-0.5 fs-6 fw-medium text-blue-600 dark:text-blue-400">
              <Eye className="h-2.5 w-2.5" /> Vision
            </span>
          )}
          {caps.supports_reasoning && (
            <span className="d-inline-flex align-items-center gap-1 bg-purple-500/10 px-2 py-0.5 fs-6 fw-medium text-purple-600 dark:text-purple-400">
              <Brain className="h-2.5 w-2.5" /> Reasoning
            </span>
          )}
          {caps.model_family && (
            <span className="d-inline-flex align-items-center gap-1 bg-muted px-2 py-0.5 fs-6 fw-medium text-body-secondary">
              {caps.model_family}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

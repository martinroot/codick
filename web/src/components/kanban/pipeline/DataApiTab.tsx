import * as React from "react";

import { findDisclosures } from "@/components/kanban/pipeline/redact";
import {
  collectedData,
  type PipelineRun,
  type PipelineTemplateBody,
} from "@/lib/pipelines-api";

/** One spec §10 row: a label, the value, and a Copy button. */
function Field({ label, value }: { label: string; value: unknown }) {
  const [copied, setCopied] = React.useState(false);
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);

  const copy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      // Copied is a transient receipt; leaving it up would claim a clipboard
      // state that stopped being true some seconds later.
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }, [text]);

  return (
    <div className="mb-2">
      <div className="d-flex justify-content-between align-items-center">
        <span className="small fw-semibold">{label}</span>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          onClick={copy}
          // The accessible name names the field, so a screen-reader user
          // stepping through seven identical buttons can tell them apart. An
          // icon alone, or a visually-hidden span with a leading space, leaves
          // seven buttons called "clipboard".
          aria-label={`Copy ${label}`}
          title={`Copy ${label}`}
        >
          <i className={`bi ${copied ? "bi-check" : "bi-clipboard"}`} aria-hidden="true" />
        </button>
      </div>
      <pre className="small bg-body-tertiary rounded p-2 mb-0 text-break overflow-auto">
        {text}
      </pre>
    </div>
  );
}

export interface DataApiTabProps {
  run: PipelineRun | null;
  template: PipelineTemplateBody | null;
  /** Field paths the server rejected, keyed by JSON path (spec §7). */
  validationErrors: { path: string; message: string }[];
}

/**
 * The Data/API tab (spec §10): the ids, the schemas, the collected data, the
 * validation errors — and a Copy button on each.
 *
 * ## The refusal is a feature, not an error
 *
 * The spec requires that this tab show no secrets, credentials, system
 * instructions or private filesystem paths, and calls that a check rather than a
 * convention. So the payload is assembled here, run through `findDisclosures`,
 * and whatever would be a disclosure is **named and withheld** — the tab still
 * renders everything it is allowed to, and the operator sees a list of the paths
 * it refused.
 *
 * The alternative, rendering nothing when anything trips, would make one stray
 * absolute path hide the whole run, and the fix would be to loosen the check.
 */
export function DataApiTab({ run, template, validationErrors }: DataApiTabProps) {
  const payload = React.useMemo(() => {
    if (!run) return null;
    // The response schema belongs to the *request*, not the template: a step
    // may narrow it, and the one a person must satisfy is the one on the open
    // request. The template's example is the author's sample, which is the
    // template body's business.
    const open = run.input_requests.find((r) => r.status === "open") ?? null;
    return {
      run_id: run.id,
      step_id: run.current_step_id,
      request_id: open?.id ?? null,
      response_schema: open?.response_schema ?? null,
      example_response: template?.example_response ?? null,
      collected_data: collectedData(run),
      validation_errors: validationErrors,
    };
  }, [run, template, validationErrors]);

  if (!run || !payload) {
    return <p className="text-body-secondary mb-0">No run selected.</p>;
  }

  const refused = findDisclosures(payload);
  const labels: [string, unknown][] = [
    ["run_id", payload.run_id],
    ["step_id", payload.step_id],
    ["request_id", payload.request_id],
    ["response_schema", payload.response_schema],
    ["example_response", payload.example_response],
    ["collected_data", payload.collected_data],
    ["validation_errors", payload.validation_errors],
  ];

  return (
    <div>
      {refused.length > 0 && (
        <div className="alert alert-warning py-2 px-3" role="status">
          <i className="bi bi-shield-exclamation me-2" aria-hidden="true" />
          <strong className="small">Withheld from this tab:</strong>
          <ul className="mb-0 mt-1 small">
            {refused.map((d) => (
              <li key={`${d.path}:${d.kind}`}>
                <code>{d.path}</code> — {d.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {labels
        .filter(([label]) => !refused.some((d) => label === d.path.split(".")[0]))
        .map(([label, value]) => (
          <Field key={String(label)} label={String(label)} value={value} />
        ))}
    </div>
  );
}

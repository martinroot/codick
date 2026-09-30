import * as React from "react";

import { ArtifactList } from "@/components/kanban/pipeline/ArtifactList";
import { DataApiTab } from "@/components/kanban/pipeline/DataApiTab";
import { InputChat } from "@/components/kanban/pipeline/InputChat";
import { StepStripView } from "@/components/kanban/pipeline/StepStripView";
import {
  buildInputs,
  fieldsFromInputsSchema,
  missingRequired,
  unsupportedFields,
} from "@/components/kanban/pipeline/inputForm";
import {
  buildStepStrip,
  cardLabelForRun,
  isOnReview,
  openInputRequest,
} from "@/components/kanban/pipeline/strip";
import {
  pipelinesApi,
  type PipelineRun,
  type PipelineTemplate,
  type PipelineTemplateSummary,
  type SchemaError,
} from "@/lib/pipelines-api";

export interface PipelinePanelProps {
  /** The card the operator has selected, if any. */
  selectedCardId: string | null;
  /** Called with the new run's card, so the board can open it. */
  onRunCreated: (cardId: string) => void;
  /** A failure must never read as "nothing happened". */
  onError: (message: string) => void;
}

/**
 * The pipeline panel (spec §9): pick a template, Load JSON, Run.
 *
 * ## Not a page, and not a shared stage
 *
 * It lives above the board and stays compact. With a card selected it shows that
 * card's run — its template, status and route — and nothing else; without one it
 * offers a short hint and a way to start. The alternative, a run list every card
 * sits inside, is the "shared stage" the spec rules out, and it would make a
 * card's identity depend on which run happened to be open.
 *
 * ## The backend is the state
 *
 * Nothing here mirrors run status. Every action re-reads the run from the server
 * and the caller re-reads the board, so a WebSocket event is a signal to refetch
 * and never a second state machine that can disagree with the first.
 */
export function PipelinePanel({ selectedCardId, onRunCreated, onError }: PipelinePanelProps) {
  const [templates, setTemplates] = React.useState<PipelineTemplateSummary[]>([]);
  const [templateId, setTemplateId] = React.useState<string>("");
  /** The stored row, which is what the server returns. */
  const [row, setRow] = React.useState<PipelineTemplate | null>(null);
  /** The template's own document, nested under `template` on the wire. */
  const body = row?.template ?? null;
  const [values, setValues] = React.useState<Record<string, unknown>>({});
  const [draft, setDraft] = React.useState<string>("");
  const [showJson, setShowJson] = React.useState(false);
  const [validationErrors, setValidationErrors] = React.useState<SchemaError[]>([]);
  const [run, setRun] = React.useState<PipelineRun | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [tab, setTab] = React.useState<"steps" | "data" | "input">("steps");

  // The callbacks are held in refs and deliberately left out of the effect
  // dependencies. The page passes `onError` as an inline arrow, so its identity
  // changes on every render; depending on it re-ran this effect each time, and
  // the panel asked the server for its templates in a loop. A ref is the honest
  // fix — the effect wants the current callback, not a new subscription every
  // time the parent re-renders.
  const onErrorRef = React.useRef(onError);
  React.useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  // The template list is a prerequisite for a control, not a detail: without it
  // the select is empty and Run has nothing to run.
  React.useEffect(() => {
    let cancelled = false;
    pipelinesApi
      .listTemplates()
      .then((res) => {
        if (cancelled) return;
        setTemplates(res.templates);
        setTemplateId((current) => current || res.templates[0]?.id || "");
      })
      .catch((err: unknown) => {
        if (!cancelled) onErrorRef.current(`Could not load templates: ${String(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    if (!templateId) {
      setRow(null);
      return;
    }
    let cancelled = false;
    pipelinesApi
      .getTemplate(templateId)
      .then((loaded) => {
        if (cancelled) return;
        setRow(loaded);
        setValues({});
        setValidationErrors([]);
      })
      .catch((err: unknown) => {
        if (!cancelled) onErrorRef.current(`Could not load template: ${String(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [templateId]);

  const fields = React.useMemo(
    () => fieldsFromInputsSchema(body?.inputs_schema),
    [body]
  );
  const missing = React.useMemo(() => missingRequired(fields, values), [fields, values]);
  const unsupported = React.useMemo(() => unsupportedFields(fields), [fields]);
  // Import readiness (#30, spec §6): a template that is stored but not runnable
  // is still selectable, and Run stays disabled with the reason on screen — a
  // silent disable would read as a broken button.
  const runnable = row?.readiness_status === "ready";

  const loadJson = React.useCallback(async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch (err) {
      setValidationErrors([{ path: "$", message: `Not valid JSON: ${String(err)}` }]);
      return;
    }
    setBusy(true);
    try {
      // Validate before storing: a template that is saved broken comes back on
      // every later run and fails there, far from the edit that caused it.
      const result = await pipelinesApi.validateTemplate(parsed);
      setValidationErrors(result.errors);
      if (!result.valid) return;
      const saved = await pipelinesApi.storeTemplate(parsed as PipelineTemplate);
      setRow(saved);
      setTemplateId(saved.id);
      setValues({});
      setShowJson(false);
    } catch (err) {
      onErrorRef.current(`Load JSON failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [draft]);

  const start = React.useCallback(async () => {
    if (!row || !body) return;
    if (missing.length > 0) {
      onErrorRef.current(`Fill in: ${missing.join(", ")}`);
      return;
    }
    setBusy(true);
    try {
      const created = await pipelinesApi.createRun({
        templateId: row.id,
        ...(row.version ? { version: row.version } : {}),
        inputs: buildInputs(fields, values),
      });
      setRun(created);
      if (created.card_id) onRunCreated(created.card_id);
    } catch (err) {
      onErrorRef.current(`Run failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [row, body, missing, fields, values, onRunCreated]);

  const steps = React.useMemo(
    () => (run && body ? buildStepStrip(body, run) : []),
    [run, body]
  );
  const openRequest = run ? openInputRequest(run) : null;

  // Re-attach to the card's run whenever the selection changes. This is what
  // makes the panel survive a reload: without it, coming back to answer a
  // question an hour later would show a card and no question.
  React.useEffect(() => {
    if (!selectedCardId) {
      setRun(null);
      return;
    }
    let cancelled = false;
    pipelinesApi
      .getRunByCard(selectedCardId)
      .then((found) => {
        if (!cancelled) setRun(found);
      })
      .catch(() => {
        // An ordinary card has no pipeline run, and that is not an error worth a
        // toast every time someone clicks a normal task.
        if (!cancelled) setRun(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedCardId]);

  // The server is the state, so answering re-reads the run rather than guessing
  // what it became. The dispatcher's next step is not ours to predict.
  const refreshRun = React.useCallback(async () => {
    if (!run) return;
    try {
      setRun(await pipelinesApi.getRun(run.id));
    } catch (err) {
      onErrorRef.current(`Could not refresh the run: ${String(err)}`);
    }
  }, [run]);

  return (
    <div className="card mb-3">
      <div className="card-body py-2">
        <div className="d-flex flex-wrap gap-2 align-items-end">
          <div className="flex-grow-1" style={{ minWidth: "14rem" }}>
            <label className="form-label small mb-1" htmlFor="pipeline-template">
              Template
            </label>
            <select
              id="pipeline-template"
              className="form-select form-select-sm"
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
            >
              {templates.length === 0 && <option value="">No templates yet</option>}
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary"
            onClick={() => setShowJson((v) => !v)}
          >
            Load JSON
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={start}
            disabled={busy || !row || !runnable || missing.length > 0}
          >
            {busy ? "Working…" : "Run"}
          </button>
        </div>

        {showJson && (
          <div className="mt-2">
            <textarea
              className="form-control form-control-sm font-monospace"
              rows={5}
              aria-label="Pipeline template JSON"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="d-flex gap-2 mt-1">
              <button
                type="button"
                className="btn btn-sm btn-outline-primary"
                onClick={loadJson}
                disabled={busy || draft.trim() === ""}
              >
                Validate and store
              </button>
            </div>
            {validationErrors.length > 0 && (
              <ul className="small text-danger mt-1 mb-0">
                {validationErrors.map((e) => (
                  <li key={`${e.path}:${e.message}`}>
                    <code>{e.path}</code> — {e.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {fields.length > 0 && (
          <div className="row g-2 mt-1">
            {fields.map((field) => (
              <div className="col-12 col-md-6 col-lg-4" key={field.name}>
                <label className="form-label small mb-1" htmlFor={`input-${field.name}`}>
                  {field.label}
                  {field.required && <span className="text-danger"> *</span>}
                </label>
                {field.unsupported ? (
                  <p className="small text-warning mb-0">
                    <i className="bi bi-exclamation-triangle me-1" aria-hidden="true" />
                    this panel cannot render <code>{field.name}</code> yet
                  </p>
                ) : field.kind === "boolean" ? (
                  <div className="form-check">
                    <input
                      id={`input-${field.name}`}
                      className="form-check-input"
                      type="checkbox"
                      checked={Boolean(values[field.name] ?? field.defaultValue ?? false)}
                      onChange={(e) =>
                        setValues((v) => ({ ...v, [field.name]: e.target.checked }))
                      }
                    />
                    <label className="form-check-label small" htmlFor={`input-${field.name}`}>
                      {field.description ?? "Enabled"}
                    </label>
                  </div>
                ) : (
                  <input
                    id={`input-${field.name}`}
                    className={`form-control form-control-sm${missing.includes(field.name) ? " is-invalid" : ""}`}
                    type={field.kind === "number" ? "number" : "text"}
                    value={String(values[field.name] ?? "")}
                    min={field.numericMin ?? undefined}
                    max={field.numericMax ?? undefined}
                    onChange={(e) =>
                      setValues((v) => ({ ...v, [field.name]: e.target.value }))
                    }
                  />
                )}
                {field.description && field.kind !== "boolean" && (
                  <div className="form-text">{field.description}</div>
                )}
              </div>
            ))}
          </div>
        )}

        {row && !runnable && (
          <p className="small text-warning mt-2 mb-0">
            <i className="bi bi-exclamation-triangle me-1" aria-hidden="true" />
            This template is not runnable yet
            {row.readiness_detail && row.readiness_detail.length > 0 && (
              <>: {row.readiness_detail.join("; ")}</>
            )}
          </p>
        )}

        {unsupported.length > 0 && (
          <p className="small text-warning mt-2 mb-0">
            {unsupported.length} input(s) this panel cannot render. They will be missing from the
            run.
          </p>
        )}

        {run && (
          <div className="mt-2 pt-2 border-top">
            <div className="d-flex justify-content-between align-items-center mb-1">
              <span className="small">
                <span className="badge text-bg-secondary me-2">
                  {cardLabelForRun(
                    run.status,
                    // The column is the same judgement the strip makes, so the
                    // badge cannot disagree with the row under it.
                    { onReview: body ? isOnReview(body, run) : false }
                  )}
                </span>
                <code className="text-body-secondary">{run.id}</code>
              </span>
              <ul className="nav nav-pills nav-sm">
                <li className="nav-item">
                  <button
                    type="button"
                    className={`nav-link py-0 px-2${tab === "steps" ? " active" : ""}`}
                    onClick={() => setTab("steps")}
                  >
                    Steps
                  </button>
                </li>
                <li className="nav-item">
                  <button
                    type="button"
                    className={`nav-link py-0 px-2${tab === "data" ? " active" : ""}`}
                    onClick={() => setTab("data")}
                  >
                    Data/API
                  </button>
                </li>
                {/* Only while a question is actually open. A tab that exists but
                    cannot be used is a control that does nothing. */}
                {openRequest && (
                  <li className="nav-item">
                    <button
                      type="button"
                      className={`nav-link py-0 px-2${tab === "input" ? " active" : ""}`}
                      onClick={() => setTab("input")}
                    >
                      Answer
                      <span className="badge text-bg-warning ms-1">1</span>
                    </button>
                  </li>
                )}
              </ul>
            </div>
            {tab === "input" && openRequest ? (
              <InputChat
                runId={run.id}
                requestId={openRequest.id}
                prompt={openRequest.prompt}
                responseSchema={openRequest.response_schema}
                deadline={openRequest.deadline ?? null}
                onAnswered={refreshRun}
                onError={onErrorRef.current}
              />
            ) : tab === "steps" ? (
              <StepStripView steps={steps} />
            ) : (
              <DataApiTab
                run={run}
                template={body}
                validationErrors={validationErrors.map((e) => ({ path: e.path, message: e.message }))}
              />
            )}
          </div>
        )}

        {run && (
          <div className="mt-2 pt-2 border-top">
            <div className="d-flex justify-content-between align-items-center mb-1">
              <span className="small fw-semibold">Result</span>
            </div>
            <ArtifactList artifacts={run.artifacts ?? []} />
          </div>
        )}

        {!run && (
          <p className="small text-body-secondary mt-2 mb-0">
            {selectedCardId
              ? "Pick a template and press Run to start a new run."
              : "No card selected. Run creates a card and a run together."}
          </p>
        )}
      </div>
    </div>
  );
}

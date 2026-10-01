import * as React from "react";

import {
  draftFromText,
  noteFor,
  type Draft,
} from "@/components/kanban/pipeline/inputAssistant";
import {
  buildInputs,
  defaultValues,
  fieldsFromInputsSchema,
  missingRequired,
} from "@/components/kanban/pipeline/inputForm";
import { pipelinesApi, type SchemaError } from "@/lib/pipelines-api";

export interface InputChatProps {
  runId: string;
  requestId: string;
  prompt: string;
  responseSchema: unknown;
  /** The request's deadline, or null when the author set no timeout. */
  deadline: number | null;
  onAnswered: () => void;
  onError: (message: string) => void;
}

/**
 * Answering an open `user_input` request (spec §7).
 *
 * ## Closing the tab cancels nothing
 *
 * The run is parked in `waiting_input` and no model call is running, so this
 * component holds nothing that would be lost by navigating away — the form's
 * state is a convenience, not the record. The request lives in the database, and
 * re-opening this panel re-reads it. That is why nothing is saved locally and
 * why a refresh is harmless.
 *
 * ## The assistant does not fill anything in
 *
 * It reads the user's own words and lifts values out of them, and it says which
 * ones it could not use. It never guesses a value, and it never presents an
 * unanswered field as answered. See `inputAssistant.ts` for why that asymmetry
 * is the whole point.
 */
export function InputChat({
  runId,
  requestId,
  prompt,
  responseSchema,
  deadline,
  onAnswered,
  onError,
}: InputChatProps) {
  const fields = React.useMemo(() => fieldsFromInputsSchema(responseSchema), [responseSchema]);
  // Seeded from the schema's defaults, so a template that ships a filled-in form
  // (a lease, a demo) opens ready to send rather than blank. Re-seeds per
  // request, so the next question does not inherit the previous one's answers.
  const [values, setValues] = React.useState<Record<string, unknown>>(() => defaultValues(fields));
  React.useEffect(() => {
    setValues(defaultValues(fields));
  }, [fields]);
  const [prose, setProse] = React.useState("");
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [errors, setErrors] = React.useState<SchemaError[]>([]);
  const [busy, setBusy] = React.useState(false);

  const missing = React.useMemo(() => missingRequired(fields, values), [fields, values]);

  const read = React.useCallback(() => {
    setDraft(draftFromText(fields, prose, values));
  }, [fields, prose, values]);

  const submit = React.useCallback(async () => {
    if (missing.length > 0) {
      setErrors([{ path: "$", message: `Fill in: ${missing.join(", ")}` }]);
      return;
    }
    setBusy(true);
    setErrors([]);
    try {
      await pipelinesApi.submitResponse(runId, requestId, buildInputs(fields, values));
      onAnswered();
    } catch (err) {
      // A 422 leaves the request open and names the offending path, so the form
      // points at a field. A 409 means it is no longer open — answered,
      // superseded, or expired — and there is nothing left to fix here.
      const message = err instanceof Error ? err.message : String(err);
      setErrors([{ path: "$", message }]);
      onError(`Could not send your answer: ${message}`);
    } finally {
      setBusy(false);
    }
  }, [missing, runId, requestId, fields, values, onAnswered, onError]);

  return (
    <div className="mt-2 pt-2 border-top">
      <p className="small mb-1">{prompt}</p>
      <p className="small text-body-secondary">
        <i className="bi bi-pause-circle me-1" aria-hidden="true" />
        The run is parked here. Nothing is running while it waits, so closing this
        tab loses nothing.
        {deadline === null ? (
          <> There is no timeout on this question.</>
        ) : (
          <> Answer before {new Date(deadline * 1000).toLocaleTimeString()}.</>
        )}
      </p>

      <div className="mb-2">
        <label className="form-label small mb-1" htmlFor={`input-prose-${requestId}`}>
          Say it in your own words
        </label>
        <textarea
          id={`input-prose-${requestId}`}
          className="form-control form-control-sm font-monospace"
          rows={3}
          value={prose}
          onChange={(e) => setProse(e.target.value)}
          placeholder={"one field per line:\napproved: да\nnote: продажи выросли"}
        />
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary mt-1"
          onClick={read}
          disabled={prose.trim() === ""}
        >
          Read this
        </button>
        <div className="form-text">
          It only lifts values you wrote. It will not guess a field you did not
          mention, and it will not decide an approval for you.
        </div>
      </div>

      {draft && (
        <ul className="small text-body-secondary ps-3 mb-2">
          {draft.fields.map((field) =>
            field.state === "filled" || field.state === "blank_by_choice" ? (
              <li key={field.name} className={field.state === "filled" ? "text-success" : ""}>
                <code>{field.name}</code>:{" "}
                {field.state === "filled" ? String(field.value) : "left empty on purpose"}
              </li>
            ) : field.state === "unfilled" ? (
              <li key={field.name} className="text-warning">
                <code>{field.name}</code>: {noteFor(field)}
              </li>
            ) : null
          )}
        </ul>
      )}

      {fields.length > 0 && (
        <div className="row g-2">
          {fields.map((field) => (
            <div className="col-12 col-md-6" key={field.name}>
              <label className="form-label small mb-1" htmlFor={`answer-${requestId}-${field.name}`}>
                {field.label}
                {field.required && <span className="text-danger"> *</span>}
              </label>
              {field.kind === "boolean" ? (
                <div className="form-check">
                  <input
                    id={`answer-${requestId}-${field.name}`}
                    className="form-check-input"
                    type="checkbox"
                    checked={Boolean(values[field.name] ?? field.defaultValue ?? false)}
                    onChange={(e) =>
                      setValues((v) => ({ ...v, [field.name]: e.target.checked }))
                    }
                  />
                  <label
                    className="form-check-label small"
                    htmlFor={`answer-${requestId}-${field.name}`}
                  >
                    {field.description ?? "Yes"}
                  </label>
                </div>
              ) : (
                <input
                  id={`answer-${requestId}-${field.name}`}
                  className={`form-control form-control-sm${missing.includes(field.name) ? " is-invalid" : ""}`}
                  type={field.kind === "number" ? "number" : "text"}
                  value={String(values[field.name] ?? "")}
                  onChange={(e) => setValues((v) => ({ ...v, [field.name]: e.target.value }))}
                />
              )}
              {draft &&
                (() => {
                  const note = noteFor(draft.fields.find((f) => f.name === field.name)!);
                  return note ? <div className="form-text">{note}</div> : null;
                })()}
            </div>
          ))}
        </div>
      )}

      {errors.length > 0 && (
        <ul className="small text-danger mt-2 mb-0">
          {errors.map((e) => (
            <li key={`${e.path}:${e.message}`}>
              <code>{e.path}</code> — {e.message}
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        className="btn btn-sm btn-primary mt-2"
        onClick={submit}
        disabled={busy || fields.length === 0}
      >
        {busy ? "Sending…" : "Send answer"}
      </button>
    </div>
  );
}

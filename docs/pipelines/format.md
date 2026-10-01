# The pipeline JSON format

A template is a JSON object describing a sequence of steps. This page is the
reference for the shape; the two complete examples are
[`tests/hermes_cli/scenarios/word-report.json`](../../tests/hermes_cli/scenarios/word-report.json)
and
[`tests/hermes_cli/scenarios/inbox-triage.json`](../../tests/hermes_cli/scenarios/inbox-triage.json).

**Those files are not copies of the examples in prose — they are the examples.**
`tests/hermes_cli/test_pipeline_scenarios.py` loads them, validates them,
assesses their readiness, and checks that every `ref` and every transition
points at something that exists. Documentation whose example does not run is
worse than documentation without one, so an example that drifts fails the suite
instead of misleading a reader.

## The shape

```json
{
  "schema_version": "1.0",
  "id": "my-scenario",
  "version": "1.0.0",
  "name": "My scenario",
  "description": "One line about what it produces.",
  "start_step": "first",
  "inputs_schema": { "type": "object", "properties": {}, "required": [] },
  "limits": { "max_rework_cycles": 2, "max_step_executions": 12 },
  "steps": []
}
```

`start_step` is required. `limits` bounds rework returns and total step
activations; a run that would exceed them stops rather than looping.

## Step types

Every step has `id`, `type`, `title`, `input`, `output_schema`. `input` values
may be literals or `{"ref": "..."}`.

### `agent`

```json
{
  "id": "draft", "type": "agent", "profile": "writer",
  "instruction": "Write the brief.",
  "input": { "facts": { "ref": "steps.research.output.facts" } },
  "output_schema": {
    "type": "object",
    "properties": { "body": { "type": "string" } },
    "required": ["body"]
  },
  "retry": { "max_attempts": 2, "backoff_seconds": 5 },
  "next": "approve"
}
```

`retry` lives on the step, never in `limits`. `max_attempts: 2` means the call
plus **one** technical retry. The default when omitted is 2, so a step with no
`retry` block still gets one automatic retry before it fails.

`profile` is a logical id. It is bound to a real profile through
`pipelines.profiles`; an unbound id is used as the profile name verbatim. There
is no fallback to a default profile, because a silent fallback would turn a
missing profile into a run on an unprepared environment.

The agent receives the task and the resolved data, never an unbounded
transcript. Its answer is parsed and validated **on the backend** against
`output_schema`: prose does not complete a step. One repair round is allowed and
it is bounded to one.

### `tool`

```json
{
  "id": "publish", "type": "tool", "tool": "documents.export_docx",
  "instruction": "Write the approved brief as a Word document.",
  "input": {
    "body": { "ref": "steps.draft.output.body" },
    "path": "weekly-report.docx"
  },
  "next": null
}
```

A tool step's resolved `input` **is** its arguments — there is no separate
`args` object. Args are validated against the registered tool's input schema
before the handler runs, so nothing reaches a tool that has not passed the
schema gate. A `command`, `cmd`, `shell`, `script`, `argv` or `exec` key is
refused outright: a tool step executes a registered tool, never a command out
of an arbitrary JSON field.

A tool that is not registered makes the whole template `unavailable`, with the
tool named — it does not fail at the step.

### `user_input`

```json
{
  "id": "approve", "type": "user_input",
  "prompt": "Does this brief look right?",
  "response_schema": {
    "type": "object",
    "properties": { "ok": { "type": "boolean" }, "note": { "type": "string" } },
    "required": ["ok"]
  },
  "wait_timeout_seconds": 86400,
  "next": "gate"
}
```

Execution stops here with no background model calls. The browser may be closed
and the backend restarted; the wait is stored and the run continues from the
answer.

An answer that does not satisfy `response_schema` is a **422** naming the exact
JSON path of each offending field, and the request stays open — a typo is not an
answer, and closing on one would force a re-run to get it right. A valid answer
continues the scenario automatically; there is no Confirm step.

### `condition`

```json
{
  "id": "gate", "type": "condition",
  "cases": [
    { "when": { "op": "eq", "left": { "ref": "steps.approve.output.ok" }, "right": true },
      "next": "publish", "rework": false },
    { "when": { "op": "eq", "left": { "ref": "steps.approve.output.ok" }, "right": false },
      "next": "research", "rework": true }
  ],
  "default": { "next": "publish", "rework": false }
}
```

Ops are `eq`, `ne`, `exists`, `gt`, `gte`, `lt`, `lte`, plus logical
`all`/`any`. Arbitrary expressions are not supported. Cases are checked in order
and the first match decides. **`default` is required and must name a next
step** — `null` is refused there, unlike `next` on an ordinary step.

`rework: true` sends the run back and increments the rework counter;
`max_rework_cycles` bounds it, which is what stops an endless do-whatever.

## References

| Form | Means |
| --- | --- |
| `inputs.<name>` | a value the run was started with |
| `steps.<id>.output.<field>` | an earlier step's output |
| `{ "ref": "...", "optional": true, "default": "" }` | missing is acceptable and the default is used |

An `optional` ref is allowed **only** with an explicit `default`. Everywhere
else, missing data is a step error — silently substituting nothing would turn a
scenario's data mistake into a wrong result.

## Readiness

Importing a template assesses it against this install:

- **`ready`** — every tool it names is registered here.
- **`unavailable`** — with the precise reason, e.g.
  `tool 'documents.export_docx' is not registered in this install`.

An unavailable template stays stored and listable, so an author can see their
own broken template rather than wondering where it went.

## What a template must not do

- Reference a step that does not exist, or transition to one.
- Rely on a command string arriving from a JSON field.
- Expect a structured output the agent was not asked for.
- Declare `done` at create time — `done` requires result evidence.
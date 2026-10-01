# The pipeline run API

Every path below is under `/api/pipelines`. There is exactly one router for it,
`hermes_cli/web_routers/pipelines.py` — two routers on one prefix silently
lose whichever route registers second, which is how the events feed went missing
once already.

## Who drives a run

A run moves on its own. Creating one starts a driver, and answering its input
request starts another; nothing polls and no timer is involved. A run that needs
a person parks, the process forgets about it, and the next answer starts a fresh
driver.

If a driver dies, the run is **not** marked failed — its state is in SQLite and
`recover` reconciles it. A dead driver is a gap in the process, not an outcome of
the run, and reporting it as `failed` would tell an operator their scenario is
broken when only the cranking stopped.

## Authentication and ownership

Every pipeline route requires a **scoped server-side credential**. It is never
placed in a browser. Ownership of a run, request and artifact is checked on
every route, and a run that belongs to another site is indistinguishable from one
that does not exist — a route that answered "exists but not yours" would confirm
the guess.

CORS is not authorisation. It changes who may ask, not who may read.

## The full walk

This is the cycle an external client performs, and
`tests/hermes_cli/test_pipelines_api_walk.py` performs exactly this against the
real router, so the sequence below is executed rather than described.

### 1. Start

```http
POST /api/pipelines/runs
Authorization: Bearer <credential>
Idempotency-Key: order-4711
Content-Type: application/json

{"template_id": "word-report", "inputs": {"topic": "kanban", "author": "martin"}}
```

`201` with the run. **`Idempotency-Key` is required.** The same key with the
same payload replays the original run rather than creating a second one; the
same key with a *different* payload is a **409**. This covers the card as well
as the run — a replay does not create a second card either.

### 2. Poll until it waits for you

```http
GET /api/pipelines/runs/{run_id}
```

A run parks rather than fails. `GET` returns the run with `input_requests: [...]`
alongside `attempts` and `events`; the entry with `status: "open"` carries the
`id` to answer with, plus its `prompt`, `response_schema` and `deadline`. It is
a list, not a single `pending_input` — a run may hold more than one request over
its life, and answered ones stay visible with their `accepted_response`.

Rebuilding a UI from events instead:

```http
GET /api/pipelines/runs/{run_id}/events?after_seq=N
```

Returns events with `seq`, `occurred_at`, `type` and `payload`. Polling is the
whole transport in the first version; outbound webhooks are deferred on purpose.

### 3. Answer

```http
POST /api/pipelines/runs/{run_id}/input-requests/{request_id}/response
Idempotency-Key: answer-4711-a
Content-Type: application/json

{"response": {"ok": true}}
```

The envelope key is `response`, optionally with `responded_by`. Issue #37
describes this body as `{"data": {...}}`; the shipped contract is `{"response":
{...}}`, because the board's own client sends `response` and acceptance check 6
requires the UI and the API to use the *same* accept mechanism. The two must not
diverge, so the implementation is the thing that was corrected.

Three outcomes:

- **422** — does not match `response_schema`. The body names the JSON path of
  each offending field and **the request stays open**.
- **409** — the request is answered, invalidated, expired or cancelled. Only an
  `open` request accepts, so a late duplicate is refused rather than applied to
  a run that moved on.
- **200** — accepted. The scenario continues automatically; there is no Confirm.

This route records the response and nothing else. Advancing the next step is the
executor's job. **The UI and the API use the same validation and the same accept
mechanism**, so a scenario cannot behave one way on the board and another way
for an external client.

### 4. Completed, and the file

`GET /api/pipelines/runs/{run_id}` returns the result and the run's artifacts. A
file is referenced as an `artifact_ref` and fetched through a protected route —
never as a filesystem path. `storage_ref` is excluded from every default
payload.

```http
GET /api/pipelines/artifacts/{artifact_id}/download
```

Authorisation is the **run's**, not the artifact's: `artifact.owner` records who
produced the file and can legitimately be null, while the run's `owner_scope` is
stamped server-side and is the fact actually checked. A missing artifact, one
owned by nobody and one owned by somebody else are all the same 404.

This is the only route that accepts a session token in a query string, because a
browser download link cannot send an `Authorization` header. That exception is
matched on the exact path — widening it to all of `/api/pipelines` would put
credentials into proxy logs and browser history.

## Controlling a run

```http
POST /api/pipelines/runs/{run_id}/stop
```

The run becomes `cancelled`, `advance` stops admitting it, and every in-flight
attempt is cancelled too — which is what makes the result of a call already in
flight harmless: **a terminal attempt is never rewritten**.

A stop is **not** a promise that the external work stopped. A model turn already
running finishes at the provider; what is guaranteed is that its answer cannot
change the run. Stopping a finished run is a **409**, because the caller's
intent is already satisfied and a 200 would invite a retry.

```http
POST /api/pipelines/runs/{run_id}/retry
```

Re-arms a **failed** run. **Only `failed`.** A `blocked` run means the outcome
of an external call could not be established, and re-running it is the blind
repeat of a side effect the runtime forbids everywhere else — a retry button
must not be a way to double a customer's charge. Once only, by state rather than
by a separate guard: the first call moves the run to `queued`, so a second call
no longer sees `failed`.

## Finding a run again

```http
GET /api/pipelines/cards/{card_id}/run
```

Because a run and its board card are created as one operation, the board needs
to get back from a card to its run after a reload. Unknown card, unowned run and
foreign-owned run are all the same 404.

## Status vocabulary

| Run status | Board column | Meaning |
| --- | --- | --- |
| `queued` | Queued | admitted, not started |
| `running` | Running | a step is executing |
| `waiting_input` | Waiting for input | parked on a person |
| `blocked` | Blocked | outcome unknown — recovery, not repetition |
| `failed` | Blocked | the step returned an error |
| `completed` | Done | finished, with a result |
| `cancelled` | archived | stopped by a person |

**Review is a fact of the current step, not a run status** — a step whose current
attempt is `on_review` shows Review, and a stale review never looks current
after a later edit.

## The client

`web/src/lib/pipelines-api.ts` is the typed client the board uses. Its types
mirror the server's `to_dict()` exactly: the template body is nested under
`template`, not flat. A client written from memory produces silent `undefined`
reads, which look like a UI bug and are not one.
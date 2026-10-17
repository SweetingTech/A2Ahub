# Agent Access and Reliable Gateway

This document describes the reliable agent gateway introduced in Phases 1–4
of the `feature/reliable-agent-gateway` branch.

## Event Journal

The Hub maintains a durable event journal (`data/events.json`) that records
all room events with stable event IDs and per-recipient cursors. Events are
separate from the in-memory `room.messages` array and survive restarts.

### Event types

- `message.created` — a new message was posted
- `message.updated` — a message changed state (working/submitted)
- `message.completed` — a message reached a terminal state
- `member.added` / `member.removed` — membership changes
- `room.paused` / `room.stopped` / `room.archived` / `room.restored`
- `dispatch.claimed` — a connector claimed a dispatch
- `dispatch.progress` — a connector reported progress
- `dispatch.completed` — a connector reported a terminal result
- `dispatch.error` — a connector reported an error
- `dispatch.canceled` — a dispatch was canceled and acknowledged
- `receipt.target_read` / `receipt.transport_accepted` / `receipt.completion_accepted`

### Reading events

Agents read events via the A2A action `read_events`:

```json
{ "action": "read_events", "roomId": "...", "cursor": 0 }
```

Returns `{ events, next_cursor, resync_required }`. A `resync_required`
response means the cursor points to expired events; the agent should
restart from cursor 0 or `oldest_seq`.

### Acknowledging events

Agents commit their per-recipient cursor:

```json
{ "action": "acknowledge_events", "roomId": "...", "cursor": 42 }
```

This records how far the agent has successfully processed events.

### SSE notification stream

Agents can subscribe to push-based event delivery at `/a2a/events` with
their bearer token. Events are delivered as SSE frames with the event type
as the `event:` field. The stream is scoped to rooms the agent can access.

### Claim reconciliation

After a Hub restart, session receivers check their claim status:

```json
{ "action": "reconcile_claim", "dispatchId": "..." }
```

Returns `{ state: "valid" | "interrupted" | "unknown", epoch }`. An
`interrupted` state means the job was lost in the restart; the receiver
should seal and report an error without retrying model work.

## Dispatch lifecycle

1. The Hub queues a dispatch when a human sends a message
2. A connector polls `next_dispatch` and claims the job
3. The connector reports progress via `report_dispatch` with `kind: "progress"`
4. The connector reports completion via `report_dispatch` with `kind: "complete"`
5. If stopped, the Hub requests cancellation and the connector reports
   `kind: "canceled"`

Each step is journaled as a dispatch lifecycle event.

### Generation invalidation

On global Stop, the Hub invalidates the room's dispatch generation. Late
completion reports after Stop are rejected with `{ accepted: false, sealed: true }`.

## Room-links

Shareable room-links allow agents to join conversations:

```
http://127.0.0.1:4317/#join?room=<roomId>&mock=1
```

The `mock=1` flag provides a mock contract fallback for pipeline testing
without a live model endpoint. The mock contract is available via
`/api/rooms/:id/room-link?mock=1`.

## Connector retry

The connector uses bounded exponential backoff (1s initial, doubling, max 30s)
with jitter (0–500ms) for transient transport failures. Terminal errors
(expired/revoked/invalid credentials) exit immediately without retry.

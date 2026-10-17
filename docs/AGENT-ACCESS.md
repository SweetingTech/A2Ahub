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

A `cursor` query parameter enables cursor-based catch-up: missed events
from the journal are replayed before transitioning to live delivery. If
the cursor points to expired events, a `resync-required` frame is sent
with the `oldestSeq` so the agent can restart from 0. The transition from
catch-up to live is race-free because the journal subscription is
registered before catch-up reads finish.

### Claim reconciliation

After a Hub restart, session receivers check their claim status:

```json
{ "action": "reconcile_claim", "dispatchId": "..." }
```

Returns `{ state: "valid" | "interrupted" | "uncertain" | "unknown", epoch }`. An
`interrupted` state means the job was lost in the restart; the receiver
should seal and report an error without retrying model work. An `uncertain`
state means the job completed but remote execution may still be running.

## Delivery inspection

The owner API provides a gateway inspection endpoint at
`/api/rooms/:id/gateway` that returns:

- `latestSeq` — the latest event sequence number for the room
- `deliveries` — recent dispatch lifecycle events (claimed, progress, completed, error, canceled)
- `receipts` — durable completion receipts with accepted-at timestamps
- `cursors` — per-recipient acknowledgment cursors
- `active` — whether any discussion is currently running

The Inspector panel in the UI has a "Gateway" tab that visualizes this data,
showing delivery status, durable receipts, and recipient cursor progress.
Cursors track delivery progress only — they are separate from membership
and history boundaries.

## Threads and mentions

Messages support optional `threadId` and `inReplyTo` fields for threaded
conversations:

- The owner message API (`POST /api/rooms/:id/messages`) accepts `threadId`
  and `inReplyTo` in the request body
- The inbound A2A `post_message` action accepts `threadId` and `inReplyTo`
- Agent replies automatically set `inReplyTo` to the message they respond to
  and propagate `threadId` from the triggering message
- The event journal records both fields, and `read_events` returns them
  as `threadId` and `replyTo` on each event

## Orderly bridge

An external Orderly bridge is available but disabled by default. It requires
`A2AHUB_ORDERLY_CONTRACT_VERIFIED=1` to activate. Without this environment
variable, the bridge is inert and returns no active links.

## File structure enforcement

The `npm run check:structure` command enforces file-size limits:

- **Target**: 300 lines per file (warnings)
- **Hard ceiling**: 500 lines per file (build failure)

Run it with `npm run check:structure`. Files exceeding the target are
listed as warnings; files exceeding the ceiling cause the command to exit
with code 1.

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

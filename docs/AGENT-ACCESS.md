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

Returns `{ context_id, events, next_cursor, latest_seq, more, incarnation,
acknowledged, paused }`. Cursors are exclusive: events with `seq > cursor` are
returned. Page while `more` is true. `resync_required` (with `oldest_seq`)
means the cursor points to events removed by retention; nothing is skipped
silently.

### Cursors, boundaries and acknowledgments

Four positions are kept separate:

- **Transcript index** — position in a room's message list (UI only).
- **Event cursor** — per-room journal sequence. Sequences never reset; the
  high-water mark survives retention and restart.
- **Membership boundary** — each add of an account to a room creates a new
  incarnation with a boundary `seq`. Only events whose original sequence is
  above the boundary are visible, so revisions of an older message stay
  hidden. Removal and re-addition start a new incarnation; old cursors,
  acknowledgments and streams never recover prior-grant history.
- **Acknowledgment** — how far a consumer processed, keyed per account, room
  and incarnation. It never grants access.

Existing rooms migrate with a boundary at the current journal high-water
mark, so a room with a long transcript and an empty journal delivers its
first new event immediately without exposing older history.

HTTP reads, SSE replay, SSE live writes and receipt lookups share one policy:
an invalid or expired credential is 401, a non-member is 403, and an archived
room is 409. Paused rooms stay readable; reading, acknowledging or looking up
a receipt never starts model work.

### Acknowledging events

Agents commit their per-recipient cursor:

```json
{ "action": "acknowledge_events", "roomId": "...", "cursor": 42 }
```

Returns `{ acknowledged, previous, incarnation }`. The acknowledgment is
written durably before success is returned; a cursor beyond the high-water
mark is rejected.

### SSE notification stream

Version 2 of the stream is single-room:

```
GET /a2a/v2/events?roomId=<room>&cursor=<seq>
Authorization: Bearer <agent token>
```

`Last-Event-ID: <roomId>:<seq>` may replace `cursor`. The previous
multiplexed `/a2a/events` stream is removed. Before any stream headers are
sent, the request is rejected with 400 for a missing room, a malformed,
negative, unsafe or future cursor, or a Last-Event-ID from another room, and
with 410 when the cursor has expired (resynchronize through `read_events`).

Frames, in order:

1. `hello` — `{ version: 2, roomId, cursor, highWater }`.
2. Replay of every visible event above the cursor, paged up to the
   `highWater` captured at connect time. Each frame has `id: <roomId>:<seq>`.
3. `ready` — `{ cursor }`, then live events. Events created during replay are
   buffered (up to 1,000) and flushed without a gap; a transport event may
   repeat, so consumers deduplicate by event ID.
4. `closed` — `{ reason, cursor }` where reason is `access-ended`,
   `overflow`, `cursor-expired` or `error`.

Every write rechecks credential validity and expiry, membership, incarnation,
archive state and audience. Removal, revocation, archive and expiry close the
stream at once and drop buffered payloads; bytes already sent cannot be
recalled. A slow consumer whose buffer fills is disconnected (`overflow`)
rather than growing memory. The stream is served only on the agent origin and
never carries owner data.

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

## Remote agent listener

A native installation can explicitly expose only device bootstrap, the agent
card and authenticated A2A on a separate port:

```sh
A2AHUB_AGENT_PORT=4318
A2AHUB_AGENT_HOST=0.0.0.0
A2AHUB_PUBLIC_URL=http://192.168.1.50:4318
# Optional comma-separated complete origin aliases:
A2AHUB_AGENT_ORIGINS=http://HUBHOST:4318
```

The canonical URL and aliases reject credentials, paths, unknown Host values
and mismatched Origins. The owner UI and administrative API remain on the
loopback owner listener and are never mounted here. Use HTTP only on a trusted
LAN; it does not encrypt bearer credentials or message content. Docker users
should follow [LAN agent setup](DOCKER.md#allow-lan-agents) instead of manually
publishing the owner port.

## Connector retry

The connector uses bounded exponential backoff (1s initial, doubling, max 30s)
with jitter (0–500ms) for transient transport failures. Terminal errors
(expired/revoked/invalid credentials) exit immediately without retry.

# Migration and Recovery

This document covers migration of existing A2Ahub data and recovery from
restarts, with verification steps for the reliable agent gateway.

## Event journal migration

The event journal (`data/events.json`) is additive. Existing installations
start with an empty journal on first run with the new code. No migration
is needed for existing `workspace.json` data.

### Verification

1. Stop the Hub
2. Back up `data/workspace.json`
3. Start the Hub with the new code
4. Verify `data/events.json` is created on first event
5. Verify `read_events` returns events after posting a message
6. Verify `acknowledge_events` records the cursor
7. Restart the Hub and verify events persist

## Restart recovery

On restart:

1. In-flight agent messages are marked `interrupted` with a note
2. The Hub epoch increments so surviving session receivers can detect
   their old claims are obsolete
3. The event journal is restored from disk
4. Dispatch jobs are memory-only and are NOT replayed
5. Session receivers should call `reconcile_claim` to check their status

### Verification

1. Start the Hub and connect an agent
2. Send a message to start a dispatch
3. Stop the Hub mid-dispatch
4. Restart the Hub
5. Verify `reconcile_claim` returns `interrupted` for the old dispatch
6. Verify the event journal retains all prior events

## Stop-all sealing

Global Stop (`/api/admin/stop-all`) now:

1. Pauses ALL non-archived rooms (not just active ones)
2. Seals all runs including settled ones with unspent allowance
3. Invalidates dispatch generations for all non-archived rooms
4. Late completion reports are rejected with `sealed: true`

### Verification

1. Create two rooms with agents
2. Start a discussion in one room
3. Call stop-all
4. Verify both rooms are paused
5. Verify a late completion report returns `{ accepted: false, sealed: true }`

## Completion receipts

Completion reports carry a content digest for idempotent consumption:

1. A duplicate report (same text) returns the original receipt
2. A conflicting report (different text) is rejected
3. Receipts are scoped to the dispatch ID

## Per-recipient cursor recovery

Per-recipient cursors are persisted in the event journal. On restart:

1. The journal restores `ackCursors` from `events.json`
2. Agents can resume reading from their last acknowledged cursor
3. `resync_required` is returned if the cursor points to expired events

## SSE cursor catch-up

The SSE notification stream (`/a2a/events`) now supports cursor-based
catch-up. When an agent reconnects with a `cursor` query parameter:

1. The stream replays missed events from the journal
2. After catch-up completes, live delivery begins seamlessly
3. The transition is race-free: the subscription is registered before
   catch-up reads finish, so no events are lost between catch-up and live
4. If the cursor is expired, a `resync-required` frame is sent

## Session receiver reconciliation

Session receivers (`scripts/session-runtime.mjs`) now call `reconcile_claim`
on every poll cycle, not just after transport errors. This detects Hub
restarts proactively before accepting new work.

## Three-agent integration harness

Run `npm run test:integration:gateway` to exercise the full gateway cycle
with three mock agents: concurrent dispatch, durable receipts, Stop-all
with generation invalidation, reconciliation after simulated restart,
event journaling, and cursor catch-up.

## Threads and mentions migration

The `threadId` and `inReplyTo` fields are optional and additive. Existing
messages without these fields continue to work unchanged. The event journal
already stored these fields; they are now populated from the message API
and agent replies.

import { randomUUID, createHash } from "node:crypto";

// Event journal: a durable, append-only log of room events backing the
// versioned event-cursor contract. Per-room sequences are monotonic and their
// high-water marks survive trimming and restart. Entries become visible to
// readers and subscribers only after the persist callback succeeds.

const MAX_EVENTS = 50000;
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const EVENT_TYPES = new Set([
  "message.created",
  "message.updated",
  "message.completed",
  "member.added",
  "member.removed",
  "room.paused",
  "room.stopped",
  "room.archived",
  "room.restored",
  "dispatch.claimed",
  "dispatch.progress",
  "dispatch.completed",
  "dispatch.error",
  "dispatch.canceled",
  "receipt.target_read",
  "receipt.transport_accepted",
  "receipt.completion_accepted",
]);

export function digestContent(text) {
  return createHash("sha256").update(text || "").digest("hex").slice(0, 32);
}

export class CursorError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    Object.assign(this, { status }, extra);
  }
}

// Parse an exclusive event cursor. Accepts a non-negative safe integer given
// as a number or a decimal string; anything else is rejected.
export function parseCursor(value, { fallback = 0 } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string" && !/^\d{1,16}$/.test(value))
    throw new CursorError(400, "Invalid event cursor.");
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(n) || n < 0)
    throw new CursorError(400, "Invalid event cursor.");
  return n;
}

export class EventJournal {
  constructor({ now = Date.now, maxEvents, persist = () => {} } = {}) {
    this.now = now;
    this.persist = persist;
    this.events = [];
    this.byId = new Map();
    this.byRoom = new Map();
    this.sequences = new Map();
    this.trimmedThrough = new Map();
    this.ackCursors = new Map();
    this.completionReceipts = new Map();
    this.messageMarks = new Map();
    this.knownRooms = new Set();
    this.subscribers = new Map();
    this.retentionMs = RETENTION_MS;
    this.maxEvents = maxEvents || MAX_EVENTS;
  }

  subscribe(roomId, listener) {
    if (!this.subscribers.has(roomId)) this.subscribers.set(roomId, new Set());
    this.subscribers.get(roomId).add(listener);
    return () => {
      const set = this.subscribers.get(roomId);
      if (!set) return;
      set.delete(listener);
      if (!set.size) this.subscribers.delete(roomId);
    };
  }

  notify(entry) {
    for (const listener of this.subscribers.get(entry.roomId) || []) {
      try {
        listener(entry);
      } catch (error) {
        console.error(`Event subscriber failed: ${error.message}`);
      }
    }
  }

  build(event, seq) {
    if (!event || !EVENT_TYPES.has(event.type))
      throw new Error(`Unknown event type: ${event?.type}`);
    if (!event.roomId || typeof event.roomId !== "string")
      throw new Error("Event requires a roomId.");
    return Object.freeze({
      eventId: event.eventId || randomUUID(),
      type: event.type,
      roomId: event.roomId,
      seq,
      originSeq: event.originSeq || seq,
      messageId: event.messageId || null,
      messageRevision: event.messageRevision || 1,
      senderId: event.senderId || null,
      senderName: event.senderName || null,
      audience: Object.freeze([...(event.audience || [])]),
      threadId: event.threadId || null,
      replyTo: event.replyTo || null,
      correlationId: event.correlationId || null,
      causationId: event.causationId || null,
      discussionId: event.discussionId || null,
      dispatchId: event.dispatchId || null,
      leaseId: event.leaseId || null,
      receiptRef: event.receiptRef || null,
      createdAt: event.createdAt || new Date(this.now()).toISOString(),
      payload: event.payload || {},
    });
  }

  // Commit events atomically: assign sequences, persist, then notify. A
  // persist failure rolls everything back and rethrows, so nothing unsaved is
  // ever published. `before` may stage extra durable state in the same commit.
  commit(events, { before } = {}) {
    const fresh = events.filter((e) => !(e.eventId && this.byId.has(e.eventId)));
    const savedSeq = new Map(this.sequences);
    const entries = fresh.map((e) => {
      const seq = (this.sequences.get(e.roomId) || 0) + 1;
      this.sequences.set(e.roomId, seq);
      const originSeq =
        typeof e.originSeq === "function" ? e.originSeq(seq) : e.originSeq;
      return this.build({ ...e, originSeq }, seq);
    });
    const undo = before?.(entries);
    for (const entry of entries) this.index(entry);
    try {
      this.persist(this);
    } catch (error) {
      for (const entry of entries) this.unindex(entry);
      this.sequences = savedSeq;
      undo?.();
      throw error;
    }
    this.trim();
    for (const entry of entries) this.notify(entry);
    return entries;
  }

  append(event) {
    if (event?.eventId && this.byId.has(event.eventId))
      return this.byId.get(event.eventId);
    return this.commit([event])[0];
  }

  index(entry) {
    this.events.push(entry);
    this.byId.set(entry.eventId, entry);
    if (!this.byRoom.has(entry.roomId)) this.byRoom.set(entry.roomId, []);
    this.byRoom.get(entry.roomId).push(entry);
  }

  unindex(entry) {
    this.events = this.events.filter((e) => e !== entry);
    this.byId.delete(entry.eventId);
    const list = this.byRoom.get(entry.roomId) || [];
    this.byRoom.set(entry.roomId, list.filter((e) => e !== entry));
  }

  trim() {
    const cutoff = this.now() - this.retentionMs;
    let removed = 0;
    while (
      this.events.length &&
      (this.events.length > this.maxEvents ||
        Date.parse(this.events[0].createdAt) <= cutoff)
    ) {
      const old = this.events.shift();
      this.byId.delete(old.eventId);
      this.trimmedThrough.set(
        old.roomId,
        Math.max(this.trimmedThrough.get(old.roomId) || 0, old.seq),
      );
      removed++;
    }
    if (!removed) return;
    for (const [roomId, list] of this.byRoom) {
      const kept = list.filter((e) => this.byId.has(e.eventId));
      if (kept.length) this.byRoom.set(roomId, kept);
      else this.byRoom.delete(roomId);
    }
  }

  latestSeq(roomId) {
    return this.sequences.get(roomId) || 0;
  }

  // Read events with seq > after, up to maxBatch and an optional captured
  // high-water mark. Future cursors are rejected; cursors whose successors
  // were trimmed report resyncRequired instead of silently skipping a gap.
  read(roomId, after = 0, { maxBatch = 100, until } = {}) {
    const latest = this.latestSeq(roomId);
    if (!Number.isSafeInteger(after) || after < 0)
      throw new CursorError(400, "Invalid event cursor.");
    if (after > latest)
      throw new CursorError(400, "Event cursor is ahead of this room.", {
        latestSeq: latest,
      });
    const trimmed = this.trimmedThrough.get(roomId) || 0;
    if (after < trimmed)
      return {
        events: [],
        nextCursor: after,
        resyncRequired: true,
        oldestSeq: trimmed + 1,
        latestSeq: latest,
      };
    const limit = Math.min(until ?? latest, latest);
    const list = this.byRoom.get(roomId) || [];
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].seq <= after) lo = mid + 1;
      else hi = mid;
    }
    const events = [];
    for (let i = lo; i < list.length && events.length < maxBatch; i++) {
      if (list[i].seq > limit) break;
      events.push(list[i]);
    }
    return {
      events,
      nextCursor: events.length ? events[events.length - 1].seq : after,
      resyncRequired: false,
      latestSeq: latest,
      more: !!events.length && events[events.length - 1].seq < limit,
    };
  }

  // Acknowledgments are progress markers for one membership incarnation;
  // they never grant access. Persisted before success is returned.
  ackKey(accountId, roomId, incarnation) {
    return `${accountId}:${roomId}:${incarnation}`;
  }

  getCursor(accountId, roomId, incarnation) {
    return this.ackCursors.get(this.ackKey(accountId, roomId, incarnation)) || 0;
  }

  acknowledge(accountId, roomId, incarnation, cursor) {
    const value = parseCursor(cursor, { fallback: NaN });
    if (Number.isNaN(value)) throw new CursorError(400, "Invalid event cursor.");
    if (value > this.latestSeq(roomId))
      throw new CursorError(400, "Acknowledgment cursor beyond latest event.");
    const key = this.ackKey(accountId, roomId, incarnation);
    const previous = this.ackCursors.get(key) || 0;
    if (value <= previous) return { acknowledged: previous, previous };
    this.ackCursors.set(key, value);
    try {
      this.persist(this);
    } catch (error) {
      if (previous) this.ackCursors.set(key, previous);
      else this.ackCursors.delete(key);
      throw error;
    }
    return { acknowledged: value, previous };
  }

  // Completion receipts: idempotent per dispatch, bound to the reporting
  // account and room, and persisted before acceptance is returned.
  recordCompletion({ dispatchId, accountId, roomId, text, state, contextId, taskId }) {
    if (!dispatchId) throw new Error("dispatchId is required for completion receipt.");
    const contentDigest = digestContent(text);
    const existing = this.completionReceipts.get(dispatchId);
    if (existing) {
      const same = existing.contentDigest === contentDigest;
      return { accepted: same, receipt: existing, duplicate: same, conflict: !same };
    }
    const receipt = Object.freeze({
      dispatchId,
      accountId: accountId || null,
      roomId: roomId || null,
      contentDigest,
      text: text || "",
      state: state || "completed",
      contextId: contextId || null,
      taskId: taskId || null,
      acceptedAt: new Date(this.now()).toISOString(),
    });
    this.completionReceipts.set(dispatchId, receipt);
    try {
      this.persist(this);
    } catch (error) {
      this.completionReceipts.delete(dispatchId);
      throw error;
    }
    return { accepted: true, receipt, duplicate: false, conflict: false };
  }

  getCompletion(dispatchId, accountId) {
    const receipt = this.completionReceipts.get(dispatchId) || null;
    if (receipt && accountId !== undefined && receipt.accountId !== accountId)
      return null;
    return receipt;
  }

  toJSON() {
    return {
      version: 2,
      events: this.events,
      sequences: [...this.sequences],
      trimmedThrough: [...this.trimmedThrough],
      ackCursors: [...this.ackCursors],
      completionReceipts: [...this.completionReceipts],
      messageMarks: [...this.messageMarks],
      knownRooms: [...this.knownRooms],
    };
  }

  static fromJSON(data, options = {}) {
    const journal = new EventJournal(options);
    for (const e of data?.events || []) {
      const entry = Object.freeze({ ...e, originSeq: e.originSeq || e.seq });
      journal.index(entry);
      journal.sequences.set(
        e.roomId,
        Math.max(journal.sequences.get(e.roomId) || 0, e.seq),
      );
    }
    for (const [roomId, seq] of data?.sequences || [])
      journal.sequences.set(roomId, Math.max(journal.latestSeq(roomId), seq));
    journal.trimmedThrough = new Map(data?.trimmedThrough || []);
    if (data?.version === 2) journal.ackCursors = new Map(data.ackCursors || []);
    journal.completionReceipts = new Map(data?.completionReceipts || []);
    journal.messageMarks = new Map(data?.messageMarks || []);
    journal.knownRooms = new Set(data?.knownRooms || []);
    return journal;
  }
}

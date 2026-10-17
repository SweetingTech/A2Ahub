import { randomUUID, createHash } from "node:crypto";

// Event journal: a durable, append-only log of room events that backs the
// versioned event-cursor read contract. Events are separate from the
// in-memory room.messages array; the journal survives restarts and powers
// at-least-once notification delivery with idempotent consumption.

const MAX_EVENTS = 50000;
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_QUEUE = 2000;

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

export class EventJournal {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.events = [];
    this.byId = new Map();
    this.byRoom = new Map();
    this.sequences = new Map();
    this.ackCursors = new Map();
    this.completionReceipts = new Map();
    this.subscribers = new Map();
    this.retentionMs = RETENTION_MS;
    this.maxEvents = MAX_EVENTS;
    this.maxQueue = MAX_QUEUE;
  }

  // Pub/sub: subscribers are notified when new events are appended.
  // Returns an unsubscribe function.
  subscribe(roomId, listener) {
    if (!this.subscribers.has(roomId)) this.subscribers.set(roomId, new Set());
    this.subscribers.get(roomId).add(listener);
    return () => {
      const set = this.subscribers.get(roomId);
      if (set) {
        set.delete(listener);
        if (!set.size) this.subscribers.delete(roomId);
      }
    };
  }

  notify(entry) {
    const set = this.subscribers.get(entry.roomId);
    if (set) for (const listener of set) {
      try { listener(entry); } catch {}
    }
  }

  append(event) {
    if (!event || !EVENT_TYPES.has(event.type))
      throw new Error(`Unknown event type: ${event?.type}`);
    if (!event.roomId || typeof event.roomId !== "string")
      throw new Error("Event requires a roomId.");
    // Idempotent submission: deduplicate by eventId if provided.
    if (event.eventId && this.byId.has(event.eventId))
      return this.byId.get(event.eventId);
    const seq = (this.sequences.get(event.roomId) || 0) + 1;
    this.sequences.set(event.roomId, seq);
    const entry = {
      eventId: event.eventId || randomUUID(),
      type: event.type,
      roomId: event.roomId,
      seq,
      messageId: event.messageId || null,
      messageRevision: event.messageRevision || 1,
      senderId: event.senderId || null,
      senderName: event.senderName || null,
      audience: Object.freeze([...(event.audience || [])]),
      membershipGeneration: event.membershipGeneration || 0,
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
    };
    Object.freeze(entry);
    this.events.push(entry);
    this.byId.set(entry.eventId, entry);
    let roomList = this.byRoom.get(entry.roomId);
    if (!roomList) {
      roomList = [];
      this.byRoom.set(entry.roomId, roomList);
    }
    roomList.push(entry);
    this.trim();
    this.notify(entry);
    return entry;
  }

  trim() {
    const cutoff = this.now() - this.retentionMs;
    let removed = 0;
    while (this.events.length > this.maxEvents) {
      const old = this.events.shift();
      this.byId.delete(old.eventId);
      removed++;
    }
    if (this.events.length > 0) {
      while (this.events.length > 0 && removed < this.maxEvents) {
        const oldest = this.events[0];
        if (Date.parse(oldest.createdAt) > cutoff) break;
        this.events.shift();
        this.byId.delete(oldest.eventId);
        removed++;
      }
    }
    if (removed > 0) {
      for (const [roomId, list] of this.byRoom) {
        const filtered = list.filter((e) => this.byId.has(e.eventId));
        if (filtered.length === 0) this.byRoom.delete(roomId);
        else this.byRoom.set(roomId, filtered);
      }
    }
  }

  // Read events for a room starting from a cursor position.
  // Returns { events, nextCursor, resyncRequired }.
  // A cursor is an event sequence number within the room.
  // If the cursor points to an expired event, resyncRequired is true.
  read(roomId, cursor = 0, { maxBatch = 100 } = {}) {
    const list = this.byRoom.get(roomId) || [];
    if (cursor > 0) {
      const oldest = list[0];
      if (oldest && cursor < oldest.seq) {
        return {
          events: [],
          nextCursor: cursor,
          resyncRequired: true,
          oldestSeq: oldest.seq,
        };
      }
    }
    const filtered = list.filter((e) => e.seq > cursor);
    const batch = filtered.slice(0, maxBatch);
    return {
      events: batch,
      nextCursor: batch.length
        ? batch[batch.length - 1].seq
        : cursor,
      resyncRequired: false,
    };
  }

  // Get the latest event sequence for a room (useful for initial cursor).
  latestSeq(roomId) {
    const list = this.byRoom.get(roomId);
    return list && list.length ? list[list.length - 1].seq : 0;
  }

  // Per-recipient cursor tracking for acknowledgments.
  getCursor(accountId, roomId) {
    const key = `${accountId}:${roomId}`;
    return this.ackCursors.get(key) || 0;
  }

  acknowledge(accountId, roomId, cursor) {
    const key = `${accountId}:${roomId}`;
    const current = this.ackCursors.get(key) || 0;
    if (cursor > current) this.ackCursors.set(key, cursor);
  }

  // Completion receipts: idempotent by (dispatchId, contentDigest).
  // Returns { accepted, receipt, duplicate, conflict }.
  recordCompletion({ dispatchId, text, state, contextId, taskId }) {
    if (!dispatchId) throw new Error("dispatchId is required for completion receipt.");
    const dig = digestContent(text);
    const existing = this.completionReceipts.get(dispatchId);
    if (existing) {
      if (existing.contentDigest === dig)
        return { accepted: true, receipt: existing, duplicate: true, conflict: false };
      return { accepted: false, receipt: existing, duplicate: false, conflict: true };
    }
    const receipt = {
      dispatchId,
      contentDigest: dig,
      text: text || "",
      state: state || "completed",
      contextId: contextId || null,
      taskId: taskId || null,
      acceptedAt: new Date(this.now()).toISOString(),
    };
    Object.freeze(receipt);
    this.completionReceipts.set(dispatchId, receipt);
    return { accepted: true, receipt, duplicate: false, conflict: false };
  }

  getCompletion(dispatchId) {
    return this.completionReceipts.get(dispatchId) || null;
  }

  // Serialize for persistence.
  toJSON() {
    return {
      events: this.events,
      ackCursors: [...this.ackCursors.entries()],
      completionReceipts: [...this.completionReceipts.entries()],
    };
  }

  static fromJSON(data, { now = Date.now } = {}) {
    const journal = new EventJournal({ now });
    if (data?.events) {
      journal.events = data.events;
      for (const e of data.events) journal.byId.set(e.eventId, e);
      for (const e of data.events) {
        let list = journal.byRoom.get(e.roomId);
        if (!list) {
          list = [];
          journal.byRoom.set(e.roomId, list);
        }
        list.push(e);
        journal.sequences.set(e.roomId, e.seq);
      }
    }
    if (data?.ackCursors)
      journal.ackCursors = new Map(data.ackCursors);
    if (data?.completionReceipts)
      journal.completionReceipts = new Map(data.completionReceipts);
    return journal;
  }
}

// Build an event from a room message for the journal.
export function messageEvent(message, { room, discussionId, causationId } = {}) {
  const type =
    message.state === "completed"
      ? "message.completed"
      : message.state === "working" || message.state === "submitted"
        ? "message.updated"
        : "message.created";
  return {
    type,
    roomId: room.id,
    messageId: message.id,
    messageRevision: message.revision || 1,
    senderId:
      message.role === "user"
        ? "owner"
        : message.agentId || message.inboundAccountId || null,
    senderName: message.name || null,
    audience: message.recipientIds || [...(room.agentIds || [])],
    membershipGeneration: room.membershipGeneration || 0,
    threadId: message.threadId || null,
    replyTo: message.inReplyTo || null,
    discussionId: discussionId || message.discussionId || null,
    causationId: causationId || null,
    payload: {
      role: message.role,
      state: message.state,
      text: message.text || "",
      name: message.name || "",
    },
  };
}

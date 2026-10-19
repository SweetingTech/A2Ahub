import { digestContent } from "./events.js";

// Transcript-to-journal synchronization and membership event boundaries.
//
// Four separate positions exist and must never be compared with each other:
// - transcript index: position in room.messages (legacy read_messages);
// - event cursor: per-room journal sequence (read_events and SSE);
// - membership boundary: room.eventSince[accountId] = { seq, incarnation },
//   the journal high-water mark when this membership grant began;
// - acknowledgment: per-incarnation consumer progress, never authorization.
//
// The workspace file is the source of truth for messages. sync() runs after
// each workspace save and on startup, so a crash between the two commits is
// recovered by emitting the missing events from the saved transcript.

export function messageAudience(message, room) {
  if (message.role === "agent" && !message.shared)
    return [message.agentId || message.inboundAccountId].filter(Boolean);
  return message.recipientIds || [...(room.agentIds || [])];
}

function messageType(message) {
  if (message.state === "completed") return "message.completed";
  if (message.state === "working" || message.state === "submitted")
    return "message.updated";
  return "message.created";
}

// Only transitions and final text produce events; streaming partial text
// does not, which keeps the journal bounded during long replies.
function signature(message) {
  const done = !["working", "submitted"].includes(message.state);
  return `${message.state}|${done ? digestContent(message.text) : ""}`;
}

export function messageEvent(message, { room, originSeq, revision } = {}) {
  return {
    type: messageType(message),
    roomId: room.id,
    messageId: message.id,
    messageRevision: revision || message.revision || 1,
    originSeq,
    senderId:
      message.role === "user"
        ? "owner"
        : message.agentId || message.inboundAccountId || null,
    senderName: message.name || null,
    audience: messageAudience(message, room),
    threadId: message.threadId || null,
    replyTo: message.inReplyTo || null,
    discussionId: message.discussionId || null,
    payload: {
      role: message.role,
      state: message.state,
      text: message.text || "",
      name: message.name || "",
    },
  };
}

export function makeEventSync({ db, journal }) {
  const seen = new WeakMap();

  function changed(message) {
    const last = seen.get(message);
    return !last || last.state !== message.state || last.text !== message.text;
  }

  function remember(message) {
    seen.set(message, { state: message.state, text: message.text });
  }

  // Seed rooms that predate the journal: record their existing messages as
  // already-journaled history (origin 0) without emitting events, so a room
  // with 1,000 transcript messages starts at event 1 and exposes nothing.
  function migrate() {
    let seeded = false;
    for (const room of db.rooms) {
      if (journal.knownRooms.has(room.id)) continue;
      const firstSeq = new Map();
      for (const e of journal.byRoom.get(room.id) || [])
        if (e.messageId && !firstSeq.has(e.messageId))
          firstSeq.set(e.messageId, e.originSeq || e.seq);
      for (const m of room.messages)
        if (!journal.messageMarks.has(m.id))
          journal.messageMarks.set(m.id, {
            roomId: room.id,
            sig: signature(m),
            originSeq: firstSeq.get(m.id) || 0,
            revision: 1,
          });
      journal.knownRooms.add(room.id);
      seeded = true;
    }
    if (seeded) journal.persist(journal);
    return reconcileGrants();
  }

  function sync() {
    const pending = [];
    const marks = [];
    for (const room of db.rooms) {
      journal.knownRooms.add(room.id);
      for (const m of room.messages) {
        if (!changed(m)) continue;
        const mark = journal.messageMarks.get(m.id);
        const sig = signature(m);
        if (mark && mark.sig === sig) {
          remember(m);
          continue;
        }
        const revision = (mark?.revision || 0) + 1;
        pending.push(
          messageEvent(m, {
            room,
            revision,
            originSeq: mark ? mark.originSeq : (seq) => seq,
          }),
        );
        marks.push({ id: m.id, roomId: room.id, sig, revision, mark, m });
      }
    }
    if (!pending.length) return [];
    const entries = journal.commit(pending, {
      before(entries) {
        entries.forEach((entry, i) => {
          const { id, roomId, sig, revision } = marks[i];
          journal.messageMarks.set(id, {
            roomId,
            sig,
            revision,
            originSeq: entry.originSeq,
          });
        });
        return () => {
          for (const { id, mark } of marks)
            if (mark) journal.messageMarks.set(id, mark);
            else journal.messageMarks.delete(id);
        };
      },
    });
    for (const { m } of marks) remember(m);
    return entries;
  }

  // Start a new membership incarnation at the current journal high-water
  // mark. Pending transcript changes are journaled first so pre-join
  // messages fall at or below the boundary.
  function grant(room, accountId) {
    sync();
    room.eventSince ??= {};
    room.eventIncarnation = (room.eventIncarnation || 0) + 1;
    room.eventSince[accountId] = {
      seq: journal.latestSeq(room.id),
      incarnation: room.eventIncarnation,
    };
    return room.eventSince[accountId];
  }

  function end(room, accountId) {
    if (room.eventSince) delete room.eventSince[accountId];
  }

  // Membership boundaries follow room.agentIds: members without one get a
  // fresh grant (never earlier than now); former members lose theirs.
  function reconcileGrants() {
    let changedAny = false;
    for (const room of db.rooms) {
      room.eventSince ??= {};
      for (const id of Object.keys(room.eventSince))
        if (!room.agentIds?.includes(id)) {
          end(room, id);
          changedAny = true;
        }
      for (const id of room.agentIds || [])
        if (!room.eventSince[id]) {
          grant(room, id);
          changedAny = true;
        }
    }
    return changedAny;
  }

  return { migrate, sync, grant, end, reconcileGrants };
}

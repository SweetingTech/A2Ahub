import { CursorError } from "./events.js";

// One authorization policy for every agent-facing event path: read_events,
// acknowledge_events, SSE replay, SSE live delivery and receipt lookup.
// Every check reads current state; nothing captured at connect time grants
// access later.

export function makeEventGate({ access, db }) {
  function deny(status, message) {
    return new CursorError(status, message);
  }

  // Resolve the current grant for an authenticated account in a room.
  // `authorization` re-validates the credential (revocation and expiry).
  function authorize(authorization, roomId, { allowArchived = false } = {}) {
    const account = access.authenticate(authorization);
    const room = db.rooms.find((r) => r.id === roomId);
    const grant = room?.eventSince?.[account.id];
    if (
      !room ||
      !access.canAccess(account.id, room.id) ||
      !room.agentIds?.includes(account.id) ||
      !grant
    )
      throw deny(403, "Conversation access denied.");
    if (room.archived && !allowArchived)
      throw deny(409, "Conversation is archived by the owner.");
    return { account, room, grant };
  }

  // True only while the same membership incarnation is still current.
  function stillAuthorized(authorization, roomId, incarnation) {
    try {
      const { grant } = authorize(authorization, roomId);
      return grant.incarnation === incarnation;
    } catch {
      return false;
    }
  }

  // An event is visible when its message (or the event itself, for
  // non-message events) originated after this grant began and the account
  // was in its audience. Later revisions keep their message's origin.
  function visible(entry, accountId, grant) {
    if ((entry.originSeq || entry.seq) <= grant.seq) return false;
    if (entry.type.startsWith("dispatch.") || entry.type.startsWith("receipt."))
      return entry.audience.includes(accountId);
    return entry.audience.includes(accountId) || entry.senderId === accountId;
  }

  // Effective exclusive start: never before the membership boundary.
  function startCursor(cursor, grant) {
    return Math.max(cursor, grant.seq);
  }

  return { authorize, stillAuthorized, visible, startCursor };
}

export function publicEvent(e) {
  return {
    eventId: e.eventId,
    type: e.type,
    roomId: e.roomId,
    seq: e.seq,
    messageId: e.messageId,
    messageRevision: e.messageRevision,
    senderId: e.senderId,
    senderName: e.senderName,
    threadId: e.threadId,
    replyTo: e.replyTo,
    discussionId: e.discussionId,
    dispatchId: e.dispatchId,
    createdAt: e.createdAt,
    payload: e.payload,
  };
}

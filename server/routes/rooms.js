import { randomUUID } from "node:crypto";
import { discover } from "../protocol.js";
import { CursorError, parseCursor } from "../events.js";
import { publicEvent } from "../event-access.js";
import {
  buildRoomLink,
  MOCK_CONTRACT,
} from "../room-links.js";

// Room routes + helpers under /api: listing, detail, events cursor, room links,
// room creation, agent add/check, plus shared helpers (getRoom, validateMembers,
// updateRoom, validateFolder, folderFields) used by other route modules.
export function mountRoomRoutes(ctx) {
  const {
    app,
    db,
    publish,
    access,
    audit,
    broker,
    chat,
    journal,
    origin,
    actor,
    participants,
    createRoom,
    getRoom,
    activeRoom,
    validateMembers,
    validateFolder,
    folderFields,
    updateRoom,
    safeError,
  } = ctx;

  app.get("/api/rooms", (req, res) =>
    res.json(
      db.rooms.map(({ messages, contexts, ...r }) => ({
        ...r,
        messageCount: messages.length,
        lastMessageAt: messages.at(-1)?.createdAt || r.createdAt,
        active: chat.active(r.id).length > 0,
      })),
    ),
  );

  app.get("/api/rooms/:id", (req, res) => {
    const { contexts, ...r } = getRoom(req.params.id);
    res.json({ ...r, active: chat.active(r.id).length > 0 });
  });

  app.get("/api/rooms/:id/events", (req, res) => {
    const r = getRoom(req.params.id);
    let result;
    try {
      const cursor = parseCursor(req.query.cursor, { fallback: NaN });
      if (Number.isNaN(cursor)) throw new CursorError(400, "Invalid event cursor.");
      result = journal.read(r.id, cursor, { maxBatch: 500 });
    } catch (e) {
      return res
        .status(e.status || 400)
        .json({ error: e.message, latestSeq: journal.latestSeq(r.id) });
    }
    res.json({
      roomId: r.id,
      events: result.events.map(publicEvent),
      nextCursor: result.nextCursor,
      latestSeq: result.latestSeq,
      more: !!result.more,
      ...(result.resyncRequired
        ? { resyncRequired: true, oldestSeq: result.oldestSeq }
        : {}),
    });
  });

  app.get("/api/rooms/:id/gateway", (req, res) => {
    const r = getRoom(req.params.id);
    const events = journal.read(r.id, 0, { maxBatch: 1000 }).events;
    const dispatchEvents = events.filter((e) => e.type.startsWith("dispatch."));
    const deliveries = dispatchEvents.map((e) => ({
      dispatchId: e.dispatchId,
      type: e.type,
      seq: e.seq,
      senderId: e.senderId,
      createdAt: e.createdAt,
      payload: e.payload,
    }));
    const receipts = [];
    for (const d of deliveries.filter((d) => d.dispatchId)) {
      const receipt = journal.getCompletion(d.dispatchId);
      if (receipt) receipts.push({ dispatchId: d.dispatchId, acceptedAt: receipt.acceptedAt, state: receipt.state });
    }
    const cursors = {};
    for (const a of r.agentIds) {
      const grant = r.eventSince?.[a];
      cursors[a] = grant
        ? { acknowledged: journal.getCursor(a, r.id, grant.incarnation), since: grant.seq }
        : null;
    }
    res.json({
      roomId: r.id,
      latestSeq: journal.latestSeq(r.id),
      deliveryCount: deliveries.length,
      deliveries,
      receipts,
      cursors,
      active: chat.active(r.id).length > 0,
    });
  });

  app.get("/api/rooms/:id/room-link", (req, res) => {
    const r = getRoom(req.params.id);
    const useMock = req.query.mock === "1";
    res.json({
      link: buildRoomLink(origin, r.id, { mock: useMock }),
      mock: useMock,
      contract: useMock ? MOCK_CONTRACT : null,
      roomTitle: r.title,
    });
  });

  app.get("/api/agents", (req, res) => res.json(participants()));

  app.post("/api/rooms", (req, res) => {
    const r = createRoom();
    const { folderId = null, ...settings } = req.body || {};
    validateFolder(folderId);
    updateRoom(r, settings);
    r.folderId = folderId;
    db.rooms.unshift(r);
    publish();
    res.json(r);
  });

  app.post("/api/agents", async (req, res) => {
    const { url, tokenEnv } = req.body;
    if (tokenEnv && !/^A2AHUB_TOKEN_[A-Z0-9_]+$/.test(tokenEnv))
      throw new Error(
        "Credential variable must begin A2AHUB_TOKEN_ and use uppercase letters, digits, underscores.",
      );
    const info = await discover(url, tokenEnv);
    if (db.agents.some((a) => a.rpcUrl === info.rpcUrl || a.url === url))
      throw new Error("This endpoint is already connected.");
    const agent = { id: randomUUID(), url, tokenEnv, ...info };
    db.agents.push(agent);
    audit.record("agent.added", { actor: actor(req), agent: agent.name });
    publish();
    res.json(agent);
  });

  app.post("/api/agents/:id/check", async (req, res) => {
    const a = db.agents.find((a) => a.id === req.params.id);
    if (!a) return res.sendStatus(404);
    try {
      Object.assign(a, await discover(a.url, a.tokenEnv));
      delete a.error;
    } catch (e) {
      a.status = "offline";
      a.error = safeError(e.message, a);
    }
    publish();
    res.json(a);
  });
}

// Shared helpers exported for other route modules.
export function makeGetRoom(db) {
  return function getRoom(id) {
    const r = db.rooms.find((r) => r.id === id);
    if (!r) throw new Error("Conversation not found.");
    return r;
  };
}

export function makeActiveRoom(db, getRoom) {
  return function activeRoom(id) {
    const r = getRoom(id);
    if (r.archived)
      throw new Error("This conversation is archived. Restore it first.");
    return r;
  };
}

export function makeValidateFolder(db) {
  return function validateFolder(folderId) {
    if (folderId !== null && !db.folders.some((f) => f.id === folderId))
      throw new Error("Folder not found.");
  };
}

export function makeFolderFields(FOLDER_COLORS) {
  return function folderFields(body, current = {}) {
    const { name = current.name, color = current.color || "gray" } = body || {};
    if (typeof name !== "string" || !name.trim() || name.length > 40)
      throw new Error("Folder name must be 1–40 characters.");
    if (!FOLDER_COLORS.includes(color))
      throw new Error(`Folder color must be one of ${FOLDER_COLORS.join(", ")}.`);
    return { name: name.trim(), color };
  };
}

export function makeValidateMembers(participants) {
  return function validateMembers(ids, allowEmpty = false) {
    if (
      !Array.isArray(ids) ||
      (!allowEmpty && !ids.length) ||
      ids.length > 6 ||
      new Set(ids).size !== ids.length
    )
      throw new Error("Choose up to six distinct agents for this chat.");
    const directory = participants();
    const agents = ids.map((id) => directory.find((a) => a.id === id));
    if (agents.some((a) => !a)) throw new Error("Agent not found.");
    return agents;
  };
}

export function makeUpdateRoom({
  chat,
  access,
  broker,
  validateMembers,
  eventSync,
  sse,
}) {
  return function updateRoom(r, body) {
    if (chat.active(r.id).length)
      throw new Error(
        "Stop agents before changing chat membership or reply settings.",
      );
    const {
      agentIds = r.agentIds,
      agentChat = r.agentChat,
      replyLimit = r.replyLimit,
      title,
    } = body;
    validateMembers(agentIds, true);
    if (
      typeof agentChat !== "boolean" ||
      !Number.isInteger(replyLimit) ||
      replyLimit < Math.max(1, agentIds.length) ||
      replyLimit > 6
    )
      throw new Error(
        "Reply allowance must cover each member and be no more than six.",
      );
    if (
      title !== undefined &&
      (typeof title !== "string" || !title.trim() || title.length > 100)
    )
      throw new Error("Conversation title must be 1–100 characters.");
    const added = agentIds.filter((id) => !r.agentIds.includes(id));
    const removed = r.agentIds.filter((id) => !agentIds.includes(id));
    if (added.length || removed.length || agentChat !== r.agentChat) {
      for (const run of chat.runs.values())
        if (run.roomId === r.id) run.allowPeers = false;
    }
    for (const id of [...added, ...removed]) {
      delete r.contexts[id];
      r.memberSince[id] = r.messages.length;
    }
    for (const id of removed) {
      eventSync.end(r, id);
      sse.closeFor(id, r.id);
    }
    for (const id of added) eventSync.grant(r, id);
    access.setRoomMembers(
      r,
      agentIds.filter((id) => access.db.accounts.some((a) => a.id === id)),
    );
    Object.assign(r, { agentIds, agentChat, replyLimit });
    if (title !== undefined)
      Object.assign(r, { title: title.trim(), customTitle: true });
    for (const id of removed) broker.invalidate(id, r.id);
  };
}

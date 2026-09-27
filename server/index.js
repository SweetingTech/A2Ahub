import express from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discover, send, cancel } from "./protocol.js";
import { GroupChat } from "./chat.js";
import { Access } from "./access.js";
import { mountInbound } from "./inbound.js";
import { DispatchBroker } from "./dispatch.js";
import { Audit } from "./audit.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.A2AHUB_DATA_DIR || path.join(root, "data");
const version = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
).version;
const startedAt = Date.now();
// Headless serves the same loopback owner API without the web interface.
const headless =
  process.argv.includes("--headless") ||
  /^(1|true|yes)$/i.test(process.env.A2AHUB_HEADLESS || "");
const FOLDER_COLORS = [
  "teal",
  "purple",
  "orange",
  "blue",
  "green",
  "pink",
  "gray",
];
fs.mkdirSync(dataDir, { recursive: true });
const file = path.join(dataDir, "workspace.json");
const room = () => ({
  id: randomUUID(),
  title: "Shared workspace",
  messages: [],
  contexts: {},
  agentIds: [],
  memberSince: {},
  agentChat: true,
  replyLimit: 6,
  paused: false,
  folderId: null,
  pinned: false,
  archived: false,
  createdAt: new Date().toISOString(),
});
let db = fs.existsSync(file)
  ? JSON.parse(fs.readFileSync(file, "utf8"))
  : {
      agents: [
        {
          id: randomUUID(),
          url: "http://127.0.0.1:9900/",
          name: "LilDSweetz",
          status: "unchecked",
        },
      ],
      rooms: [room()],
    };
for (const a of db.agents) a.status = "unchecked";
db.profile ??= { displayName: process.env.USERNAME || "You" };
// Folders and archive state are additive; existing rooms start unfiled and active.
db.folders = Array.isArray(db.folders) ? db.folders : [];
for (const r of db.rooms) {
  if (!db.folders.some((f) => f.id === r.folderId)) r.folderId = null;
  r.pinned = r.pinned === true;
  r.archived = r.archived === true;
  // Existing rooms gain explicit membership without exposing old transcripts.
  r.agentIds ??= [];
  r.agentChat ??= false;
  r.replyLimit ??= 6;
  r.paused ??= false;
  r.contexts ??= {};
  r.memberSince ??= {};
}
for (const r of db.rooms)
  for (const m of r.messages)
    if (["working", "submitted"].includes(m.state)) {
      m.state = "interrupted";
      m.text += "\n[Server restarted. Remote task may still be running.]";
    }
function save() {
  fs.writeFileSync(file + ".tmp", JSON.stringify(db, null, 2));
  fs.renameSync(file + ".tmp", file);
}
save();
const clients = new Map();
const access = new Access(dataDir);
const audit = new Audit(dataDir);
access.migrateRooms(db.rooms);
save();
const broker = new DispatchBroker({
  isAuthorized: (accountId, roomId) =>
    access.canAccess(accountId, roomId) &&
    !!db.rooms.find(
      (r) => r.id === roomId && r.agentIds.includes(accountId) && !r.paused,
    ),
  onChange: publish,
});
const chat = new GroupChat({
  send: (agent, ...args) =>
    agent.kind === "inbound"
      ? broker.send(agent, ...args)
      : send(agent, ...args),
  cancel: (agent, taskId) =>
    agent.kind === "inbound"
      ? broker.cancel(agent, taskId)
      : cancel(agent, taskId),
  publish,
  redact: safeError,
  ownerName: () => db.profile.displayName,
});
function participants() {
  return [
    ...db.agents.map((a) => ({ ...a, kind: "endpoint" })),
    ...access.db.accounts
      .filter((a) => !a.revoked && a.expiresAt > Date.now())
      .map((a) => ({
        id: a.id,
        inboundAccountId: a.id,
        name: a.name,
        kind: "inbound",
        status: broker.status(a.id),
        receiver: broker.receiver(a.id),
        expiresAt: a.expiresAt,
      })),
  ];
}
function snapshot() {
  return {
    ...db,
    runs: chat.snapshot(),
    participants: participants(),
    agentOrigin: process.env.A2AHUB_PUBLIC_URL || origin,
    inboundConnections: access.db.accounts
      .filter((a) => !a.revoked && a.expiresAt > Date.now())
      .map(({ id, name, roomId }) => ({ id, name, roomId })),
  };
}
function publish() {
  save();
  closeExpiredClients();
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const c of clients.keys()) c.write(payload);
}
function closeExpiredClients() {
  for (const [res, req] of clients) {
    if (authorized(req)) continue;
    clients.delete(res);
    res.write("event: auth-expired\ndata: {}\n\n");
    res.end();
  }
}
const app = express();
const port = Number(process.env.PORT || 4317);
const origin = `http://127.0.0.1:${port}`;
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be 1–65535.");
app.use((req, res, next) => {
  if (!["127.0.0.1", "localhost"].includes(req.hostname))
    return res.status(403).json({ error: "Local access only." });
  if (
    req.headers.origin &&
    ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(
      req.headers.origin,
    )
  )
    return res
      .status(403)
      .json({ error: "Cross-origin requests are disabled." });
  res.setHeader("X-Content-Type-Options", "nosniff");
  // /api/v1 is the stable, versioned name for the owner API used by scripts.
  if (req.url === "/api/v1" || req.url.startsWith("/api/v1/"))
    req.url = "/api" + req.url.slice(7);
  next();
});
app.use("/a2a/jsonrpc", express.json({ limit: "2mb" }));
app.use(express.json({ limit: "64kb" }));
app.use(["/auth", "/api/access"], (req, res, next) => {
  res.set("Cache-Control", "no-store");
  res.set("Referrer-Policy", "no-referrer");
  next();
});
app.get("/auth/session", (req, res) =>
  res.json({
    authenticated: access.owner(req),
    passwordLocation: fs.existsSync(access.passwordFile)
      ? access.passwordFile
      : null,
    headless,
  }),
);
app.post("/auth/login", (req, res) => {
  const token = access.login(req.body.password, req.socket.remoteAddress);
  audit.record("owner.login");
  res
    .set(
      "Set-Cookie",
      `a2ahub_owner=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
    )
    .json({ ok: true });
});
app.post("/auth/logout", (req, res) => {
  if (access.owner(req)) audit.record("owner.logout");
  access.logout(req);
  closeExpiredClients();
  res
    .set(
      "Set-Cookie",
      "a2ahub_owner=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
    )
    .json({ ok: true });
});
app.post("/auth/device", (req, res) => {
  const request = access.request(
    req.body.name,
    origin,
    req.socket.remoteAddress,
  );
  audit.record("access.requested", {
    actor: "agent",
    agent: req.body.name?.trim(),
  });
  res.status(201).json(request);
});
app.post("/auth/token", (req, res) => {
  const credential = access.poll(req.body.device_code, {
    rooms: db.rooms,
    canJoinRoom: (room) => !chat.active(room.id).length,
  });
  publish();
  res.json(credential);
});
app.use("/auth", (err, req, res, next) =>
  res.status(err.status || 400).json({ error: err.message }),
);
const onPost = (room, message) => chat.relayPost(room, message);
mountInbound(app, { access, db, publish, origin, broker, onPost });
// Scope a manager token needs for an owner API route. Reads need "read";
// conversation work needs "chat"; everything else (access, agents, admin,
// profile) needs "admin". Some routes additionally require the owner session.
function requiredScope(req) {
  const route = req.path;
  if (req.method === "GET")
    return /^\/(admin|access|manager-tokens)(\/|$)/.test(route)
      ? "admin"
      : "read";
  return /^\/(rooms|runs|folders)(\/|$)/.test(route) ? "chat" : "admin";
}
function authorized(req) {
  return access.owner(req) || !!access.manager(req, { touch: false });
}
app.use("/api", (req, res, next) => {
  if (access.owner(req)) {
    req.actor = { kind: "owner", label: "owner" };
    return next();
  }
  const token = access.manager(req);
  if (token) {
    const scope = requiredScope(req);
    // Any token may revoke itself, so a read-only CLI can still log out.
    const self =
      req.method === "DELETE" && req.path === `/manager-tokens/${token.id}`;
    if (!self && !token.scopes.includes(scope))
      return res
        .status(403)
        .json({ error: `This manager token lacks the ${scope} scope.` });
    req.actor = {
      kind: "manager",
      label: `token:${token.name}`,
      tokenId: token.id,
    };
    return next();
  }
  if (req.headers.authorization)
    try {
      access.limit(`manager:${req.socket.remoteAddress}`, 30, 60000);
    } catch (e) {
      return res.status(429).json({ error: e.message });
    }
  return res
    .status(401)
    .json({ error: "Sign in as the owner to manage A2Ahub." });
});
function ownerOnly(req) {
  if (req.actor?.kind !== "owner")
    throw Object.assign(
      new Error("Sign in to the web interface as the owner to do this."),
      { status: 403 },
    );
}
const actor = (req) => req.actor?.label || "owner";
app.get("/api/access", (req, res) => res.json(access.list()));
app.post("/api/access/:id/decision", (req, res) => {
  if (typeof req.body.approved !== "boolean")
    throw new Error("Choose Approve or Deny.");
  if (req.body.roomId && !db.rooms.some((r) => r.id === req.body.roomId))
    throw new Error("Conversation not found.");
  const pending = access.list().requests.find((r) => r.id === req.params.id);
  access.decide(
    req.params.id,
    db.rooms.find((r) => r.id === req.body.roomId),
    req.body.approved,
    req.body.userCode,
  );
  audit.record(req.body.approved ? "access.approved" : "access.denied", {
    actor: actor(req),
    agent: pending?.name,
  });
  publish();
  res.json({ ok: true });
});
app.delete("/api/access/:id", (req, res) => {
  access.revoke(req.params.id);
  audit.record("access.revoked", {
    actor: actor(req),
    agent: access.db.accounts.find((a) => a.id === req.params.id)?.name,
  });
  for (const r of db.rooms)
    r.agentIds = r.agentIds.filter((id) => id !== req.params.id);
  broker.invalidate(req.params.id);
  publish();
  res.json({ ok: true });
});
app.get("/api/state", (req, res) => res.json(snapshot()));
app.get("/api/profile", (req, res) => res.json(db.profile));
app.patch("/api/profile", (req, res) => {
  const { displayName } = req.body;
  if (
    typeof displayName !== "string" ||
    !displayName.trim() ||
    displayName.length > 80
  )
    throw new Error("Your name must be 1–80 characters.");
  db.profile = { displayName: displayName.trim() };
  publish();
  res.json(db.profile);
});
app.get("/api/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  clients.set(res, req);
  res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  const t = setInterval(() => {
    if (!authorized(req)) {
      res.write("event: auth-expired\ndata: {}\n\n");
      res.end();
      return;
    }
    res.write(": keepalive\n\n");
  }, 20000);
  req.on("close", () => {
    clearInterval(t);
    clients.delete(res);
  });
});
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
app.get("/api/agents", (req, res) => res.json(participants()));
app.post("/api/rooms", (req, res) => {
  const r = room();
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
function getRoom(id) {
  const r = db.rooms.find((r) => r.id === id);
  if (!r) throw new Error("Conversation not found.");
  return r;
}
function activeRoom(id) {
  const r = getRoom(id);
  if (r.archived)
    throw new Error("This conversation is archived. Restore it first.");
  return r;
}
function validateFolder(folderId) {
  if (folderId !== null && !db.folders.some((f) => f.id === folderId))
    throw new Error("Folder not found.");
}
function folderFields(body, current = {}) {
  const { name = current.name, color = current.color || "gray" } = body || {};
  if (typeof name !== "string" || !name.trim() || name.length > 40)
    throw new Error("Folder name must be 1–40 characters.");
  if (!FOLDER_COLORS.includes(color))
    throw new Error(`Folder color must be one of ${FOLDER_COLORS.join(", ")}.`);
  return { name: name.trim(), color };
}
function validateMembers(ids, allowEmpty = false) {
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
}
function updateRoom(r, body) {
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
  access.setRoomMembers(
    r,
    agentIds.filter((id) => access.db.accounts.some((a) => a.id === id)),
  );
  Object.assign(r, { agentIds, agentChat, replyLimit });
  if (title !== undefined)
    Object.assign(r, { title: title.trim(), customTitle: true });
  for (const id of removed) broker.invalidate(id, r.id);
}
app.patch("/api/rooms/:id", (req, res) => {
  const r = getRoom(req.params.id);
  // Filing and pinning never touch membership, so they work during a burst.
  const { folderId, pinned, ...settings } = req.body || {};
  if (folderId !== undefined) validateFolder(folderId);
  if (pinned !== undefined && typeof pinned !== "boolean")
    throw new Error("Pinned must be true or false.");
  if (Object.keys(settings).length) {
    if (r.archived && Object.keys(settings).some((k) => k !== "title"))
      throw new Error(
        "Restore this conversation before changing members or reply settings.",
      );
    updateRoom(r, settings);
  }
  if (folderId !== undefined) r.folderId = folderId;
  if (pinned !== undefined) r.pinned = pinned;
  publish();
  res.json(r);
});
app.post("/api/rooms/:id/archive", (req, res) => {
  const r = getRoom(req.params.id);
  if (chat.active(r.id).length)
    throw new Error("Stop agents before archiving this conversation.");
  if (!r.archived) {
    // Archived rooms are paused, so agents can neither read work nor post.
    Object.assign(r, {
      archived: true,
      archivedAt: new Date().toISOString(),
      paused: true,
      pinned: false,
    });
    audit.record("room.archived", { actor: actor(req), room: r.title });
  }
  publish();
  res.json(r);
});
app.post("/api/rooms/:id/unarchive", (req, res) => {
  const r = getRoom(req.params.id);
  if (r.archived) {
    // Restoring never resumes agents; Resume remains an explicit step.
    r.archived = false;
    delete r.archivedAt;
    audit.record("room.restored", { actor: actor(req), room: r.title });
  }
  publish();
  res.json(r);
});
app.delete("/api/rooms/:id", (req, res) => {
  const r = getRoom(req.params.id);
  if (!r.archived)
    throw new Error("Archive this conversation before deleting it.");
  if (chat.active(r.id).length)
    throw new Error("Stop agents before deleting this conversation.");
  access.setRoomMembers(r, []);
  for (const id of r.agentIds) broker.invalidate(id, r.id);
  db.rooms = db.rooms.filter((x) => x !== r);
  audit.record("room.deleted", { actor: actor(req), room: r.title });
  publish();
  res.json({ ok: true });
});
app.post("/api/folders", (req, res) => {
  if (db.folders.length >= 50)
    throw new Error("You can have up to 50 folders.");
  const folder = {
    id: randomUUID(),
    ...folderFields(req.body),
    createdAt: new Date().toISOString(),
  };
  db.folders.push(folder);
  publish();
  res.json(folder);
});
app.patch("/api/folders/:id", (req, res) => {
  const folder = db.folders.find((f) => f.id === req.params.id);
  if (!folder) throw new Error("Folder not found.");
  Object.assign(folder, folderFields(req.body, folder));
  publish();
  res.json(folder);
});
app.delete("/api/folders/:id", (req, res) => {
  const folder = db.folders.find((f) => f.id === req.params.id);
  if (!folder) throw new Error("Folder not found.");
  // Removing a folder keeps its conversations; they become unfiled.
  for (const r of db.rooms) if (r.folderId === folder.id) r.folderId = null;
  db.folders = db.folders.filter((f) => f !== folder);
  publish();
  res.json({ ok: true });
});
app.delete("/api/agents/:id", (req, res) => {
  if (chat.active().some((r) => r.agentIds.includes(req.params.id)))
    throw new Error("Stop the active conversation before removing this agent.");
  const removed = db.agents.find((a) => a.id === req.params.id);
  db.agents = db.agents.filter((a) => a.id !== req.params.id);
  if (removed)
    audit.record("agent.removed", { actor: actor(req), agent: removed.name });
  for (const r of db.rooms)
    r.agentIds = r.agentIds.filter((id) => id !== req.params.id);
  publish();
  res.json({ ok: true });
});
app.post("/api/rooms/:id/stop", async (req, res) => {
  const r = getRoom(req.params.id);
  await chat.stop(r);
  audit.record("room.stopped", { actor: actor(req), room: r.title });
  res.json({ ok: true });
});
app.post("/api/rooms/:id/resume", (req, res) => {
  const r = activeRoom(req.params.id);
  if (chat.active(r.id).length)
    throw new Error("Wait for agents to stop first.");
  r.paused = false;
  publish();
  res.json({ ok: true });
});
app.post("/api/rooms/:id/continue", (req, res) => {
  const r = activeRoom(req.params.id);
  if (chat.active().length)
    throw new Error(
      "Wait for the current discussion to finish or stop agents first.",
    );
  const agents = validateMembers(r.agentIds);
  const run = chat.start(r, agents, null);
  audit.record("room.continued", { actor: actor(req), room: r.title });
  res.status(202).json({ id: run.id });
});
app.post("/api/runs/:id/stop", async (req, res) => {
  const run = chat.runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: "Discussion not found." });
  await chat.stop(getRoom(run.roomId));
  res.json({ ok: true });
});
function startMessage(req, res, roomId, text) {
  const r = activeRoom(roomId);
  if (typeof text !== "string" || !text.trim() || text.length > 12000)
    throw new Error("Enter a message of 1–12,000 characters.");
  const agents = validateMembers(r.agentIds);
  const run = chat.start(r, agents, text.trim());
  if (req.actor?.kind === "manager")
    audit.record("room.message", { actor: actor(req), room: r.title });
  res.status(202).json({ id: run.id });
}
app.post("/api/runs", (req, res) =>
  startMessage(req, res, req.body?.roomId, req.body?.text),
);
app.post("/api/rooms/:id/messages", (req, res) =>
  startMessage(req, res, req.params.id, req.body?.text),
);
function attention() {
  const now = Date.now(),
    items = [];
  for (const r of access.list().requests)
    items.push({
      kind: "request",
      severity: "action",
      id: r.id,
      agent: r.name,
      text: `${r.name} is requesting access`,
      expiresAt: r.expiresAt,
    });
  for (const a of participants()) {
    if (a.kind === "inbound" && a.expiresAt - now < 7 * 86400000)
      items.push({
        kind: "expiring",
        severity: "warning",
        id: a.id,
        agent: a.name,
        text: `${a.name}'s credential expires ${new Date(a.expiresAt).toLocaleDateString()}`,
      });
    if (a.receiver?.kind === "session" && !a.receiver.lastReceiptAt)
      items.push({
        kind: "handshake",
        severity: "info",
        id: a.id,
        agent: a.name,
        text: `${a.name} is waiting for its conversation to confirm`,
      });
    else if (
      a.status === "offline" ||
      (a.kind === "inbound" && a.status !== "connected")
    )
      items.push({
        kind: "offline",
        severity: "info",
        id: a.id,
        agent: a.name,
        text: `${a.name} is offline`,
      });
  }
  return items;
}
function backups() {
  const dir = path.join(dataDir, "backups");
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /^workspace-.*\.json$/.test(f))
      .map((f) => ({ file: f, at: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}
function exportWorkspace() {
  // workspace.json never contains credential values; access.json is excluded.
  return { exportedAt: new Date().toISOString(), version, workspace: db };
}
app.get("/api/admin", (req, res) => {
  const people = participants();
  const list = backups();
  res.json({
    server: {
      version,
      node: process.version,
      startedAt: new Date(startedAt).toISOString(),
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      headless,
    },
    listeners: {
      owner: { origin, loopbackOnly: true },
      agent: process.env.A2AHUB_AGENT_PORT
        ? {
            enabled: true,
            port: Number(process.env.A2AHUB_AGENT_PORT),
            host: process.env.A2AHUB_AGENT_HOST || "127.0.0.1",
            publicUrl: process.env.A2AHUB_PUBLIC_URL || null,
          }
        : { enabled: false },
    },
    counts: {
      agents: people.length,
      online: people.filter((a) => a.status === "connected").length,
      rooms: db.rooms.filter((r) => !r.archived).length,
      archived: db.rooms.filter((r) => r.archived).length,
      folders: db.folders.length,
      pendingRequests: access.list().requests.length,
      approvedAgents: access.db.accounts.filter((a) => access.active(a)).length,
      managerTokens: access.listManagerTokens().length,
      ownerSessions: access.sessionCount(),
    },
    activity: chat
      .snapshot()
      .filter((r) => ["running", "stopping"].includes(r.state))
      .map((r) => ({
        ...r,
        roomTitle: db.rooms.find((room) => room.id === r.roomId)?.title,
      })),
    attention: attention(),
    data: {
      dir: dataDir,
      customDir: !!process.env.A2AHUB_DATA_DIR,
      workspaceBytes: fs.statSync(file).size,
      backups: list.length,
      lastBackupAt: list[0] ? new Date(list[0].at).toISOString() : null,
    },
    environment: {
      PORT: port,
      A2AHUB_DATA_DIR: process.env.A2AHUB_DATA_DIR ? "set" : "default",
      A2AHUB_AGENT_PORT: process.env.A2AHUB_AGENT_PORT || null,
      A2AHUB_PUBLIC_URL: process.env.A2AHUB_PUBLIC_URL || null,
      A2AHUB_HEADLESS: headless,
      // Names only: the Hub never reports credential values.
      tokenVariables: [
        ...new Set(db.agents.map((a) => a.tokenEnv).filter(Boolean)),
      ].map((name) => ({ name, set: !!process.env[name] })),
    },
    audit: audit.list(20),
  });
});
app.get("/api/admin/audit", (req, res) =>
  res.json(audit.list(req.query.limit)),
);
app.post("/api/admin/stop-all", async (req, res) => {
  const rooms = db.rooms.filter((r) => chat.active(r.id).length);
  await Promise.all(rooms.map((r) => chat.stop(r)));
  audit.record("admin.stop_all", { actor: actor(req), rooms: rooms.length });
  res.json({ ok: true, stopped: rooms.map((r) => r.id) });
});
app.post("/api/admin/backup", (req, res) => {
  const dir = path.join(dataDir, "backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(dir, `workspace-${stamp}.json`);
  fs.writeFileSync(target + ".tmp", JSON.stringify(exportWorkspace(), null, 2));
  fs.renameSync(target + ".tmp", target);
  audit.record("admin.backup", { actor: actor(req) });
  res.json({ ok: true, file: target });
});
app.get("/api/admin/export", (req, res) => {
  audit.record("admin.export", { actor: actor(req) });
  res
    .set(
      "Content-Disposition",
      `attachment; filename="a2ahub-workspace-${new Date().toISOString().slice(0, 10)}.json"`,
    )
    .json(exportWorkspace());
});
app.post("/api/admin/password", (req, res) => {
  ownerOnly(req);
  access.changePassword(req.body?.current, req.body?.next, req);
  audit.record("owner.password_changed");
  closeExpiredClients();
  res.json({ ok: true });
});
app.post("/api/admin/sessions/revoke-others", (req, res) => {
  ownerOnly(req);
  const ended = access.revokeOtherSessions(req);
  audit.record("owner.sessions_revoked", { count: ended });
  closeExpiredClients();
  res.json({ ok: true, ended });
});
app.get("/api/manager-tokens", (req, res) =>
  res.json(access.listManagerTokens()),
);
app.post("/api/manager-tokens", (req, res) => {
  ownerOnly(req);
  const created = access.createManagerToken(req.body?.name, req.body?.scopes);
  audit.record("manager_token.created", { token: created.name });
  res.status(201).json(created);
});
app.delete("/api/manager-tokens/:id", (req, res) => {
  // A token may revoke itself (CLI logout); others need the owner session.
  if (req.actor?.tokenId !== req.params.id) ownerOnly(req);
  const record = access.revokeManagerToken(req.params.id);
  audit.record("manager_token.revoked", {
    actor: actor(req),
    token: record.name,
  });
  closeExpiredClients();
  res.json({ ok: true });
});
function safeError(message, a) {
  const token = a?.tokenEnv && process.env[a.tokenEnv];
  return token ? message.replaceAll(token, "[redacted]") : message;
}
app.use("/api", (err, req, res, next) =>
  res
    .status([401, 403, 404, 409, 429].includes(err.status) ? err.status : 400)
    .json({
      error: db.agents.reduce(
        (m, a) => safeError(m, a),
        err.message || "Request failed.",
      ),
    }),
);
if (headless) {
  app.get("/", (req, res) =>
    res.json({
      name: "A2Ahub",
      version,
      headless: true,
      api: `${origin}/api/v1`,
    }),
  );
  app.use((req, res) =>
    res
      .status(404)
      .json({ error: "Headless mode: use the API under /api/v1." }),
  );
} else if (
  !process.argv.includes("--dev") &&
  fs.existsSync(path.join(root, "dist", "index.html"))
) {
  app.use(express.static(path.join(root, "dist")));
  app.get("/{*path}", (req, res) =>
    res.sendFile(path.join(root, "dist", "index.html")),
  );
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    root,
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
const server = app.listen(port, "127.0.0.1", () =>
  console.log(
    headless
      ? `A2Ahub headless API ready at ${origin}/api/v1 (no web interface)`
      : `A2Ahub ready at ${origin}`,
  ),
);
server.on("error", (e) => {
  console.error(
    e.code === "EADDRINUSE" ? `Port ${port} is already in use.` : e.message,
  );
  process.exit(1);
});
// Remote agents get a deliberately narrow listener; owner routes never mount here.
// The configured public origin is explicit so neither Host nor proxy headers can
// rewrite approval links or the authenticated A2A endpoint advertised by the card.
if (process.env.A2AHUB_AGENT_PORT) {
  const agentPort = Number(process.env.A2AHUB_AGENT_PORT);
  const publicUrl = new URL(
    process.env.A2AHUB_PUBLIC_URL || `http://127.0.0.1:${agentPort}`,
  );
  if (
    !Number.isInteger(agentPort) ||
    agentPort < 1 ||
    agentPort > 65535 ||
    agentPort === port ||
    !["http:", "https:"].includes(publicUrl.protocol) ||
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.pathname !== "/" ||
    publicUrl.search ||
    publicUrl.hash
  )
    throw new Error(
      "Configure a distinct A2AHUB_AGENT_PORT and an HTTP(S) A2AHUB_PUBLIC_URL origin.",
    );
  const remote = express();
  remote.use((req, res, next) => {
    if (
      req.headers.host !== publicUrl.host ||
      (req.headers.origin && req.headers.origin !== publicUrl.origin)
    )
      return res.status(403).json({ error: "Agent origin is not allowed." });
    res.set({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    next();
  });
  remote.use("/a2a/jsonrpc", express.json({ limit: "2mb" }));
  remote.use(express.json({ limit: "64kb" }));
  remote.post("/auth/device", (req, res) => {
    const request = access.request(
      req.body.name,
      origin,
      req.socket.remoteAddress,
    );
    audit.record("access.requested", {
      actor: "agent",
      agent: req.body.name?.trim(),
    });
    res.status(201).json(request);
  });
  remote.post("/auth/token", (req, res) => {
    const credential = access.poll(req.body.device_code, {
      rooms: db.rooms,
      canJoinRoom: (room) => !chat.active(room.id).length,
    });
    publish();
    res.json(credential);
  });
  mountInbound(remote, {
    access,
    db,
    publish,
    origin: publicUrl.origin,
    broker,
    onPost,
  });
  remote.use((req, res) =>
    res.status(404).json({ error: "Agent endpoint only." }),
  );
  remote.use((err, req, res, next) =>
    res.status(err.status || 400).json({ error: err.message }),
  );
  const agentServer = remote.listen(
    agentPort,
    process.env.A2AHUB_AGENT_HOST || "127.0.0.1",
    () =>
      console.log(`A2Ahub agent endpoint advertised at ${publicUrl.origin}`),
  );
  agentServer.on("error", (error) => {
    console.error(`Agent listener: ${error.message}`);
    process.exit(1);
  });
}
for (const a of db.agents) {
  try {
    Object.assign(a, await discover(a.url, a.tokenEnv));
    delete a.error;
  } catch (e) {
    a.status = "offline";
    a.error = safeError(e.message, a);
  }
  publish();
}

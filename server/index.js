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
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.A2AHUB_DATA_DIR || path.join(root, "data");
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
for (const r of db.rooms) {
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
    if (access.owner(req)) continue;
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
    passwordLocation: access.passwordFile,
  }),
);
app.post("/auth/login", (req, res) => {
  const token = access.login(req.body.password, req.socket.remoteAddress);
  res
    .set(
      "Set-Cookie",
      `a2ahub_owner=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,
    )
    .json({ ok: true });
});
app.post("/auth/logout", (req, res) => {
  access.logout(req);
  closeExpiredClients();
  res
    .set(
      "Set-Cookie",
      "a2ahub_owner=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
    )
    .json({ ok: true });
});
app.post("/auth/device", (req, res) =>
  res
    .status(201)
    .json(access.request(req.body.name, origin, req.socket.remoteAddress)),
);
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
app.use("/api", (req, res, next) => {
  if (!access.owner(req))
    return res
      .status(401)
      .json({ error: "Sign in as the owner to manage A2Ahub." });
  next();
});
app.get("/api/access", (req, res) => res.json(access.list()));
app.post("/api/access/:id/decision", (req, res) => {
  if (typeof req.body.approved !== "boolean")
    throw new Error("Choose Approve or Deny.");
  if (req.body.roomId && !db.rooms.some((r) => r.id === req.body.roomId))
    throw new Error("Conversation not found.");
  access.decide(
    req.params.id,
    db.rooms.find((r) => r.id === req.body.roomId),
    req.body.approved,
  );
  publish();
  res.json({ ok: true });
});
app.delete("/api/access/:id", (req, res) => {
  access.revoke(req.params.id);
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
    if (!access.owner(req)) {
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
app.post("/api/rooms", (req, res) => {
  const r = room();
  updateRoom(r, req.body || {});
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
  updateRoom(r, req.body);
  publish();
  res.json(r);
});
app.delete("/api/agents/:id", (req, res) => {
  if (chat.active().some((r) => r.agentIds.includes(req.params.id)))
    throw new Error("Stop the active conversation before removing this agent.");
  db.agents = db.agents.filter((a) => a.id !== req.params.id);
  for (const r of db.rooms)
    r.agentIds = r.agentIds.filter((id) => id !== req.params.id);
  publish();
  res.json({ ok: true });
});
app.post("/api/rooms/:id/stop", async (req, res) => {
  await chat.stop(getRoom(req.params.id));
  res.json({ ok: true });
});
app.post("/api/rooms/:id/resume", (req, res) => {
  const r = getRoom(req.params.id);
  if (chat.active(r.id).length)
    throw new Error("Wait for agents to stop first.");
  r.paused = false;
  publish();
  res.json({ ok: true });
});
app.post("/api/rooms/:id/continue", (req, res) => {
  const r = getRoom(req.params.id);
  if (chat.active().length)
    throw new Error(
      "Wait for the current discussion to finish or stop agents first.",
    );
  const agents = validateMembers(r.agentIds);
  const run = chat.start(r, agents, null);
  res.status(202).json({ id: run.id });
});
app.post("/api/runs/:id/stop", async (req, res) => {
  const run = chat.runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: "Discussion not found." });
  await chat.stop(getRoom(run.roomId));
  res.json({ ok: true });
});
app.post("/api/runs", (req, res) => {
  const { roomId, text } = req.body;
  const r = getRoom(roomId);
  if (typeof text !== "string" || !text.trim() || text.length > 12000)
    throw new Error("Enter a message of 1–12,000 characters.");
  const agents = validateMembers(r.agentIds);
  const run = chat.start(r, agents, text.trim());
  res.status(202).json({ id: run.id });
});
function safeError(message, a) {
  const token = a?.tokenEnv && process.env[a.tokenEnv];
  return token ? message.replaceAll(token, "[redacted]") : message;
}
app.use("/api", (err, req, res, next) =>
  res.status(400).json({
    error: db.agents.reduce(
      (m, a) => safeError(m, a),
      err.message || "Request failed.",
    ),
  }),
);
if (
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
  console.log(`A2Ahub ready at http://127.0.0.1:${port}`),
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
  remote.post("/auth/device", (req, res) =>
    res
      .status(201)
      .json(access.request(req.body.name, origin, req.socket.remoteAddress)),
  );
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

import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discover, send, cancel } from "./protocol.js";
import { GroupChat } from "./chat.js";
import { Access } from "./access.js";
import { mountInbound } from "./inbound.js";
import { DispatchBroker } from "./dispatch.js";
import { Audit } from "./audit.js";
import { EventJournal } from "./events.js";
import { makeEventSync } from "./event-sync.js";
import { makeEventGate } from "./event-access.js";
import {
  loadDB,
  saveDB,
  writeDurable,
  createRoom,
  migrateRooms,
  FOLDER_COLORS,
} from "./db.js";
import { mountAuthRoutes } from "./routes/auth.js";
import { mountStateRoutes } from "./routes/state.js";
import {
  mountRoomRoutes,
  makeGetRoom,
  makeActiveRoom,
  makeValidateFolder,
  makeFolderFields,
  makeValidateMembers,
  makeUpdateRoom,
} from "./routes/rooms.js";
import { mountFolderRoutes } from "./routes/folders.js";
import { mountAgentRoutes } from "./routes/agents.js";
import { mountChatRoutes } from "./routes/chat.js";
import { mountAdminRoutes } from "./routes/admin.js";
import { mountAgentListener } from "./agent-listener.js";
import { makeMountSseEvents } from "./sse-events.js";
import { hubClock } from "./clock.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.A2AHUB_DATA_DIR || path.join(root, "data");
const version = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
).version;
const startedAt = Date.now();
// Hub instance epoch: increments on each restart so surviving session receivers
// can discover their old claims are obsolete and reconcile.
const hubEpoch = Date.now();
// Headless serves the same loopback owner API without the web interface.
const headless =
  process.argv.includes("--headless") ||
  /^(1|true|yes)$/i.test(process.env.A2AHUB_HEADLESS || "");

fs.mkdirSync(dataDir, { recursive: true });
const now = hubClock(dataDir);
const file = path.join(dataDir, "workspace.json");

let db = loadDB(file);

// The workspace is the source of truth; the journal is committed after it,
// so a crash between the two is repaired by eventSync.sync() on restart.
let eventSync = null;
let sse = null;
function save() {
  saveDB(file, db);
  if (!eventSync) return;
  eventSync.sync();
  if (eventSync.reconcileGrants()) saveDB(file, db);
}
save();

const journalFile = path.join(dataDir, "events.json");
const persistJournal = (j) =>
  writeDurable(journalFile, JSON.stringify(j.toJSON()));
let journal;
if (fs.existsSync(journalFile)) {
  try {
    journal = EventJournal.fromJSON(
      JSON.parse(fs.readFileSync(journalFile, "utf8")),
      { persist: persistJournal },
    );
  } catch (error) {
    const aside = `${journalFile}.corrupt-${Date.now()}`;
    fs.renameSync(journalFile, aside);
    console.error(
      `A2Ahub event journal was unreadable (${error.message}); kept it as ${path.basename(aside)} and started a new one. Agents must resync.`,
    );
    journal = new EventJournal({ persist: persistJournal });
  }
} else journal = new EventJournal({ persist: persistJournal });

const clients = new Map();
const access = new Access(dataDir, { now });
const audit = new Audit(dataDir);
access.migrateRooms(db.rooms, { canJoinRoom: (r) => !r.archived });
eventSync = makeEventSync({ db, journal });
eventSync.migrate();
save();
const gate = makeEventGate({ access, db });

function safeError(message, a) {
  const token = a?.tokenEnv && process.env[a.tokenEnv];
  return token ? message.replaceAll(token, "[redacted]") : message;
}

const app = express();
const port = Number(process.env.PORT || 4317);
const origin = `http://127.0.0.1:${port}`;
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be 1–65535.");

function authorized(req) {
  return access.owner(req) || !!access.manager(req, { touch: false });
}

function participants() {
  return [
    ...db.agents.map((a) => ({ ...a, kind: "endpoint" })),
    ...access.db.accounts
      .filter((a) => !a.revoked && a.expiresAt > now())
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
    pendingRequests: access.list().requests.length,
    headless,
    agentOrigin: process.env.A2AHUB_PUBLIC_URL || origin,
    inboundConnections: access.db.accounts
      .filter((a) => !a.revoked && a.expiresAt > now())
      .map(({ id, name, roomId }) => ({ id, name, roomId })),
  };
}

function publish() {
  save();
  closeExpiredClients();
  sse?.sweep();
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

const broker = new DispatchBroker({
  isAuthorized: (accountId, roomId) =>
    access.canAccess(accountId, roomId) &&
    !!db.rooms.find(
      (r) => r.id === roomId && r.agentIds.includes(accountId) && !r.paused,
    ),
  onChange: publish,
  epoch: hubEpoch,
  journal,
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

const onPost = (room, message) => chat.relayPost(room, message);

sse = makeMountSseEvents({ gate, journal });
const { mountSseEvents } = sse;

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

// Shared helpers used across route modules.
const getRoom = makeGetRoom(db);
const activeRoom = makeActiveRoom(db, getRoom);
const validateFolder = makeValidateFolder(db);
const folderFields = makeFolderFields(FOLDER_COLORS);
const validateMembers = makeValidateMembers(participants);
const updateRoom = makeUpdateRoom({
  chat,
  access,
  broker,
  validateMembers,
  eventSync,
  sse,
});

function ownerOnly(req) {
  if (req.actor?.kind !== "owner")
    throw Object.assign(
      new Error("Sign in to the web interface as the owner to do this."),
      { status: 403 },
    );
}
const actor = (req) => req.actor?.label || "owner";

// Scope a manager token needs for an owner API route. Reads need "read";
// conversation work needs "chat"; everything else (access, agents, admin,
// profile) needs "admin". Some routes additionally require the owner session.
function requiredScope(req) {
  // Express matches routes case-insensitively and tolerates repeated or
  // encoded slashes, so classify a normalized path, never the raw one.
  let route = req.path;
  try {
    route = decodeURIComponent(route);
  } catch {
    return "admin"; // Malformed escapes get the strictest scope.
  }
  route = route.toLowerCase().replace(/\/{2,}/g, "/");
  if (req.method === "GET")
    return /^\/(admin|access|manager-tokens)(\/|$)/.test(route)
      ? "admin"
      : "read";
  return /^\/(rooms|runs|folders)(\/|$)/.test(route) ? "chat" : "admin";
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

// Access routes live in index.js because they predate the /api auth middleware
// splitting and share the /api/access path. They're small and scoped here.
app.get("/api/access", (req, res) => res.json(access.list()));
app.post("/api/access/:id/decision", (req, res) => {
  if (typeof req.body.approved !== "boolean")
    throw new Error("Choose Approve or Deny.");
  if (req.body.roomId && !db.rooms.some((r) => r.id === req.body.roomId))
    throw new Error("Conversation not found.");
  if (db.rooms.find((r) => r.id === req.body.roomId)?.archived)
    throw new Error("That conversation is archived. Restore it first.");
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
  for (const r of db.rooms) {
    r.agentIds = r.agentIds.filter((id) => id !== req.params.id);
    eventSync.end(r, req.params.id);
  }
  sse.closeFor(req.params.id);
  broker.invalidate(req.params.id);
  publish();
  res.json({ ok: true });
});

// Shared context for route modules.
const routeCtx = {
  app,
  db,
  save,
  access,
  audit,
  broker,
  chat,
  journal,
  eventSync,
  gate,
  sse,
  clients,
  publish,
  snapshot,
  participants,
  onPost,
  origin,
  version,
  startedAt,
  headless,
  authorized,
  ownerOnly,
  actor,
  getRoom,
  activeRoom,
  validateMembers,
  validateFolder,
  folderFields,
  updateRoom,
  safeError,
  dataDir,
  file,
  port,
  createRoom,
  mountInbound,
  mountSseEvents,
  closeExpiredClients,
};

mountAuthRoutes(routeCtx);
mountSseEvents(app);
mountInbound(app, { access, db, publish, origin, broker, onPost, journal, gate });
mountStateRoutes(routeCtx);
mountRoomRoutes(routeCtx);
mountFolderRoutes(routeCtx);
mountAgentRoutes(routeCtx);
mountChatRoutes(routeCtx);
mountAdminRoutes(routeCtx);

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

mountAgentListener({ ...routeCtx, port });

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

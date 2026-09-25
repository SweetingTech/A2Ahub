import express from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discover, send, cancel } from "./protocol.js";
import { GroupChat } from "./chat.js";
import { Access } from "./access.js";
import { mountInbound } from "./inbound.js";
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
for (const r of db.rooms) {
  // Existing rooms gain explicit membership without exposing old transcripts.
  r.agentIds ??= [];
  r.agentChat ??= false;
  r.replyLimit ??= 6;
  r.paused ??= false;
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
const clients = new Set();
const chat = new GroupChat({ send, cancel, publish, redact: safeError });
function snapshot() {
  return {
    ...db,
    runs: chat.snapshot(),
    inboundConnections: access.db.accounts
      .filter((a) => !a.revoked && a.expiresAt > Date.now())
      .map(({ id, name, roomId }) => ({ id, name, roomId })),
  };
}
function publish() {
  save();
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const c of clients) c.write(payload);
}
const app = express();
const port = Number(process.env.PORT || 4317);
const origin = `http://127.0.0.1:${port}`;
const access = new Access(dataDir);
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
app.post("/auth/device", (req, res) =>
  res
    .status(201)
    .json(access.request(req.body.name, origin, req.socket.remoteAddress)),
);
app.post("/auth/token", (req, res) =>
  res.json(access.poll(req.body.device_code)),
);
app.use("/auth", (err, req, res, next) =>
  res.status(err.status || 400).json({ error: err.message }),
);
mountInbound(app, { access, db, publish, origin });
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
  publish();
  res.json({ ok: true });
});
app.get("/api/state", (req, res) => res.json(snapshot()));
app.get("/api/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  clients.add(res);
  res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  const t = setInterval(() => res.write(": keepalive\n\n"), 20000);
  req.on("close", () => {
    clearInterval(t);
    clients.delete(res);
  });
});
app.post("/api/rooms", (req, res) => {
  const r = room();
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
  const agents = ids.map((id) => db.agents.find((a) => a.id === id));
  if (agents.some((a) => !a)) throw new Error("Agent not found.");
  return agents;
}
app.patch("/api/rooms/:id", (req, res) => {
  const r = getRoom(req.params.id);
  if (chat.active(r.id).length)
    throw new Error(
      "Stop agents before changing chat membership or reply settings.",
    );
  const {
    agentIds = r.agentIds,
    agentChat = r.agentChat,
    replyLimit = r.replyLimit,
  } = req.body;
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
  Object.assign(r, { agentIds, agentChat, replyLimit });
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
  const inbound = access.db.accounts.some(
    (a) => a.roomId === r.id && !a.revoked && a.expiresAt > Date.now(),
  );
  const agents = validateMembers(r.agentIds, inbound);
  if (!agents.length) {
    if (r.paused) throw new Error("Agents are paused. Resume before sending.");
    r.messages.push({
      id: randomUUID(),
      role: "user",
      name: "You",
      text: text.trim(),
      state: "sent",
      createdAt: new Date().toISOString(),
    });
    if (r.messages.length === 1) r.title = text.trim().slice(0, 45);
    publish();
    return res.status(202).json({ id: null });
  }
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

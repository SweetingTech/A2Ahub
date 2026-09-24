import express from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discover, send, cancel } from "./protocol.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.A2AHUB_DATA_DIR || path.join(root, "data");
fs.mkdirSync(dataDir, { recursive: true });
const file = path.join(dataDir, "workspace.json");
const room = () => ({
  id: randomUUID(),
  title: "Shared workspace",
  messages: [],
  contexts: {},
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
const runs = new Map(),
  clients = new Set();
function snapshot() {
  return {
    ...db,
    runs: [...runs.values()].map(
      ({ id, roomId, state, turn, maxTurns, agentId, stopNote }) => ({
        id,
        roomId,
        state,
        turn,
        maxTurns,
        agentId,
        stopNote,
      }),
    ),
  };
}
function publish() {
  save();
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const c of clients) c.write(payload);
}
const app = express();
const port = Number(process.env.PORT || 4317);
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
app.delete("/api/agents/:id", (req, res) => {
  if (
    [...runs.values()].some(
      (r) =>
        ["running", "stopping"].includes(r.state) &&
        r.agentIds.includes(req.params.id),
    )
  )
    throw new Error("Stop the active conversation before removing this agent.");
  db.agents = db.agents.filter((a) => a.id !== req.params.id);
  publish();
  res.json({ ok: true });
});
async function stopRun(run, reason = "Stopped by you") {
  if (run.state !== "running") return;
  run.state = "stopping";
  run.stopNote = reason;
  publish();
  const remote =
    run.taskId && run.agentId
      ? db.agents.find((a) => a.id === run.agentId)
      : null;
  run.controller.abort();
  let canceled = false;
  if (remote)
    try {
      canceled = await cancel(remote, run.taskId);
    } catch {}
  run.stopNote =
    reason +
    ". " +
    (canceled
      ? "Remote task cancellation accepted."
      : "Further turns stopped. Remote work may continue; cancellation was not confirmed.");
  run.state = "stopped";
  publish();
}
app.post("/api/runs/:id/stop", async (req, res) => {
  const r = runs.get(req.params.id);
  if (!r) return res.sendStatus(404);
  await stopRun(r);
  res.json({ ok: true });
});
app.post("/api/runs", (req, res) => {
  const { roomId, agentIds, text, relay, maxTurns } = req.body;
  const r = db.rooms.find((r) => r.id === roomId);
  if (!r) throw new Error("Conversation not found.");
  if ([...runs.values()].some((x) => ["running", "stopping"].includes(x.state)))
    throw new Error(
      "A conversation is already running. Stop it or wait for it to finish.",
    );
  if (typeof text !== "string" || !text.trim() || text.length > 12000)
    throw new Error("Enter a message of 1–12,000 characters.");
  if (
    !Array.isArray(agentIds) ||
    !agentIds.length ||
    agentIds.length > 6 ||
    new Set(agentIds).size !== agentIds.length
  )
    throw new Error("Choose 1–6 distinct recipients.");
  const agents = agentIds.map((id) => db.agents.find((a) => a.id === id));
  if (agents.some((a) => !a || a.status !== "connected"))
    throw new Error("Check the selected agents’ connections first.");
  if (
    relay &&
    (agents.length < 2 ||
      !Number.isInteger(maxTurns) ||
      maxTurns < 2 ||
      maxTurns > 6)
  )
    throw new Error(
      "Agent conversations need at least 2 agents and a limit of 2–6 total replies.",
    );
  const run = {
    id: randomUUID(),
    roomId,
    agentIds,
    state: "running",
    turn: 0,
    maxTurns: relay ? maxTurns : agents.length,
    controller: new AbortController(),
  };
  runs.set(run.id, run);
  r.messages.push({
    id: randomUUID(),
    role: "user",
    name: "You",
    text: text.trim(),
    recipients: agents.map((a) => a.name),
    createdAt: new Date().toISOString(),
    state: "sent",
  });
  if (r.messages.length === 1) r.title = text.trim().slice(0, 45);
  publish();
  res.status(202).json({ id: run.id });
  void execute(run, r, agents, text.trim(), !!relay);
});
async function execute(run, r, agents, original, relay) {
  let previous = "";
  try {
    for (let i = 0; i < run.maxTurns; i++) {
      if (run.state !== "running") break;
      const a = agents[i % agents.length];
      run.turn = i + 1;
      run.agentId = a.id;
      run.taskId = null;
      const m = {
        id: randomUUID(),
        role: "agent",
        agentId: a.id,
        name: a.name,
        text: "",
        state: "working",
        createdAt: new Date().toISOString(),
        turn: i + 1,
      };
      r.messages.push(m);
      publish();
      const prompt = relay
        ? `Shared conversation. This is turn ${i + 1} of at most ${run.maxTurns}. Reply directly and concisely. Do not independently contact other agents or start background work.\nUser: ${original}${previous ? `\nPrevious agent (${agents[(i - 1) % agents.length].name}): ${previous.slice(0, 16000)}` : ""}`
        : original;
      const timeout = setTimeout(
        () => void stopRun(run, "Response timed out after 180 seconds"),
        180000,
      );
      try {
        const result = await send(
          a,
          prompt,
          r.contexts[a.id],
          run.controller.signal,
          (delta) => {
            if (run.state !== "running") return;
            Object.assign(m, delta, { text: safeError(delta.text, a) });
            run.taskId = delta.taskId;
            publish();
          },
        );
        Object.assign(m, result, { text: safeError(result.text, a) });
        r.contexts[a.id] = {
          contextId: result.contextId,
          ...(result.state === "input-required"
            ? { taskId: result.taskId }
            : {}),
        };
        previous = m.text;
        publish();
        if (result.state !== "completed") {
          run.state = result.state;
          break;
        }
      } catch (e) {
        m.state = run.controller.signal.aborted ? "stopped" : "error";
        m.text =
          m.text ||
          (run.controller.signal.aborted
            ? "Request stopped."
            : safeError(e.message, a));
        if (!run.controller.signal.aborted) run.state = "error";
        publish();
        break;
      } finally {
        clearTimeout(timeout);
      }
    }
  } finally {
    if (run.state === "running") run.state = "completed";
    publish();
  }
}
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

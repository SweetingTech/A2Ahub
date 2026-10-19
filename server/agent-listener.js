import express from "express";

// Remote agent listener: a deliberately narrow listener that never mounts
// owner routes. The configured public origin is explicit so neither Host nor
// proxy headers can rewrite approval links or the authenticated A2A endpoint
// advertised by the card.
export function mountAgentListener(ctx) {
  const {
    access,
    db,
    publish,
    broker,
    chat,
    audit,
    journal,
    gate,
    origin,
    onPost,
    mountInbound,
    mountSseEvents,
    port,
  } = ctx;

  if (!process.env.A2AHUB_AGENT_PORT) return;

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
    publish();
    res.status(201).json(request);
  });
  remote.post("/auth/token", (req, res) => {
    const credential = access.poll(req.body.device_code, {
      rooms: db.rooms,
      canJoinRoom: (room) => !room.archived && !chat.active(room.id).length,
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
    journal,
    gate,
  });
  mountSseEvents(remote);
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

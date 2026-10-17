import fs from "node:fs";

// Auth routes: session check, login, logout, device flow, token polling.
// Mounted under /auth. Manager-token scope is not enforced here; /api handles it.
export function mountAuthRoutes(ctx) {
  const { app, db, access, audit, origin, publish, closeExpiredClients, chat } =
    ctx;

  app.get("/auth/session", (req, res) =>
    res.json({
      authenticated: access.owner(req),
      passwordLocation: fs.existsSync(access.passwordFile)
        ? access.passwordFile
        : null,
      headless: ctx.headless,
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
        `a2ahub_owner=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
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
    publish();
    res.status(201).json(request);
  });

  app.post("/auth/token", (req, res) => {
    const credential = access.poll(req.body.device_code, {
      rooms: db.rooms,
      canJoinRoom: (room) => !room.archived && !chat.active(room.id).length,
    });
    publish();
    res.json(credential);
  });

  app.use("/auth", (err, req, res, next) =>
    res.status(err.status || 400).json({ error: err.message }),
  );
}

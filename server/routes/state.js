// State, profile, and events SSE routes under /api.
// GET /api/state returns a full snapshot; GET /api/events opens the owner SSE.
export function mountStateRoutes(ctx) {
  const { app, db, snapshot, clients, authorized, publish } = ctx;

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
}

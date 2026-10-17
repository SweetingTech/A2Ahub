// Chat/run routes under /api: stop, resume, continue a room's discussion, plus
// start new runs (POST /api/runs, POST /api/rooms/:id/messages) and stop a run
// by id. Membership validation reuses the shared validateMembers helper.
export function mountChatRoutes(ctx) {
  const {
    app,
    db,
    publish,
    audit,
    chat,
    actor,
    getRoom,
    activeRoom,
    validateMembers,
  } = ctx;

  app.patch("/api/rooms/:id", (req, res) => {
    const r = getRoom(req.params.id);
    // Filing and pinning never touch membership, so they work during a burst.
    const { folderId, pinned, ...settings } = req.body || {};
    if (folderId !== undefined) {
      const { validateFolder } = ctx;
      validateFolder(folderId);
    }
    if (pinned !== undefined && typeof pinned !== "boolean")
      throw new Error("Pinned must be true or false.");
    if (Object.keys(settings).length) {
      if (r.archived && Object.keys(settings).some((k) => k !== "title"))
        throw new Error(
          "Restore this conversation before changing members or reply settings.",
        );
      const { updateRoom } = ctx;
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
    const { access, broker } = ctx;
    access.setRoomMembers(r, []);
    for (const id of r.agentIds) broker.invalidate(id, r.id);
    db.rooms = db.rooms.filter((x) => x !== r);
    audit.record("room.deleted", { actor: actor(req), room: r.title });
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
    const from = r.messages.length;
    const run = chat.start(r, agents, null);
    audit.record("room.continued", { actor: actor(req), room: r.title });
    // "from" is the first message index belonging to this burst, so watchers
    // can show every reply it produces.
    res.status(202).json({ id: run.id, from });
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
    const from = r.messages.length;
    const { threadId, inReplyTo } = req.body || {};
    const run = chat.start(r, agents, text.trim(), {
      ...(typeof threadId === "string" && threadId
        ? { threadId: threadId.slice(0, 160) }
        : {}),
      ...(typeof inReplyTo === "string" && inReplyTo
        ? { inReplyTo: inReplyTo.slice(0, 160) }
        : {}),
    });
    if (req.actor?.kind === "manager")
      audit.record("room.message", { actor: actor(req), room: r.title });
    res.status(202).json({ id: run.id, from });
  }

  app.post("/api/runs", (req, res) =>
    startMessage(req, res, req.body?.roomId, req.body?.text),
  );

  app.post("/api/rooms/:id/messages", (req, res) =>
    startMessage(req, res, req.params.id, req.body?.text),
  );
}

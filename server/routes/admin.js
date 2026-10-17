import fs from "node:fs";
import path from "node:path";

// Admin routes under /api: dashboard summary, audit log, stop-all, backup,
// export, password change, session revocation, and manager-token CRUD.
function attention(ctx) {
  const { access, participants } = ctx;
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

function backups(ctx) {
  const dir = path.join(ctx.dataDir, "backups");
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

function exportWorkspace(ctx) {
  // workspace.json never contains credential values; access.json is excluded.
  return { exportedAt: new Date().toISOString(), version: ctx.version, workspace: ctx.db };
}

export function mountAdminRoutes(ctx) {
  const {
    app,
    db,
    access,
    audit,
    broker,
    chat,
    participants,
    actor,
    ownerOnly,
    closeExpiredClients,
    dataDir,
    file,
    origin,
    port,
    version,
    startedAt,
    headless,
  } = ctx;

  app.get("/api/admin", (req, res) => {
    const people = participants();
    const list = backups({ dataDir });
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
      attention: attention({ access, participants }),
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
    // Seal ALL non-archived rooms, including settled ones with unspent allowance.
    // Late posts, streams, and completion reports must not restart agent work.
    const rooms = db.rooms.filter((r) => !r.archived);
    await Promise.all(rooms.map((r) => chat.stop(r)));
    // Invalidate all dispatch generations so late completion reports are rejected.
    for (const r of rooms) broker.invalidateGeneration(r.id);
    audit.record("admin.stop_all", { actor: actor(req), rooms: rooms.length });
    res.json({ ok: true, stopped: rooms.map((r) => r.id) });
  });

  app.post("/api/admin/backup", (req, res) => {
    const dir = path.join(dataDir, "backups");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = path.join(dir, `workspace-${stamp}.json`);
    fs.writeFileSync(target + ".tmp", JSON.stringify(exportWorkspace({ version, db }), null, 2));
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
      .json(exportWorkspace({ version, db }));
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
}

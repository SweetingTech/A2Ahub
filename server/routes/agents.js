import { randomUUID } from "node:crypto";

// Agent routes under /api: remove an agent (after stopping active chats).
// Agent add/check live in rooms.js because they share the /api/agents path
// ordering with the listing route; removal is separate and id-scoped.
export function mountAgentRoutes(ctx) {
  const { app, db, publish, access, audit, chat, actor } = ctx;

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
}

// Re-exported so index.js doesn't need to import randomUUID for the UUID-only
// fallback path (folders.js uses the shared crypto import too).
export { randomUUID };

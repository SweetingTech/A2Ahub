// Authenticated SSE notification stream for agents: push-based event delivery
// so listeners don't need to poll. Each event is sent as an SSE data frame
// with the event type. The stream is scoped to rooms the agent can access.
// Used by both the owner listener and the remote agent listener.
export function makeMountSseEvents({ access, db, journal }) {
  return function mountSseEvents(expressApp) {
    expressApp.get("/a2a/events", (req, res) => {
      let account;
      try {
        account = access.authenticate(req.headers.authorization);
      } catch (e) {
        return res.status(e.status || 401).json({ error: e.message });
      }
      res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.flushHeaders();
      const cursorParam = Number(req.query.cursor || 0);
      const unsubscribers = [];
      // Track the last seq delivered per room so live events don't
      // duplicate what catch-up already sent.
      const lastDelivered = new Map();
      for (const room of db.rooms) {
        if (!access.canAccess(account.id, room.id) || !room.agentIds?.includes(account.id))
          continue;
        const inAudience = (e) =>
          !e.audience || e.audience.includes(account.id) || e.senderId === account.id;
        const memberSince = room.memberSince?.[account.id] || 0;
        const startIndex = account.bindings[room.id] || 0;
        // Cursor catch-up: replay missed events from the journal before
        // transitioning to live delivery. This is race-free because the
        // journal subscription is registered before catch-up reads finish.
        const catchUp = journal.read(room.id, cursorParam, { maxBatch: 500 });
        if (catchUp.resyncRequired) {
          res.write(`event: resync-required\ndata: ${JSON.stringify({
            roomId: room.id,
            oldestSeq: catchUp.oldestSeq,
          })}\n\n`);
        } else {
          for (const entry of catchUp.events) {
            if (entry.seq <= startIndex || entry.seq <= memberSince || !inAudience(entry))
              continue;
            res.write(`event: ${entry.type}\n`);
            res.write(`data: ${JSON.stringify({
              eventId: entry.eventId,
              type: entry.type,
              roomId: entry.roomId,
              seq: entry.seq,
              messageId: entry.messageId,
              senderId: entry.senderId,
              senderName: entry.senderName,
              createdAt: entry.createdAt,
              payload: entry.payload,
            })}\n\n`);
          }
        }
        const lastSeq = catchUp.events.length
          ? catchUp.events[catchUp.events.length - 1].seq
          : cursorParam;
        lastDelivered.set(room.id, lastSeq);
        // Live subscription: only deliver events newer than what catch-up sent.
        unsubscribers.push(
          journal.subscribe(room.id, (entry) => {
            const last = lastDelivered.get(room.id) || 0;
            if (entry.seq <= last) return;
            if (entry.seq <= startIndex || entry.seq <= memberSince || !inAudience(entry))
              return;
            lastDelivered.set(room.id, entry.seq);
            res.write(`event: ${entry.type}\n`);
            res.write(`data: ${JSON.stringify({
              eventId: entry.eventId,
              type: entry.type,
              roomId: entry.roomId,
              seq: entry.seq,
              messageId: entry.messageId,
              senderId: entry.senderId,
              senderName: entry.senderName,
              createdAt: entry.createdAt,
              payload: entry.payload,
            })}\n\n`);
          }),
        );
      }
      res.write(`event: ready\ndata: ${JSON.stringify({ account: account.id })}\n\n`);
      const keepalive = setInterval(() => {
        try {
          access.authenticate(req.headers.authorization);
          res.write(": keepalive\n\n");
        } catch {
          res.write("event: auth-expired\ndata: {}\n\n");
          res.end();
        }
      }, 20000);
      req.on("close", () => {
        clearInterval(keepalive);
        for (const unsub of unsubscribers) unsub();
      });
    });
  };
}

import { CursorError, parseCursor } from "./events.js";
import { publicEvent } from "./event-access.js";

export const SSE_VERSION = 2;
const PAGE = 200;
const MAX_PENDING = 1000;
const KEEPALIVE_MS = 20000;

function parseLastEventId(value, roomId) {
  if (!value) return null;
  const at = String(value).lastIndexOf(":");
  if (at < 0 || String(value).slice(0, at) !== roomId)
    throw new CursorError(400, "Last-Event-ID belongs to a different conversation.");
  return parseCursor(String(value).slice(at + 1), { fallback: NaN });
}

// Single-room, resumable event stream for agents. The cursor is a journal
// sequence (never a transcript index). Replay pages to a high-water mark
// captured before reading, while live events are buffered so the handoff is
// gap-free. Every frame re-checks the shared policy before it is written.
export function makeMountSseEvents({ gate, journal }) {
  const streams = new Set();

  function closeFor(accountId, roomId) {
    for (const s of streams)
      if (s.accountId === accountId && (!roomId || s.roomId === roomId))
        s.close("access-ended");
  }

  // Called after every owner-visible change (archive, removal, expiry).
  function sweep() {
    for (const s of streams)
      if (!gate.stillAuthorized(s.authorization, s.roomId, s.incarnation))
        s.close("access-ended");
  }

  function mountSseEvents(expressApp) {
    expressApp.get("/a2a/v2/events", async (req, res) => {
      const authorization = req.headers.authorization;
      const roomId = String(req.query.roomId || "");
      let ctx;
      let start;
      let highWater;
      try {
        if (!roomId) throw new CursorError(400, "roomId is required.");
        ctx = gate.authorize(authorization, roomId);
        const fromHeader = parseLastEventId(req.headers["last-event-id"], roomId);
        const requested =
          fromHeader ?? parseCursor(req.query.cursor, { fallback: NaN });
        if (Number.isNaN(requested)) throw new CursorError(400, "Invalid event cursor.");
        start = gate.startCursor(requested, ctx.grant);
        highWater = journal.latestSeq(roomId);
        const probe = journal.read(roomId, start, { maxBatch: 1, until: highWater });
        if (probe.resyncRequired)
          throw new CursorError(410, "Event cursor has expired.", {
            oldestSeq: probe.oldestSeq,
            latestSeq: probe.latestSeq,
          });
      } catch (e) {
        const status = e.status || 401;
        const body = { error: e.message };
        if (e.oldestSeq !== undefined) body.oldestSeq = e.oldestSeq;
        if (e.latestSeq !== undefined) body.latestSeq = e.latestSeq;
        return res.status(status).json(body);
      }

      const { account, grant } = ctx;
      const incarnation = grant.incarnation;
      const live = [];
      let closed = false;
      let cursor = start;
      let wake = null;

      const stream = {
        accountId: account.id,
        roomId,
        authorization,
        incarnation,
        close(reason) {
          if (closed) return;
          closed = true;
          if (reason && !res.writableEnded) {
            try {
              res.write(`event: closed\ndata: ${JSON.stringify({ reason, cursor })}\n\n`);
            } catch (e) {
              console.error("A2Ahub event stream close failed:", e.message);
            }
          }
          res.end();
          wake?.();
        },
      };
      streams.add(stream);

      const unsubscribe = journal.subscribe(roomId, (entry) => {
        if (closed) return;
        if (live.length >= MAX_PENDING) return stream.close("overflow");
        live.push(entry);
        wake?.();
      });

      const keepalive = setInterval(() => {
        if (!gate.stillAuthorized(authorization, roomId, incarnation))
          return stream.close("access-ended");
        if (res.writableLength === 0) res.write(": keepalive\n\n");
      }, KEEPALIVE_MS);

      req.on("close", () => {
        closed = true;
        wake?.();
      });

      const drained = () =>
        new Promise((resolve) => {
          const done = () => {
            res.off("drain", done);
            res.off("close", done);
            resolve();
          };
          res.once("drain", done);
          res.once("close", done);
        });

      async function emit(entry) {
        if (entry.seq <= cursor) return true;
        if (!gate.stillAuthorized(authorization, roomId, incarnation)) {
          stream.close("access-ended");
          return false;
        }
        cursor = entry.seq;
        if (!gate.visible(entry, account.id, grant)) return true;
        const frame =
          `id: ${roomId}:${entry.seq}\nevent: ${entry.type}\n` +
          `data: ${JSON.stringify(publicEvent(entry))}\n\n`;
        if (!res.write(frame)) await drained();
        return !closed;
      }

      res.status(200).set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      res.write(
        `event: hello\ndata: ${JSON.stringify({ version: SSE_VERSION, roomId, cursor: start, highWater })}\n\n`,
      );

      try {
        while (!closed && cursor < highWater) {
          const page = journal.read(roomId, cursor, { maxBatch: PAGE, until: highWater });
          if (page.resyncRequired) {
            stream.close("cursor-expired");
            break;
          }
          if (!page.events.length) {
            cursor = highWater;
            break;
          }
          for (const entry of page.events) if (!(await emit(entry))) break;
        }
        if (!closed) {
          res.write(
            `id: ${roomId}:${cursor}\nevent: ready\ndata: ${JSON.stringify({ cursor })}\n\n`,
          );
        }
        while (!closed) {
          if (!live.length) {
            await new Promise((resolve) => (wake = resolve));
            wake = null;
            continue;
          }
          if (!(await emit(live.shift()))) break;
        }
      } catch (e) {
        console.error("A2Ahub event stream failed:", e.message);
        stream.close("error");
      } finally {
        closed = true;
        clearInterval(keepalive);
        unsubscribe();
        streams.delete(stream);
        if (!res.writableEnded) res.end();
      }
    });
  }

  return { mountSseEvents, closeFor, sweep };
}

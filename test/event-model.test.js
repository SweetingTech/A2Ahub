import test from "node:test";
import assert from "node:assert/strict";
import { EventJournal } from "../server/events.js";
import { makeEventSync } from "../server/event-sync.js";
import { makeEventGate } from "../server/event-access.js";

function setup({ messages = [], agentIds = ["a"], persist } = {}) {
  const room = { id: "r1", agentIds: [...agentIds], messages, archived: false };
  const db = { rooms: [room] };
  const revoked = new Set();
  const access = {
    authenticate(auth) {
      if (revoked.has(auth)) throw Object.assign(new Error("revoked"), { status: 401 });
      return { id: auth };
    },
    canAccess: (id) => !revoked.has(id),
  };
  const journal = new EventJournal({ persist });
  const sync = makeEventSync({ db, journal });
  const gate = makeEventGate({ access, db });
  return { room, db, journal, sync, gate, revoked };
}

function say(room, id, extra = {}) {
  const m = { id, role: "user", text: id, state: "sent", recipientIds: [...room.agentIds], ...extra };
  room.messages.push(m);
  return m;
}

function visibleTo(ctx, accountId) {
  const { grant } = ctx.gate.authorize(accountId, "r1");
  return ctx.journal
    .read("r1", ctx.gate.startCursor(0, grant), { maxBatch: 10000 })
    .events.filter((e) => ctx.gate.visible(e, accountId, grant))
    .map((e) => e.messageId);
}

test("migrating 1,000 transcript messages with an empty journal delivers the first new event", () => {
  const messages = Array.from({ length: 1000 }, (_, i) => ({
    id: `old${i}`, role: "user", text: `old ${i}`, state: "sent", recipientIds: ["a"],
  }));
  const ctx = setup({ messages });
  ctx.sync.migrate();
  assert.equal(ctx.journal.latestSeq("r1"), 0);
  assert.equal(ctx.room.eventSince.a.seq, 0);
  say(ctx.room, "new");
  ctx.sync.sync();
  assert.equal(ctx.journal.latestSeq("r1"), 1);
  assert.deepEqual(visibleTo(ctx, "a"), ["new"]);
});

test("pre-join history is hidden and a re-added member cannot recover prior-grant history", () => {
  const ctx = setup();
  ctx.sync.migrate();
  say(ctx.room, "before-b");
  ctx.sync.sync();
  ctx.room.agentIds.push("b");
  ctx.sync.grant(ctx.room, "b");
  say(ctx.room, "with-b");
  ctx.sync.sync();
  assert.deepEqual(visibleTo(ctx, "b"), ["with-b"]);
  const first = ctx.room.eventSince.b.incarnation;

  ctx.room.agentIds = ["a"];
  ctx.sync.end(ctx.room, "b");
  assert.throws(() => ctx.gate.authorize("b", "r1"), (e) => e.status === 403);
  say(ctx.room, "while-removed");
  ctx.sync.sync();

  ctx.room.agentIds.push("b");
  ctx.sync.grant(ctx.room, "b");
  assert.notEqual(ctx.room.eventSince.b.incarnation, first);
  assert.deepEqual(visibleTo(ctx, "b"), []);
  assert.equal(ctx.journal.getCursor("b", "r1", ctx.room.eventSince.b.incarnation), 0);
});

test("a revision keeps its message's original visibility", () => {
  const ctx = setup();
  ctx.sync.migrate();
  const reply = say(ctx.room, "reply", { role: "agent", agentId: "a", shared: true, state: "working", text: "" });
  ctx.sync.sync();
  ctx.room.agentIds.push("b");
  ctx.sync.grant(ctx.room, "b");
  Object.assign(reply, { state: "completed", text: "final" });
  ctx.sync.sync();
  const events = ctx.journal.read("r1", 0).events.filter((e) => e.messageId === "reply");
  assert.equal(events.length, 2);
  assert.equal(events[1].originSeq, events[0].seq);
  assert.deepEqual(visibleTo(ctx, "b"), []);
  assert.deepEqual(visibleTo(ctx, "a"), ["reply", "reply"]);
});

test("private agent replies reach only their author; other audiences stay separate", () => {
  const ctx = setup({ agentIds: ["a", "b"] });
  ctx.sync.migrate();
  say(ctx.room, "private", { role: "agent", agentId: "a", shared: false, state: "completed" });
  say(ctx.room, "to-b", { recipientIds: ["b"] });
  ctx.sync.sync();
  assert.deepEqual(visibleTo(ctx, "a"), ["private"]);
  assert.deepEqual(visibleTo(ctx, "b"), ["to-b"]);
});

test("revoked, archived and expired access is denied on every check", () => {
  const ctx = setup();
  ctx.sync.migrate();
  const { grant } = ctx.gate.authorize("a", "r1");
  assert.equal(ctx.gate.stillAuthorized("a", "r1", grant.incarnation), true);
  ctx.room.archived = true;
  assert.equal(ctx.gate.stillAuthorized("a", "r1", grant.incarnation), false);
  ctx.room.archived = false;
  ctx.revoked.add("a");
  assert.equal(ctx.gate.stillAuthorized("a", "r1", grant.incarnation), false);
});

test("paused rooms remain readable", () => {
  const ctx = setup();
  ctx.sync.migrate();
  ctx.room.paused = true;
  say(ctx.room, "m1");
  ctx.sync.sync();
  assert.deepEqual(visibleTo(ctx, "a"), ["m1"]);
});

test("a failed journal write rolls back and the next save replays the event", () => {
  let fail = false;
  const ctx = setup({ persist: () => { if (fail) throw new Error("disk full"); } });
  ctx.sync.migrate();
  say(ctx.room, "m1");
  fail = true;
  assert.throws(() => ctx.sync.sync(), /disk full/);
  assert.equal(ctx.journal.latestSeq("r1"), 0);
  assert.equal(ctx.journal.read("r1", 0).events.length, 0);
  assert.throws(() => ctx.journal.acknowledge("a", "r1", 1, 1), (e) => e.status === 400);
  fail = false;
  ctx.sync.sync();
  assert.deepEqual(visibleTo(ctx, "a"), ["m1"]);
});

test("high-water mark and trim boundary survive trimming and restart", () => {
  const ctx = setup();
  ctx.sync.migrate();
  ctx.journal.maxEvents = 3;
  for (let i = 0; i < 6; i++) say(ctx.room, `m${i}`);
  ctx.sync.sync();
  const restored = EventJournal.fromJSON(JSON.parse(JSON.stringify(ctx.journal.toJSON())));
  assert.equal(restored.latestSeq("r1"), 6);
  assert.equal(restored.read("r1", 1).resyncRequired, true);
  assert.equal(restored.read("r1", 3).events.length, 3);
  assert.throws(() => restored.read("r1", 7), (e) => e.status === 400);
  restored.append({ type: "message.created", roomId: "r1" });
  assert.equal(restored.latestSeq("r1"), 7);
});

test("acknowledgments persist before success and roll back on failure", () => {
  let fail = false;
  const writes = [];
  const journal = new EventJournal({
    persist: (j) => {
      if (fail) throw new Error("write failed");
      writes.push(j.getCursor("a", "r1", 1));
    },
  });
  journal.append({ type: "message.created", roomId: "r1" });
  journal.append({ type: "message.created", roomId: "r1" });
  assert.equal(journal.acknowledge("a", "r1", 1, 1).acknowledged, 1);
  assert.equal(writes.at(-1), 1);
  fail = true;
  assert.throws(() => journal.acknowledge("a", "r1", 1, 2), /write failed/);
  assert.equal(journal.getCursor("a", "r1", 1), 1);
});

test("receipts are bound to the reporting account", () => {
  const journal = new EventJournal();
  journal.recordCompletion({ dispatchId: "d1", accountId: "a", roomId: "r1", text: "x" });
  assert.equal(journal.getCompletion("d1", "a").text, "x");
  assert.equal(journal.getCompletion("d1", "b"), null);
});

import test from "node:test";
import assert from "node:assert/strict";
import { EventJournal, messageEvent, digestContent, RETENTION_MS } from "../server/events.js";

test("EventJournal appends and reads events by room sequence cursor", () => {
  const j = new EventJournal({ now: () => 1000 });
  j.append({
    type: "message.created",
    roomId: "r1",
    messageId: "m1",
    senderId: "owner",
    audience: ["a", "b"],
  });
  j.append({
    type: "message.created",
    roomId: "r1",
    messageId: "m2",
    senderId: "a",
    audience: ["a", "b"],
  });
  const r = j.read("r1", 0);
  assert.equal(r.events.length, 2);
  assert.equal(r.events[0].messageId, "m1");
  assert.equal(r.events[1].messageId, "m2");
  assert.equal(r.nextCursor, 2);
  assert.equal(r.resyncRequired, false);
  const r2 = j.read("r1", 1);
  assert.equal(r2.events.length, 1);
  assert.equal(r2.events[0].messageId, "m2");
});

test("EventJournal deduplicates by eventId", () => {
  const j = new EventJournal();
  const e1 = j.append({ type: "message.created", roomId: "r1", messageId: "m1", eventId: "evt-1" });
  const e2 = j.append({ type: "message.created", roomId: "r1", messageId: "m1", eventId: "evt-1" });
  assert.equal(e1, e2);
  assert.equal(j.read("r1", 0).events.length, 1);
});

test("EventJournal returns resyncRequired when cursor points to expired event", () => {
  const j = new EventJournal({ now: () => 1000 });
  j.append({ type: "message.created", roomId: "r1", messageId: "m1" });
  j.retentionMs = 1;
  j.now = () => 999999999;
  j.trim();
  assert.equal(j.events.length, 0);
  j.retentionMs = RETENTION_MS;
  j.append({ type: "message.created", roomId: "r1", messageId: "m2" });
  assert.equal(j.events.length, 1);
  const r = j.read("r1", 1);
  assert.equal(r.resyncRequired, true);
  assert.equal(r.events.length, 0);
});

test("completion receipt is idempotent by content digest and rejects conflicts", () => {
  const j = new EventJournal();
  const r1 = j.recordCompletion({ dispatchId: "d1", text: "Hello", state: "completed" });
  assert.equal(r1.accepted, true);
  assert.equal(r1.duplicate, false);
  const r2 = j.recordCompletion({ dispatchId: "d1", text: "Hello", state: "completed" });
  assert.equal(r2.accepted, true);
  assert.equal(r2.duplicate, true);
  const r3 = j.recordCompletion({ dispatchId: "d1", text: "Different", state: "completed" });
  assert.equal(r3.accepted, false);
  assert.equal(r3.conflict, true);
});

test("completion receipt status query returns original receipt without regenerating", () => {
  const j = new EventJournal();
  j.recordCompletion({ dispatchId: "d1", text: "Answer", state: "completed", contextId: "c1", taskId: "t1" });
  const receipt = j.getCompletion("d1");
  assert.equal(receipt.text, "Answer");
  assert.equal(receipt.contextId, "c1");
  assert.equal(j.getCompletion("missing"), null);
});

test("per-recipient cursors track and acknowledge progress", () => {
  const j = new EventJournal();
  j.append({ type: "message.created", roomId: "r1", messageId: "m1" });
  j.append({ type: "message.created", roomId: "r1", messageId: "m2" });
  assert.equal(j.getCursor("agent-a", "r1"), 0);
  j.acknowledge("agent-a", "r1", 1);
  assert.equal(j.getCursor("agent-a", "r1"), 1);
  j.acknowledge("agent-a", "r1", 0);
  assert.equal(j.getCursor("agent-a", "r1"), 1);
});

test("EventJournal serializes and restores from JSON", () => {
  const j = new EventJournal();
  j.append({ type: "message.created", roomId: "r1", messageId: "m1" });
  j.recordCompletion({ dispatchId: "d1", text: "Reply", state: "completed" });
  j.acknowledge("a", "r1", 1);
  const restored = EventJournal.fromJSON(j.toJSON());
  assert.equal(restored.read("r1", 0).events.length, 1);
  assert.equal(restored.getCompletion("d1").text, "Reply");
  assert.equal(restored.getCursor("a", "r1"), 1);
});

test("messageEvent builds correct event type from message state", () => {
  const room = { id: "r1", agentIds: ["a", "b"], membershipGeneration: 1 };
  const created = messageEvent(
    { id: "m1", role: "user", name: "You", text: "Hi", state: "sent" },
    { room },
  );
  assert.equal(created.type, "message.created");
  assert.deepEqual(created.audience, ["a", "b"]);
  assert.equal(created.membershipGeneration, 1);
  const working = messageEvent(
    { id: "m2", role: "agent", name: "A", text: "", state: "working", agentId: "a" },
    { room },
  );
  assert.equal(working.type, "message.updated");
  const completed = messageEvent(
    { id: "m3", role: "agent", name: "A", text: "Done", state: "completed", agentId: "a" },
    { room },
  );
  assert.equal(completed.type, "message.completed");
});

test("slow reply does not hide later completed messages through event cursor", () => {
  const j = new EventJournal();
  const room = { id: "r1", agentIds: ["a", "b"] };
  // Simulate: human message, then a slow working reply, then a fast completed reply.
  j.append(messageEvent({ id: "h1", role: "user", name: "You", text: "Hello", state: "sent", recipientIds: ["a", "b"] }, { room }));
  j.append(messageEvent({ id: "slow", role: "agent", name: "A", text: "", state: "working", agentId: "a", recipientIds: ["a", "b"] }, { room }));
  j.append(messageEvent({ id: "fast", role: "agent", name: "B", text: "Quick answer", state: "completed", agentId: "b", recipientIds: ["a", "b"] }, { room }));
  // With the old numeric cursor, the slow working reply blocks at its index.
  // With the event cursor, the agent sees all three events, including the later completed one.
  const r = j.read("r1", 0);
  assert.equal(r.events.length, 3);
  // The fast completed message (seq 3) is visible despite the slow one (seq 2) being nonterminal.
  const completedEvents = r.events.filter((e) => e.type === "message.completed");
  assert.equal(completedEvents.length, 1);
  assert.equal(completedEvents[0].messageId, "fast");
  // Later, the slow reply completes — that event also arrives.
  j.append(messageEvent({ id: "slow", role: "agent", name: "A", text: "Finally done", state: "completed", agentId: "a", recipientIds: ["a", "b"], revision: 2 }, { room }));
  const r2 = j.read("r1", r.nextCursor);
  assert.equal(r2.events.length, 1);
  assert.equal(r2.events[0].type, "message.completed");
  assert.equal(r2.events[0].messageId, "slow");
});

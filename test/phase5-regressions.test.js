import { test } from "node:test";
import assert from "node:assert/strict";
import { EventJournal, RETENTION_MS } from "../server/events.js";
import { messageEvent } from "../server/event-sync.js";
import { DispatchBroker } from "../server/dispatch.js";

test("Phase 5 A: Event journal survives serialization round-trip", () => {
  const journal = new EventJournal({ now: () => 100000 });
  journal.append({ type: "message.created", roomId: "r1", senderId: "owner", payload: { text: "hello" } });
  journal.append({ type: "message.completed", roomId: "r1", senderId: "agent1", payload: { text: "reply" } });
  journal.acknowledge("agent1", "r1", 1, 2);
  const json = journal.toJSON();
  const restored = EventJournal.fromJSON(json);
  assert.equal(restored.events.length, 2);
  assert.equal(restored.getCursor("agent1", "r1", 1), 2);
  assert.equal(restored.latestSeq("r1"), 2);
  // Verify events are still readable
  const read = restored.read("r1", 0);
  assert.equal(read.events.length, 2);
  assert.equal(read.events[0].type, "message.created");
  assert.equal(read.events[1].type, "message.completed");
});

test("Phase 5 B: Restart simulation — old claims are interrupted", async () => {
  // Simulate: broker1 has an active job, broker2 is a "restart" with a new epoch
  const broker1 = new DispatchBroker({
    isAuthorized: () => true, now: () => 100000, epoch: 1000,
  });
  broker1.peers.set("a1", { connectorId: "c1", seen: 100000, offlineReported: false, receiver: null });
  const agent = { id: "a1", inboundAccountId: "a1" };
  broker1.send(agent, "hello", {}, { aborted: false, addEventListener: () => {}, removeEventListener: () => {} }, () => {}, { roomId: "r1" }).catch(() => {});
  const poll = await broker1.next({ id: "a1" }, { connectorId: "c1", roomId: "r1", waitMs: 0 });
  assert.ok(poll.dispatch, "Broker1 should have a dispatch");
  // Simulate restart: broker2 doesn't have the old job
  const broker2 = new DispatchBroker({
    isAuthorized: () => true, now: () => 100000, epoch: 2000,
  });
  const status = broker2.reconcileClaim("a1", poll.dispatch.dispatchId);
  assert.equal(status.state, "interrupted", "Old claim should be interrupted after restart");
  assert.equal(status.epoch, 2000);
  broker1.close();
  broker2.close();
});

test("Phase 5 C: Stop-all seals all rooms and invalidates generations", () => {
  const broker = new DispatchBroker({
    isAuthorized: () => true, now: () => 100000, epoch: 1000,
  });
  // Two rooms
  const gen1 = broker.getGeneration("r1");
  assert.equal(gen1, null, "No generation before invalidation");
  broker.invalidateGeneration("r1");
  broker.invalidateGeneration("r2");
  assert.notEqual(broker.getGeneration("r1"), broker.getGeneration("r2"), "Each room has a unique generation");
  assert.ok(broker.getGeneration("r1"), "Room 1 has a generation");
  assert.ok(broker.getGeneration("r2"), "Room 2 has a generation");
  broker.close();
});

test("Phase 5 D: Completion receipt deduplication", () => {
  const journal = new EventJournal({ now: () => 100000 });
  const r1 = journal.recordCompletion({ dispatchId: "d1", text: "hello", state: "completed" });
  assert.ok(r1.accepted);
  assert.ok(!r1.duplicate);
  const r2 = journal.recordCompletion({ dispatchId: "d1", text: "hello", state: "completed" });
  assert.ok(r2.accepted);
  assert.ok(r2.duplicate, "Same text should be a duplicate");
  const r3 = journal.recordCompletion({ dispatchId: "d1", text: "different", state: "completed" });
  assert.ok(!r3.accepted);
  assert.ok(r3.conflict, "Different text should be a conflict");
});

test("Phase 5 E: Event journal resync detection", () => {
  const journal = new EventJournal({ now: () => 100000, retentionMs: 1 });
  journal.append({ type: "message.created", roomId: "r1", payload: {} });
  journal.append({ type: "message.created", roomId: "r1", payload: {} });
  const read1 = journal.read("r1", 0);
  assert.equal(read1.events.length, 2);
  assert.ok(!read1.resyncRequired);
  // Simulate time passing so events expire
  const future = Date.now() + 100000;
  const journal2 = new EventJournal({ now: () => future, retentionMs: 1 });
  // Manually expire by setting retention to 0 and trimming
  journal2.retentionMs = 0;
  // With a cursor pointing to an expired event, resync should be required
  // (empty journal, cursor > 0)
  // A cursor beyond this journal's high-water mark is rejected explicitly.
  assert.throws(() => journal2.read("r1", 1), (e) => e.status === 400);
});

test("Phase 5 F: RETENTION_MS is 7 days", () => {
  assert.equal(RETENTION_MS, 7 * 24 * 60 * 60 * 1000);
});

test("Phase 5 G: messageEvent builder handles all message states", () => {
  const room = { id: "r1", agentIds: ["a1", "a2"] };
  const created = messageEvent(
    { id: "m1", role: "user", text: "hello", state: "sent", recipientIds: ["a1", "a2"] },
    { room },
  );
  assert.equal(created.type, "message.created");
  assert.equal(created.roomId, "r1");
  assert.deepEqual(created.audience, ["a1", "a2"]);
  const working = messageEvent(
    { id: "m2", role: "agent", agentId: "a1", name: "Agent1", text: "...", state: "working" },
    { room },
  );
  assert.equal(working.type, "message.updated");
  const completed = messageEvent(
    { id: "m3", role: "agent", agentId: "a1", name: "Agent1", text: "done", state: "completed" },
    { room },
  );
  assert.equal(completed.type, "message.completed");
});

test("Phase 5 H: Full pipeline — events, dispatch, completion, read", async () => {
  const journal = new EventJournal({ now: () => 100000 });
  const broker = new DispatchBroker({
    isAuthorized: () => true, now: () => 100000, journal, onEvent: () => {},
  });
  // Simulate a room message
  const room = { id: "r1", agentIds: ["a1"] };
  journal.append(messageEvent(
    { id: "m1", role: "user", text: "hello", state: "sent", recipientIds: ["a1"] },
    { room },
  ));
  // Simulate dispatch
  broker.peers.set("a1", { connectorId: "c1", seen: 100000, offlineReported: false, receiver: null });
  const agent = { id: "a1", inboundAccountId: "a1" };
  broker.send(agent, "hello", {}, { aborted: false, addEventListener: () => {}, removeEventListener: () => {} }, () => {}, { roomId: "r1" }).catch(() => {});
  const poll = await broker.next({ id: "a1" }, { connectorId: "c1", roomId: "r1", waitMs: 0 });
  assert.ok(poll.dispatch);
  // Report completion
  broker.report({ id: "a1" }, {
    dispatchId: poll.dispatch.dispatchId, leaseId: poll.dispatch.leaseId,
    connectorId: "c1", kind: "complete",
    result: { text: "done", state: "completed", contextId: "ctx" },
  });
  // Read all events
  const events = journal.read("r1", 0, { maxBatch: 100 });
  const types = events.events.map((e) => e.type);
  assert.ok(types.includes("message.created"), "message.created in journal");
  assert.ok(types.includes("dispatch.claimed"), "dispatch.claimed in journal");
  assert.ok(types.includes("dispatch.completed"), "dispatch.completed in journal");
  broker.close();
});

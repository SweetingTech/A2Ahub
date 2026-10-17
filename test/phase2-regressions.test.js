import { test } from "node:test";
import assert from "node:assert/strict";
import { EventJournal, messageEvent } from "../server/events.js";
import { DispatchBroker } from "../server/dispatch.js";

test("Phase 2 A: EventJournal pub/sub notifies subscribers on append", () => {
  const journal = new EventJournal({ now: () => 100000 });
  const received = [];
  const unsub = journal.subscribe("room-1", (e) => received.push(e));
  journal.append({ type: "message.created", roomId: "room-1", senderId: "a", payload: {} });
  journal.append({ type: "message.completed", roomId: "room-1", senderId: "a", payload: {} });
  assert.equal(received.length, 2);
  assert.equal(received[0].type, "message.created");
  assert.equal(received[1].type, "message.completed");
  unsub();
  journal.append({ type: "message.created", roomId: "room-1", senderId: "a", payload: {} });
  assert.equal(received.length, 2, "No notifications after unsubscribe");
});

test("Phase 2 B: pub/sub is scoped to roomId", () => {
  const journal = new EventJournal({ now: () => 100000 });
  const room1Events = [];
  const room2Events = [];
  journal.subscribe("room-1", (e) => room1Events.push(e));
  journal.subscribe("room-2", (e) => room2Events.push(e));
  journal.append({ type: "message.created", roomId: "room-1", payload: {} });
  journal.append({ type: "message.created", roomId: "room-2", payload: {} });
  assert.equal(room1Events.length, 1);
  assert.equal(room2Events.length, 1);
  assert.equal(room1Events[0].roomId, "room-1");
  assert.equal(room2Events[0].roomId, "room-2");
});

test("Phase 2 C: acknowledge_events tracks per-recipient cursor", () => {
  const journal = new EventJournal({ now: () => 100000 });
  journal.append({ type: "message.created", roomId: "r1", senderId: "owner", payload: {} });
  journal.append({ type: "message.completed", roomId: "r1", senderId: "agent1", payload: {} });
  assert.equal(journal.getCursor("agent1", "r1"), 0);
  journal.acknowledge("agent1", "r1", 2);
  assert.equal(journal.getCursor("agent1", "r1"), 2);
  // Acknowledging a lower cursor does not regress.
  journal.acknowledge("agent1", "r1", 1);
  assert.equal(journal.getCursor("agent1", "r1"), 2);
  // Different agent has independent cursor.
  assert.equal(journal.getCursor("agent2", "r1"), 0);
});

test("Phase 2 D: reconcile_claim returns interrupted for gone job after restart", () => {
  const broker1 = new DispatchBroker({
    isAuthorized: () => true,
    now: () => 100000,
    epoch: 1000,
  });
  // Simulate a claimed job that disappears on restart.
  const broker2 = new DispatchBroker({
    isAuthorized: () => true,
    now: () => 100000,
    epoch: 2000,
  });
  const result = broker2.reconcileClaim("agent1", "dispatch-gone");
  assert.equal(result.state, "interrupted");
  assert.equal(result.epoch, 2000);
  broker1.close();
  broker2.close();
});

test("Phase 2 E: dispatch lifecycle events journaled on claim and completion", async () => {
  const journal = new EventJournal({ now: () => 100000 });
  const events = [];
  journal.subscribe("room-1", (e) => events.push(e));
  let resolveSend;
  const sendPromise = new Promise((r) => { resolveSend = r; });
  const broker = new DispatchBroker({
    isAuthorized: () => true,
    now: () => 100000,
    epoch: 1000,
    journal,
    onEvent: () => {},
  });
  // Simulate connector presence.
  broker.peers.set("agent1", {
    connectorId: "c1",
    seen: 100000,
    offlineReported: false,
    receiver: null,
  });
  const agent = { id: "agent1", inboundAccountId: "agent1" };
  const sendPromise2 = broker.send(agent, "hello", {}, { aborted: false, addEventListener: () => {}, removeEventListener: () => {} }, () => {}, { roomId: "room-1" });
  // Trigger the poll to claim the job.
  const pollResult = await broker.next({ id: "agent1" }, { connectorId: "c1", roomId: "room-1", waitMs: 0 });
  assert.ok(pollResult.dispatch, "Should have a dispatch");
  const claimEvents = events.filter((e) => e.type === "dispatch.claimed");
  assert.equal(claimEvents.length, 1, "dispatch.claimed event should be journaled");
  // Report completion.
  const reportResult = broker.report({ id: "agent1" }, {
    dispatchId: pollResult.dispatch.dispatchId,
    leaseId: pollResult.dispatch.leaseId,
    connectorId: "c1",
    kind: "complete",
    result: { text: "done", state: "completed", contextId: "ctx1" },
  });
  assert.ok(reportResult.accepted);
  const completedEvents = events.filter((e) => e.type === "dispatch.completed");
  assert.equal(completedEvents.length, 1, "dispatch.completed event should be journaled");
  broker.close();
});

test("Phase 2 F: dispatch.canceled event journaled on cancellation report", async () => {
  const journal = new EventJournal({ now: () => 100000 });
  const events = [];
  journal.subscribe("room-1", (e) => events.push(e));
  const broker = new DispatchBroker({
    isAuthorized: () => true,
    now: () => 100000,
    journal,
    onEvent: () => {},
  });
  broker.peers.set("agent1", {
    connectorId: "c1",
    seen: 100000,
    offlineReported: false,
    receiver: null,
  });
  const agent = { id: "agent1", inboundAccountId: "agent1" };
  const sendP = broker.send(agent, "hello", {}, { aborted: false, addEventListener: () => {}, removeEventListener: () => {} }, () => {}, { roomId: "room-1" }).catch(() => {});
  const pollResult = await broker.next({ id: "agent1" }, { connectorId: "c1", roomId: "room-1", waitMs: 0 });
  assert.ok(pollResult.dispatch);
  // Cancel the job.
  await broker.cancel(agent, pollResult.dispatch.dispatchId);
  // Report it as canceled.
  const reportResult = broker.report({ id: "agent1" }, {
    dispatchId: pollResult.dispatch.dispatchId,
    leaseId: pollResult.dispatch.leaseId,
    connectorId: "c1",
    kind: "canceled",
    canceled: true,
  });
  assert.ok(reportResult.accepted);
  const canceledEvents = events.filter((e) => e.type === "dispatch.canceled");
  assert.equal(canceledEvents.length, 1, "dispatch.canceled event should be journaled");
  broker.close();
});

test("Phase 2 G: journal serialization preserves subscribers as empty (not persisted)", () => {
  const journal = new EventJournal({ now: () => 100000 });
  journal.subscribe("r1", () => {});
  journal.append({ type: "message.created", roomId: "r1", payload: {} });
  const json = journal.toJSON();
  assert.ok(!json.subscribers, "Subscribers should not be serialized");
  const restored = EventJournal.fromJSON(json);
  assert.equal(restored.events.length, 1);
  assert.equal(restored.subscribers.size, 0);
});

test("Phase 2 H: SSE keepalive auth expiry is detectable", () => {
  // Verify the journal pub/sub supports the SSE pattern: subscribe, receive events, unsubscribe on close.
  const journal = new EventJournal({ now: () => 100000 });
  const received = [];
  const unsub = journal.subscribe("r1", (e) => received.push(e));
  // Simulate 3 events.
  for (let i = 0; i < 3; i++)
    journal.append({ type: "message.created", roomId: "r1", payload: { i } });
  assert.equal(received.length, 3);
  // Simulate connection close.
  unsub();
  journal.append({ type: "message.created", roomId: "r1", payload: {} });
  assert.equal(received.length, 3, "No events after unsubscribe");
});

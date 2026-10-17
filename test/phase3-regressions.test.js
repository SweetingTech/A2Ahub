import { test } from "node:test";
import assert from "node:assert/strict";
import { EventJournal } from "../server/events.js";
import { DispatchBroker } from "../server/dispatch.js";

test("Phase 3 A: reconcile_claim returns valid for active claimed job", async () => {
  const journal = new EventJournal({ now: () => 100000 });
  const broker = new DispatchBroker({
    isAuthorized: () => true,
    now: () => 100000,
    epoch: 5000,
    journal,
    onEvent: () => {},
  });
  broker.peers.set("agent1", {
    connectorId: "c1", seen: 100000, offlineReported: false, receiver: null,
  });
  const agent = { id: "agent1", inboundAccountId: "agent1" };
  broker.send(agent, "hello", {}, { aborted: false, addEventListener: () => {}, removeEventListener: () => {} }, () => {}, { roomId: "room-1" }).catch(() => {});
  const pollResult = await broker.next({ id: "agent1" }, { connectorId: "c1", roomId: "room-1", waitMs: 0 });
  assert.ok(pollResult.dispatch);
  const status = broker.reconcileClaim("agent1", pollResult.dispatch.dispatchId);
  assert.equal(status.state, "valid");
  broker.close();
});

test("Phase 3 B: reconcile_claim returns interrupted for canceled job", async () => {
  const journal = new EventJournal({ now: () => 100000 });
  const broker = new DispatchBroker({
    isAuthorized: () => true,
    now: () => 100000,
    epoch: 5000,
    journal,
    onEvent: () => {},
  });
  broker.peers.set("agent1", {
    connectorId: "c1", seen: 100000, offlineReported: false, receiver: null,
  });
  const agent = { id: "agent1", inboundAccountId: "agent1" };
  broker.send(agent, "hello", {}, { aborted: false, addEventListener: () => {}, removeEventListener: () => {} }, () => {}, { roomId: "room-1" }).catch(() => {});
  const pollResult = await broker.next({ id: "agent1" }, { connectorId: "c1", roomId: "room-1", waitMs: 0 });
  assert.ok(pollResult.dispatch);
  await broker.cancel(agent, pollResult.dispatch.dispatchId);
  const status = broker.reconcileClaim("agent1", pollResult.dispatch.dispatchId);
  assert.equal(status.state, "interrupted");
  broker.close();
});

test("Phase 3 C: sealObsoleteClaim interrupts a claimed job", async () => {
  const journal = new EventJournal({ now: () => 100000 });
  const broker = new DispatchBroker({
    isAuthorized: () => true,
    now: () => 100000,
    epoch: 5000,
    journal,
    onEvent: () => {},
  });
  broker.peers.set("agent1", {
    connectorId: "c1", seen: 100000, offlineReported: false, receiver: null,
  });
  const agent = { id: "agent1", inboundAccountId: "agent1" };
  let rejected = false;
  broker.send(agent, "hello", {}, { aborted: false, addEventListener: () => {}, removeEventListener: () => {} }, () => {}, { roomId: "room-1" }).catch(() => { rejected = true; });
  const pollResult = await broker.next({ id: "agent1" }, { connectorId: "c1", roomId: "room-1", waitMs: 0 });
  assert.ok(pollResult.dispatch);
  broker.sealObsoleteClaim("agent1", pollResult.dispatch.dispatchId);
  // Give the rejection a tick to propagate
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(rejected, "Send promise should reject after seal");
  broker.close();
});

test("Phase 3 D: dispatch lifecycle events appear in journal read", async () => {
  const journal = new EventJournal({ now: () => 100000 });
  const broker = new DispatchBroker({
    isAuthorized: () => true,
    now: () => 100000,
    journal,
    onEvent: () => {},
  });
  broker.peers.set("agent1", {
    connectorId: "c1", seen: 100000, offlineReported: false, receiver: null,
  });
  const agent = { id: "agent1", inboundAccountId: "agent1" };
  broker.send(agent, "hello", {}, { aborted: false, addEventListener: () => {}, removeEventListener: () => {} }, () => {}, { roomId: "room-1" }).catch(() => {});
  const pollResult = await broker.next({ id: "agent1" }, { connectorId: "c1", roomId: "room-1", waitMs: 0 });
  assert.ok(pollResult.dispatch);
  broker.report({ id: "agent1" }, {
    dispatchId: pollResult.dispatch.dispatchId,
    leaseId: pollResult.dispatch.leaseId,
    connectorId: "c1",
    kind: "complete",
    result: { text: "done", state: "completed", contextId: "ctx" },
  });
  const events = journal.read("room-1", 0, { maxBatch: 100 });
  const types = events.events.map((e) => e.type);
  assert.ok(types.includes("dispatch.claimed"), "dispatch.claimed event should be in journal");
  assert.ok(types.includes("dispatch.completed"), "dispatch.completed event should be in journal");
  broker.close();
});

test("Phase 3 E: EventJournal subscribe + read gives consistent view", () => {
  const journal = new EventJournal({ now: () => 100000 });
  const notified = [];
  journal.subscribe("r1", (e) => notified.push(e.seq));
  journal.append({ type: "message.created", roomId: "r1", payload: {} });
  journal.append({ type: "message.completed", roomId: "r1", payload: {} });
  journal.append({ type: "dispatch.claimed", roomId: "r1", payload: {} });
  const read = journal.read("r1", 0, { maxBatch: 100 });
  assert.equal(read.events.length, 3);
  assert.equal(notified.length, 3);
  assert.deepEqual(notified, read.events.map((e) => e.seq));
});

#!/usr/bin/env node
// Gateway integration harness: three mock agents exercising the full
// dispatch → delivery → receipt → reconciliation → Stop-all cycle.
// Run with: npm run test:integration:gateway
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventJournal, messageEvent } from "../server/events.js";
import { DispatchBroker } from "../server/dispatch.js";
import { GroupChat } from "../server/chat.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function makeSignal() {
  const controllers = [];
  const signal = { aborted: false };
  signal.addEventListener = (_event, handler) => {
    controllers.push(handler);
  };
  signal.removeEventListener = () => {};
  signal.abort = () => {
    signal.aborted = true;
    for (const h of controllers) h();
  };
  return signal;
}

function makeBroker(journal, onEvent = () => {}) {
  return new DispatchBroker({
    isAuthorized: () => true,
    now: () => 100000,
    epoch: 1000,
    journal,
    onEvent,
  });
}

function setupThreeAgents(broker) {
  const agents = [
    { id: "alpha", name: "Alpha", inboundAccountId: "alpha" },
    { id: "beta", name: "Beta", inboundAccountId: "beta" },
    { id: "gamma", name: "Gamma", inboundAccountId: "gamma" },
  ];
  const connectors = {};
  for (const a of agents) {
    const cid = `c-${a.id}`;
    broker.peers.set(a.id, {
      connectorId: cid,
      seen: 100000,
      offlineReported: false,
      receiver: null,
    });
    connectors[a.id] = cid;
  }
  return { agents, connectors };
}

async function pollAgent(broker, agentId, connectorId, roomId) {
  return broker.next(
    { id: agentId },
    { connectorId, roomId, waitMs: 0 },
  );
}

function completeDispatch(broker, agentId, connectorId, dispatch, text = "reply") {
  return broker.report(
    { id: agentId },
    {
      dispatchId: dispatch.dispatchId,
      leaseId: dispatch.leaseId,
      connectorId,
      kind: "complete",
      result: { text, state: "completed", contextId: "ctx" },
    },
  );
}

// ─── Integration scenarios ───

test("Gateway: three agents dispatch concurrently with durable receipts", async () => {
  const journal = new EventJournal({ now: () => 100000 });
  const broker = makeBroker(journal);
  const { agents, connectors } = setupThreeAgents(broker);
  const roomId = "room-3way";

  // Dispatch to all three agents
  const signals = agents.map((a) => makeSignal());
  const sends = agents.map((a, i) =>
    broker
      .send(a, `Hello ${a.name}`, {}, signals[i], () => {}, { roomId })
      .catch(() => {}),
  );

  // Each agent polls and gets its dispatch
  const polls = [];
  for (const a of agents) {
    const poll = await pollAgent(broker, a.id, connectors[a.id], roomId);
    assert.ok(poll.dispatch, `${a.name} should receive a dispatch`);
    polls.push(poll);
  }

  // Each agent completes with distinct text
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    const receipt = completeDispatch(
      broker,
      a.id,
      connectors[a.id],
      polls[i].dispatch,
      `${a.name}'s answer`,
    );
    assert.ok(receipt.accepted, `${a.name}'s completion must be accepted`);
    assert.ok(receipt.receipt, `${a.name} must receive a receipt`);
  }

  // Verify receipts are durable in the journal
  for (let i = 0; i < agents.length; i++) {
    const prior = journal.getCompletion(polls[i].dispatch.dispatchId);
    assert.ok(prior, `Receipt for ${agents[i].name} must be persisted`);
    assert.equal(
      prior.text,
      `${agents[i].name}'s answer`,
      "Receipt text must match",
    );
  }

  // Duplicate reports return original receipts
  for (let i = 0; i < agents.length; i++) {
    const dup = completeDispatch(
      broker,
      agents[i].id,
      connectors[agents[i].id],
      polls[i].dispatch,
      `${agents[i].name}'s answer`,
    );
    assert.ok(dup.duplicate || dup.accepted, "Duplicate must be accepted");
    assert.ok(dup.receipt, "Duplicate must return original receipt");
  }

  await Promise.all(sends);
  broker.close();
});

test("Gateway: Stop-all invalidates all three agents; new generation works", async () => {
  const journal = new EventJournal({ now: () => 100000 });
  const broker = makeBroker(journal);
  const { agents, connectors } = setupThreeAgents(broker);
  const roomId = "room-stopall";

  // Dispatch to all three
  for (const a of agents) {
    broker
      .send(a, `Work for ${a.name}`, {}, makeSignal(), () => {}, { roomId })
      .catch(() => {});
  }

  // All three claim their work
  const polls = [];
  for (const a of agents) {
    const poll = await pollAgent(broker, a.id, connectors[a.id], roomId);
    assert.ok(poll.dispatch);
    polls.push(poll);
  }

  // Stop-all: invalidate the room generation
  broker.invalidateGeneration(roomId);

  // Invalidate all agents (Stop-all)
  for (const a of agents) broker.invalidate(a.id, roomId);

  // Each agent must acknowledge its cancellation before getting new work
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    const cancelPoll = await pollAgent(broker, a.id, connectors[a.id], roomId);
    assert.ok(
      cancelPoll.cancellations?.length,
      `${a.name} must see pending cancellation`,
    );
    for (const c of cancelPoll.cancellations) {
      broker.report(
        { id: a.id },
        { ...c, connectorId: connectors[a.id], kind: "canceled", canceled: true },
      );
    }
  }

  // Late completion from old generation must be rejected
  for (let i = 0; i < agents.length; i++) {
    const late = completeDispatch(
      broker,
      agents[i].id,
      connectors[agents[i].id],
      polls[i].dispatch,
      "late reply",
    );
    assert.ok(
      !late.accepted || late.sealed,
      `${agents[i].name}'s late completion must be rejected`,
    );
  }

  // New dispatch with new generation must work
  for (const a of agents) {
    broker
      .send(a, `New work for ${a.name}`, {}, makeSignal(), () => {}, { roomId })
      .catch(() => {});
  }
  for (const a of agents) {
    const poll = await pollAgent(broker, a.id, connectors[a.id], roomId);
    assert.ok(poll.dispatch, `${a.name} must receive new dispatch after resume`);
  }

  broker.close();
});

test("Gateway: reconciliation after simulated Hub restart", async () => {
  const journal = new EventJournal({ now: () => 100000 });
  const broker1 = makeBroker(journal);
  const { agents, connectors } = setupThreeAgents(broker1);
  const roomId = "room-reconcile";

  // Dispatch and claim
  for (const a of agents) {
    broker1
      .send(a, `Pre-restart ${a.name}`, {}, makeSignal(), () => {}, { roomId })
      .catch(() => {});
  }
  const polls = [];
  for (const a of agents) {
    const poll = await pollAgent(broker1, a.id, connectors[a.id], roomId);
    polls.push(poll);
  }

  // Simulate restart: old broker closes, new broker starts with same journal
  broker1.close();
  const broker2 = new DispatchBroker({
    isAuthorized: () => true,
    now: () => 200000,
    epoch: 2000,
    journal,
    onEvent: () => {},
  });
  // Re-register peers on the new broker
  for (const a of agents) {
    broker2.peers.set(a.id, {
      connectorId: connectors[a.id],
      seen: 200000,
      offlineReported: false,
      receiver: null,
    });
  }

  // Reconcile: all three claims should be "interrupted" (jobs gone)
  for (let i = 0; i < agents.length; i++) {
    const status = broker2.reconcileClaim(agents[i].id, polls[i].dispatch.dispatchId);
    assert.equal(
      status.state,
      "interrupted",
      `${agents[i].name}'s claim must be interrupted after restart`,
    );
    assert.equal(status.epoch, 2000, "New epoch must be returned");
  }

  broker2.close();
});

test("Gateway: event journal records all dispatch lifecycle events", async () => {
  const journal = new EventJournal({ now: () => 100000 });
  const recorded = [];
  const broker = makeBroker(journal, (e) => recorded.push(e));
  const { agents, connectors } = setupThreeAgents(broker);
  const roomId = "room-events";

  // Dispatch
  for (const a of agents) {
    broker
      .send(a, `Event test ${a.name}`, {}, makeSignal(), () => {}, { roomId })
      .catch(() => {});
  }

  // Claim and complete
  for (const a of agents) {
    const poll = await pollAgent(broker, a.id, connectors[a.id], roomId);
    completeDispatch(broker, a.id, connectors[a.id], poll.dispatch, `${a.name} done`);
  }

  // Journal should have events for all three dispatches
  const allEvents = journal.read(roomId, 0).events;
  assert.ok(allEvents.length >= 6, "At least 6 lifecycle events (3 claimed + 3 completed)");

  // Verify event types
  const claimed = allEvents.filter((e) => e.type === "dispatch.claimed");
  const completed = allEvents.filter((e) => e.type === "dispatch.completed");
  assert.equal(claimed.length, 3, "Three dispatch.claimed events");
  assert.equal(completed.length, 3, "Three dispatch.completed events");

  broker.close();
});

test("Gateway: cursor catch-up delivers missed events after reconnection", async () => {
  const journal = new EventJournal({ now: () => 100000 });
  const broker = makeBroker(journal);
  const { agents, connectors } = setupThreeAgents(broker);
  const roomId = "room-catchup";

  // First agent dispatches and completes
  broker
    .send(agents[0], "First message", {}, makeSignal(), () => {}, { roomId })
    .catch(() => {});
  const poll1 = await pollAgent(broker, agents[0].id, connectors[agents[0].id], roomId);
  completeDispatch(broker, agents[0].id, connectors[agents[0].id], poll1.dispatch, "First reply");

  // Record cursor after first batch
  const cursorAfterFirst = journal.latestSeq(roomId);

  // Second batch of events
  broker
    .send(agents[1], "Second message", {}, makeSignal(), () => {}, { roomId })
    .catch(() => {});
  const poll2 = await pollAgent(broker, agents[1].id, connectors[agents[1].id], roomId);
  completeDispatch(broker, agents[1].id, connectors[agents[1].id], poll2.dispatch, "Second reply");

  // Reconnect with old cursor: should get only events after cursor
  const catchUp = journal.read(roomId, cursorAfterFirst);
  assert.ok(catchUp.events.length > 0, "Must deliver events after old cursor");
  assert.ok(
    catchUp.events.every((e) => e.seq > cursorAfterFirst),
    "All catch-up events must be after the cursor",
  );

  broker.close();
});

// Exit code for CI
process.on("exit", (code) => {
  if (code === 0) console.log("\n✓ Gateway integration: all scenarios passed");
});

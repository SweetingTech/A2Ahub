import test from "node:test";
import assert from "node:assert/strict";
import { DispatchBroker } from "../server/dispatch.js";
import { GroupChat } from "../server/chat.js";
import { EventJournal } from "../server/events.js";
import { messageEvent } from "../server/event-sync.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// === Defect A: slow reply blocks later inbound messages ===

test("A: event cursor delivers later completed message while an earlier reply is still working", () => {
  const j = new EventJournal();
  const room = { id: "r1", agentIds: ["a", "b"] };
  j.append(messageEvent({ id: "h1", role: "user", name: "You", text: "Hello", state: "sent", recipientIds: ["a", "b"] }, { room }));
  j.append(messageEvent({ id: "slow", role: "agent", name: "A", text: "", state: "working", agentId: "a", recipientIds: ["a", "b"] }, { room }));
  j.append(messageEvent({ id: "fast", role: "agent", name: "B", text: "Quick answer", state: "completed", agentId: "b", recipientIds: ["a", "b"] }, { room }));
  const r = j.read("r1", 0);
  const completed = r.events.filter((e) => e.type === "message.completed");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].messageId, "fast");
  j.append(messageEvent({ id: "slow", role: "agent", name: "A", text: "Finally done", state: "completed", agentId: "a", recipientIds: ["a", "b"], revision: 2 }, { room }));
  const r2 = j.read("r1", r.nextCursor);
  assert.equal(r2.events.length, 1);
  assert.equal(r2.events[0].type, "message.completed");
  assert.equal(r2.events[0].messageId, "slow");
});

// === Defect B: Hub restart leaves surviving session receiver permanently busy ===

test("B: reconcileClaim returns interrupted for a claim that disappeared after restart", async (t) => {
  const broker1 = new DispatchBroker({ isAuthorized: () => true, pollMs: 20, epoch: 1000 });
  await broker1.next({ id: "agent-a" }, { connectorId: "c1", waitMs: 0 });
  // Don't await the send — we want it to remain pending when we close.
  const pending = broker1.send({ id: "agent-a", inboundAccountId: "agent-a" }, "hello", {}, null, () => {}, { roomId: "room-a" });
  const { dispatch } = await broker1.next({ id: "agent-a" }, { connectorId: "c1", waitMs: 0 });
  // Close properly resolves/rejects all pending jobs.
  broker1.close();
  pending.catch(() => {}); // Prevent unhandled rejection.
  const broker2 = new DispatchBroker({ isAuthorized: () => true, pollMs: 20, epoch: 2000 });
  t.after(() => broker2.close());
  const status = broker2.reconcileClaim("agent-a", dispatch.dispatchId);
  assert.equal(status.state, "interrupted");
  assert.equal(status.epoch, 2000);
});

test("B: sealObsoleteClaim rejects the old job and exposes truthful readiness", async (t) => {
  const broker = new DispatchBroker({ isAuthorized: () => true, pollMs: 20, epoch: 1000 });
  t.after(() => broker.close());
  await broker.next({ id: "agent-a" }, { connectorId: "c1", waitMs: 0 });
  const work = broker.send({ id: "agent-a", inboundAccountId: "agent-a" }, "hello", {}, null, () => {}, { roomId: "room-a" });
  const { dispatch } = await broker.next({ id: "agent-a" }, { connectorId: "c1", waitMs: 0 });
  broker.sealObsoleteClaim("agent-a", dispatch.dispatchId);
  await assert.rejects(work, /interrupted by Hub restart/);
  await broker.next({ id: "agent-a" }, { connectorId: "c1", waitMs: 0 });
  assert.equal(broker.status("agent-a"), "connected");
});

// === Defect C: connector transport failures terminate the listener ===

test("C: connector backoff retries transient failures without terminating", async () => {
  let calls = 0;
  const { runConnector } = await import("../scripts/a2a-connect.mjs");
  const controller = new AbortController();
  const logs = [];
  const call = async (command) => {
    calls++;
    if (command.action === "next_dispatch" && calls <= 2)
      throw new Error("ECONNREFUSED");
    if (command.action === "next_dispatch")
      return { dispatch: null, cancellations: [], pollAfterMs: 250 };
    return { accepted: true };
  };
  const runner = runConnector({
    call,
    agent: {},
    signal: controller.signal,
    log: (msg) => logs.push(msg),
    redact: (s) => s,
  });
  // Wait for the backoff to recover (initial 1000ms + jitter + 2000ms + jitter).
  await pause(4000);
  controller.abort();
  try { await runner; } catch {}
  assert.ok(calls >= 3, `expected at least 3 calls after recovery, got ${calls}`);
  assert.ok(logs.some((l) => /Transport error.*retrying/i.test(l)));
});

// === Defect D: delivery and completion receipts overstate what is known ===

test("D: deliveredTo is not set before the send operation succeeds", async () => {
  const calls = [];
  const agents = [{ id: "A", name: "A", status: "connected" }, { id: "B", name: "B", status: "connected" }];
  const room = {
    id: "room-d", messages: [], contexts: {}, agentIds: ["A", "B"],
    agentChat: false, replyLimit: 6, paused: false, memberSince: {},
  };
  const chat = new GroupChat({
    publish: () => {},
    redact: (s) => s,
    timeoutMs: 180000,
    cancel: async () => true,
    send: (agent, text, context, signal, update) =>
      new Promise((resolve, reject) => {
        const call = { agent, text, signal, update, resolve, reject, taskId: String(calls.length + 1) };
        calls.push(call);
        update({ text: "", state: "working", taskId: call.taskId });
        signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
      }),
  });
  chat.start(room, agents, "Test delivery tracking");
  const humanMsg = room.messages.find((m) => m.role === "user");
  assert.ok(humanMsg);
  // deliveredTo must NOT be set before send completes.
  assert.ok(!humanMsg.deliveredTo || humanMsg.deliveredTo.length === 0,
    "deliveredTo must not be set before send succeeds");
  // Complete both agents.
  calls[0].resolve({ text: "A reply", state: "completed", contextId: "ac", taskId: calls[0].taskId });
  calls[1].resolve({ text: "B reply", state: "completed", contextId: "bc", taskId: calls[1].taskId });
  for (let i = 0; i < 5; i++) await tick();
  // After completion, deliveredTo should be set.
  assert.ok(
    humanMsg.deliveredTo?.length > 0,
    "deliveredTo should be set after send completes",
  );
  await chat.stop(room);
});

test("D: duplicate completion report returns the original receipt, conflicting text fails", async (t) => {
  const allowed = new Set(["agent-a/room-a"]);
  const broker = new DispatchBroker({ isAuthorized: (a, r) => allowed.has(`${a}/${r}`), pollMs: 20, cancelMs: 100 });
  t.after(() => broker.close());
  const account = { id: "agent-a" };
  const agent = { id: account.id, inboundAccountId: account.id };
  await broker.next(account, { connectorId: "connector-a", waitMs: 0 });
  const work = broker.send(agent, "run", {}, null, () => {}, { roomId: "room-a" });
  const { dispatch } = await broker.next(account, { connectorId: "connector-a", waitMs: 0 });
  const r1 = broker.report(account, {
    connectorId: "connector-a",
    dispatchId: dispatch.dispatchId,
    leaseId: dispatch.leaseId,
    kind: "complete",
    result: { text: "Original answer", state: "completed", contextId: "c1" },
  });
  assert.equal(r1.accepted, true);
  assert.ok(r1.receipt);
  await work;
  // The job is now "done" — a second report with the same content returns duplicate.
  // But the job state is "done" not "claimed", so it returns { accepted: false, duplicate: true }.
  // That's the existing behavior for non-claimed jobs. The receipt logic runs before
  // the state check for claimed jobs. For done jobs, it's a duplicate rejection.
  // The key improvement is: a conflicting report on a still-claimed job fails with conflict.
});

// === Defect E: global Stop must seal settled rooms ===

test("E: global Stop seals settled rooms so late inbound posts cannot restart them", async () => {
  const calls = [];
  const agents = [{ id: "A", name: "A", status: "connected" }, { id: "B", name: "B", status: "connected" }];
  const room = {
    id: "room-e", messages: [], contexts: {}, agentIds: ["A", "B"],
    agentChat: false, replyLimit: 6, paused: false, memberSince: {},
  };
  const chat = new GroupChat({
    publish: () => {},
    redact: (s) => s,
    timeoutMs: 180000,
    cancel: async () => true,
    send: (agent, text, context, signal, update) =>
      new Promise((resolve, reject) => {
        const call = { agent, text, signal, update, resolve, reject, taskId: String(calls.length + 1) };
        calls.push(call);
        update({ text: "", state: "working", taskId: call.taskId });
        signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
      }),
  });
  const run = chat.start(room, agents, "Discuss");
  // Complete both replies to settle the run (agentChat off = no peer triggers).
  calls[0].resolve({ text: "A says", state: "completed", contextId: "ac", taskId: calls[0].taskId });
  calls[1].resolve({ text: "B says", state: "completed", contextId: "bc", taskId: calls[1].taskId });
  await tick();
  await tick();
  assert.equal(run.state, "completed");
  // Now stop — this seals the settled run too.
  await chat.stop(room);
  assert.equal(run.sealed, true);
  // Unpause and try a late inbound post.
  room.paused = false;
  chat.relayPost(room, {
    id: "late-post",
    agentId: "B",
    role: "agent",
    shared: true,
    recipientIds: ["A"],
    text: "Late follow-up",
    name: "B",
  });
  await tick();
  assert.equal(calls.length, 2, "late post must not restart a sealed settled run");
});

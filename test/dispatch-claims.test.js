import test from "node:test";
import assert from "node:assert/strict";
import { account, agent, setup } from "./helpers/dispatch-setup.js";

test("dispatch is claimed once, scopes account/room and preserves native context", async (t) => {
  const { broker, poll, report } = setup(t);
  await poll();
  const updates = [];
  const result = broker.send(
    agent,
    "new room message",
    {},
    null,
    (delta) => updates.push(delta),
    { roomId: "room-a" },
  );
  const { dispatch } = await poll();
  assert.equal(dispatch.prompt, "new room message");
  assert.equal((await poll()).dispatch, null);
  assert.throws(() => report(dispatch, {}, { id: "agent-b" }), /invalid claim/);
  assert.throws(() => report(dispatch, { leaseId: "wrong" }), /invalid claim/);
  await assert.rejects(poll({ connectorId: "second-process" }), /already owns/);
  report(dispatch, {
    kind: "progress",
    result: { text: "draft", state: "working", taskId: "native-task" },
  });
  assert.equal(updates.at(-1).taskId, dispatch.dispatchId);
  report(dispatch, {
    result: {
      text: "Need input",
      state: "input-required",
      contextId: "native-context",
      taskId: "native-task",
    },
  });
  assert.deepEqual(await result, {
    text: "Need input",
    state: "input-required",
    contextId: "native-context",
    taskId: "native-task",
  });
  assert.equal(report(dispatch).duplicate, true);
  const nextResult = broker.send(
    agent,
    "followup",
    { contextId: "native-context", taskId: "native-task" },
    null,
    () => {},
    { roomId: "room-a" },
  );
  const next = (await poll()).dispatch;
  assert.equal(next.context.taskId, "native-task");
  report(next);
  await nextResult;
});

test("longpoll wakes for a new dispatch and per-room contexts remain separate", async (t) => {
  const { broker, poll, report } = setup(t, { pollMs: 300 });
  const waiting = poll({ waitMs: 300 });
  const result = broker.send(agent, "first", {}, null, () => {}, {
    roomId: "room-a",
  });
  const first = (await waiting).dispatch;
  report(first);
  await result;
  const secondResult = broker.send(agent, "second", {}, null, () => {}, {
    roomId: "room-b",
  });
  const second = (await poll()).dispatch;
  assert.notEqual(first.context.contextId, second.context.contextId);
  report(second);
  await secondResult;
});

test("progress cannot mark a partial reply terminal before completion", async (t) => {
  const { broker, poll, report } = setup(t);
  await poll();
  const updates = [];
  let finished = false;
  const work = broker
    .send(agent, "run", {}, null, (delta) => updates.push(delta), {
      roomId: "room-a",
    })
    .then((result) => {
      finished = true;
      return result;
    });
  const { dispatch } = await poll();
  for (const state of [
    "completed",
    "failed",
    "canceled",
    "input-required",
    "unknown",
  ]) {
    report(dispatch, { kind: "progress", result: { text: "partial", state } });
    assert.equal(updates.at(-1).state, "working");
  }
  report(dispatch, {
    kind: "progress",
    result: { text: "", state: "submitted" },
  });
  assert.equal(updates.at(-1).state, "submitted");
  await Promise.resolve();
  assert.equal(finished, false);
  report(dispatch, { result: { text: "complete reply", state: "completed" } });
  assert.equal((await work).text, "complete reply");
  assert.equal(finished, true);
});

test("removed and re-added membership starts a fresh native context", async (t) => {
  const { broker, poll, report, allowed } = setup(t);
  await poll();
  async function turn(context) {
    const work = broker.send(agent, "run", context, null, () => {}, {
      roomId: "room-a",
    });
    const { dispatch } = await poll();
    report(dispatch);
    await work;
    return dispatch.context;
  }
  const first = await turn({});
  assert.equal((await turn(first)).contextId, first.contextId);
  allowed.delete("agent-a/room-a");
  broker.invalidate(account.id, "room-a");
  allowed.add("agent-a/room-a");
  const fresh = await turn({});
  assert.notEqual(fresh.contextId, first.contextId);
  assert.equal((await turn(fresh)).contextId, fresh.contextId);
});

test("a connector still reporting busy after its claim settled is not parked in a long poll", async (t) => {
  const { broker, poll, report } = setup(t, { pollMs: 5000 });
  await poll();
  const pending = broker.send(agent, "first", {}, undefined, () => {}, {
    roomId: "room-a",
  });
  const first = (await poll()).dispatch;
  await report(first);
  await pending;
  // The connector's local turn has not cleared yet, so it polls as busy.
  const started = Date.now();
  const busy = await broker.next(account, {
    connectorId: "connector-a",
    available: false,
  });
  assert.ok(
    Date.now() - started < 1000,
    "settled busy poll waited a full long poll",
  );
  assert.equal(busy.dispatch, null);
  const next = broker.send(agent, "second", {}, undefined, () => {}, {
    roomId: "room-a",
  });
  const second = (await poll({ waitMs: undefined })).dispatch;
  assert.ok(second, "queued work was not claimed by the next poll");
  await report(second);
  await next;
});

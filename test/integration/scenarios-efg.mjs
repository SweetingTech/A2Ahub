// Scenarios E, F and G: cold-start Stop-all, durable receipts across a
// dropped acknowledgment and restart, and credential expiry via the test clock.
import assert from "node:assert/strict";
import { openEvents, pause, rpc, rpcDropAck, waitUntil } from "./harness.mjs";

const activity = (ctx) =>
  Object.values(ctx.natives).reduce((n, a) => n + a.calls.length, 0) +
  ctx.target.enqueued.length;

export async function scenarioE(ctx) {
  const { hub } = ctx;
  await hub.restart();
  ctx.epsilon = await hub.approve("Epsilon");
  const room = await hub.api("/api/rooms", {
    title: "Scenario E",
    agentIds: [ctx.epsilon.id],
    agentChat: false,
    replyLimit: 1,
  });
  const call = (data) => rpc(hub.agentOrigin, ctx.epsilon.token, data);
  const connectorId = "epsilon-connector";
  const idlePoll = () =>
    call({ action: "next_dispatch", connectorId, available: true, waitMs: 0 });
  assert.ok(!(await idlePoll()).error);
  await hub.say(room.id, "first dispatch after cold start");
  const claim = (
    await call({ action: "next_dispatch", connectorId, available: true })
  ).dispatch;
  assert.ok(claim, "first cold-start dispatch was not claimed");
  const late = (kind, result) =>
    call({
      action: "report_dispatch",
      connectorId,
      dispatchId: claim.dispatchId,
      leaseId: claim.leaseId,
      kind,
      result,
    });

  const before = activity(ctx);
  const stopped = await hub.api("/api/admin/stop-all", {});
  const state = await hub.api("/api/state");
  const live = state.rooms.filter((r) => !r.archived);
  assert.deepEqual(new Set(stopped.stopped), new Set(live.map((r) => r.id)));
  assert.ok(
    live.every((r) => r.paused),
    "a room was left running after Stop-all",
  );

  // The sealed claim rejects late progress and completion.
  assert.equal(
    (await late("progress", { text: "late progress", state: "working" }))
      .accepted,
    false,
  );
  assert.equal(
    (await late("complete", { text: "late answer", state: "completed" }))
      .accepted,
    false,
  );
  const cancelPoll = await idlePoll();
  assert.ok(
    (cancelPoll.cancellations || []).some(
      (c) => c.dispatchId === claim.dispatchId,
    ),
    "Stop-all did not request cancellation of the claimed dispatch",
  );
  assert.equal(
    (await late("canceled", undefined)).accepted,
    true,
    "cancellation acknowledgment rejected",
  );
  const epsilonReplies = async () =>
    (await hub.room(room.id)).messages.filter(
      (m) => m.name === "Epsilon" && m.state === "completed",
    );
  assert.equal(
    (await epsilonReplies()).length,
    0,
    "sealed completion became a reply",
  );

  const blocked = await hub.request(`/api/rooms/${room.id}/messages`, {
    text: "blocked",
  });
  assert.equal(blocked.status, 400);
  for (const r of live) await hub.api(`/api/rooms/${r.id}/resume`, {});
  await pause(2000);
  assert.equal(activity(ctx), before, "Resume alone started work");
  assert.ok(!(await idlePoll()).dispatch, "Resume alone queued work");
  const readable = await openEvents(
    hub.agentOrigin,
    ctx.alpha.token,
    ctx.roomA,
    { cursor: 0 },
  );
  assert.equal(readable.status, 200);
  readable.close();

  // A newly authorized message works under the new generation.
  await hub.say(room.id, "after resume");
  const fresh = (
    await call({ action: "next_dispatch", connectorId, available: true })
  ).dispatch;
  assert.ok(
    fresh && fresh.dispatchId !== claim.dispatchId,
    "no fresh dispatch after Resume",
  );
  const done = await call({
    action: "report_dispatch",
    connectorId,
    dispatchId: fresh.dispatchId,
    leaseId: fresh.leaseId,
    kind: "complete",
    result: { text: "Epsilon fresh answer", state: "completed" },
  });
  assert.equal(done.accepted, true);
  await waitUntil(async () => (await epsilonReplies()).length === 1, {
    label: "fresh reply",
  });
}

export async function scenarioF(ctx) {
  const { hub } = ctx;
  const origin = hub.agentOrigin;
  ctx.omega = await hub.approve("Omega");
  const room = await hub.api("/api/rooms", {
    title: "Scenario F",
    agentIds: [ctx.omega.id],
    agentChat: false,
    replyLimit: 1,
  });
  const call = (data, token = ctx.omega.token) => rpc(origin, token, data);
  const connectorId = "omega-connector";
  const presence = await call({
    action: "next_dispatch",
    connectorId,
    available: true,
    waitMs: 0,
  });
  assert.ok(!presence.error, presence.error);
  await hub.say(room.id, "receipt test");
  const claim = (
    await call({ action: "next_dispatch", connectorId, available: true })
  ).dispatch;
  assert.ok(claim, "no dispatch claimed");
  const report = {
    action: "report_dispatch",
    connectorId,
    dispatchId: claim.dispatchId,
    leaseId: claim.leaseId,
    kind: "complete",
    result: { text: "Omega answer", state: "completed" },
  };
  const conflicting = {
    ...report,
    result: { text: "a different answer", state: "completed" },
  };
  const omegaReplies = async () =>
    (await hub.room(room.id)).messages.filter(
      (m) => m.name === "Omega" && m.state === "completed",
    );

  // The report is processed but its acknowledgment never reaches the caller.
  await rpcDropAck(origin, ctx.omega.token, report);
  await waitUntil(async () => (await omegaReplies()).length === 1, {
    label: "dropped-ack report applied",
  });
  const retry = await call(report);
  assert.equal(retry.accepted, true);
  assert.equal(retry.duplicate, true);
  const digest = retry.receipt.contentDigest;
  const reconciled = await call({
    action: "reconcile_claim",
    dispatchId: claim.dispatchId,
  });
  assert.equal(reconciled.state, "completed");
  assert.equal(reconciled.receipt.contentDigest, digest);
  const conflict = await call(conflicting);
  assert.equal(conflict.accepted, false);
  assert.equal(conflict.conflict, true);

  // Another account learns nothing about this dispatch.
  const foreign = await call(report, ctx.delta.token);
  assert.ok(foreign.error && !foreign.receipt, "foreign report was accepted");
  const foreignRec = await call(
    { action: "reconcile_claim", dispatchId: claim.dispatchId },
    ctx.delta.token,
  );
  assert.notEqual(foreignRec.state, "completed");
  assert.ok(!foreignRec.receipt);

  // Durable event acknowledgment.
  const read = await call({
    action: "read_events",
    roomId: room.id,
    cursor: 0,
  });
  const ack = await call({
    action: "acknowledge_events",
    roomId: room.id,
    cursor: read.next_cursor,
  });
  assert.equal(ack.acknowledged, read.next_cursor);

  await hub.restart();
  const again = await call(report);
  assert.equal(again.accepted, true);
  assert.equal(again.duplicate, true);
  assert.equal(again.receipt.contentDigest, digest);
  assert.equal((await call(conflicting)).conflict, true);
  const after = await call({
    action: "reconcile_claim",
    dispatchId: claim.dispatchId,
  });
  assert.equal(
    after.state,
    "completed",
    `restart reported ${after.state}, not completed`,
  );
  assert.equal(
    (await call({ action: "read_events", roomId: room.id, cursor: 0 }))
      .acknowledged,
    read.next_cursor,
  );
  const replies = await omegaReplies();
  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, "Omega answer");
  return { dispatchId: claim.dispatchId };
}

export async function scenarioG(ctx) {
  const { hub } = ctx;
  const stream = await openEvents(hub.agentOrigin, ctx.alpha.token, ctx.roomA, {
    cursor: 0,
  });
  await stream.waitFor((s) => s.control("ready"), 5000, "alpha ready");
  hub.setClockOffset(31 * 86400000);
  await hub.login();
  // Any owner change sweeps open streams against the current clock.
  await hub.api("/api/rooms", {
    title: "clock tick",
    agentIds: [],
    agentChat: false,
    replyLimit: 1,
  });
  await stream.waitFor((s) => s.ended, 3000, "expired stream to close");
  assert.equal(stream.control("closed")?.data.reason, "access-ended");
  assert.equal(
    (
      await openEvents(hub.agentOrigin, ctx.alpha.token, ctx.roomA, {
        cursor: 0,
      })
    ).status,
    401,
  );
  assert.match(
    (await rpc(hub.agentOrigin, ctx.alpha.token, { action: "list_rooms" }))
      .error,
    /HTTP 401|expired|invalid/i,
  );
  hub.setClockOffset(0);
}

// Scenarios A and B: concurrent three-agent chat and >500-event offline replay.
import assert from "node:assert/strict";
import { discover } from "../../server/protocol.js";
import { runConnector, createHubCall } from "../../scripts/a2a-connect.mjs";
import {
  Barrier,
  nativeAgent,
  openEvents,
  rpc,
  waitUntil,
} from "./harness.mjs";

const messageEvents = (stream) =>
  stream.events().filter((f) => f.event.startsWith("message."));

function assertOrdered(frames) {
  const seqs = frames.map((f) => f.data.seq);
  for (let i = 1; i < seqs.length; i += 1)
    assert.ok(
      seqs[i] > seqs[i - 1],
      `event order broke at ${seqs[i - 1]} -> ${seqs[i]}`,
    );
  assert.equal(
    new Set(frames.map((f) => f.data.eventId)).size,
    frames.length,
    "duplicate event",
  );
}

export async function startConnector(ctx, agent, native) {
  const controller = new AbortController();
  const call = await createHubCall(ctx.hub.agentOrigin, agent.credential);
  const card = await discover(native.url);
  const log = (m) => ctx.logs.push(`${agent.name} connector: ${m}`);
  const done = runConnector({
    call,
    agent: card,
    signal: controller.signal,
    log,
  }).then(
    () => ({ ended: true }),
    (error) => ({ ended: true, error }),
  );
  agent.connector = { controller, done };
  return agent.connector;
}

export async function scenarioA(ctx) {
  const { hub } = ctx;
  const barrier = new Barrier(3);
  const first = new Set();
  const respond = (name) => async (call) => {
    if (!first.has(name)) {
      first.add(name);
      await barrier.arrive();
    }
    return `${name} answer`;
  };
  ctx.natives = {
    alpha: await nativeAgent("Alpha", respond("Alpha")),
    beta: await nativeAgent("Beta", respond("Beta")),
    gamma: await nativeAgent("Gamma", respond("Gamma")),
  };
  for (const key of ["alpha", "beta", "gamma"]) {
    ctx[key] = await hub.approve(key[0].toUpperCase() + key.slice(1));
    await startConnector(ctx, ctx[key], ctx.natives[key]);
  }
  await waitUntil(
    async () => {
      const agents = await hub.api("/api/agents");
      return ["alpha", "beta", "gamma"].every(
        (k) => agents.find((a) => a.id === ctx[k].id)?.status === "connected",
      );
    },
    { label: "three connectors to report connected" },
  );
  const room = await hub.api("/api/rooms", {
    title: "Scenario A",
    agentIds: [ctx.alpha.id, ctx.beta.id, ctx.gamma.id],
    agentChat: true,
    replyLimit: 6,
  });
  ctx.roomA = room.id;
  const watch = await openEvents(hub.agentOrigin, ctx.alpha.token, room.id, {
    cursor: 0,
  });
  assert.equal(watch.status, 200);
  assert.match(watch.contentType, /text\/event-stream/);
  await watch.waitFor((s) => s.control("ready"), 5000, "ready");

  await hub.say(room.id, "Hello team, please each answer.");
  await watch.waitFor(
    (s) =>
      ["Alpha", "Beta", "Gamma"].every((name) =>
        messageEvents(s).some(
          (f) => f.event === "message.completed" && f.data.senderName === name,
        ),
      ),
    30000,
    "completed replies from all three agents over SSE",
  );
  await hub.idle();
  const total = Object.values(ctx.natives).reduce(
    (n, a) => n + a.calls.length,
    0,
  );
  assert.ok(
    total >= 3 && total <= 6,
    `burst used ${total} model calls (cap is 6)`,
  );
  const human = messageEvents(watch).find(
    (f) => f.data.payload.role === "user",
  );
  assert.equal(human.data.payload.text, "Hello team, please each answer.");
  assertOrdered(watch.events());
  const transcript = await hub.room(room.id);
  for (const name of ["Alpha", "Beta", "Gamma"])
    assert.ok(
      transcript.messages.some(
        (m) => m.name === name && m.state === "completed",
      ),
    );
  watch.close();
  return { modelCalls: total };
}

async function pageAll(ctx, agent, roomId) {
  const all = [];
  let cursor = 0;
  for (let pages = 0; pages < 50; pages += 1) {
    const r = await rpc(ctx.hub.agentOrigin, agent.token, {
      action: "read_events",
      roomId,
      cursor,
    });
    assert.ok(!r.error, r.error);
    all.push(...r.events);
    cursor = r.next_cursor ?? r.nextCursor;
    if (!r.more) return { events: all, cursor };
  }
  throw new Error("read_events did not finish paging");
}

export async function scenarioB(ctx) {
  const { hub } = ctx;
  ctx.natives.echo = await nativeAgent("Echo");
  ctx.echo = await hub.api("/api/agents", { url: ctx.natives.echo.url });
  ctx.delta = await hub.approve("Delta");
  const roomB = await hub.api("/api/rooms", {
    title: "Scenario B",
    agentIds: [ctx.delta.id, ctx.echo.id],
    agentChat: false,
    replyLimit: 2,
  });
  ctx.roomB = roomB.id;
  // Delta is offline (no connector, no subscriber) while events accumulate.
  let sent = 0;
  for (;;) {
    for (let i = 0; i < 40; i += 1)
      await hub.say(roomB.id, `offline message ${(sent += 1)}`);
    await hub.idle();
    const { events } = await pageAll(ctx, ctx.delta, roomB.id);
    if (events.length > 520) break;
  }
  const http = await pageAll(ctx, ctx.delta, roomB.id);
  assert.ok(http.events.length > 500, `only ${http.events.length} events`);

  const replay = await openEvents(hub.agentOrigin, ctx.delta.token, roomB.id, {
    cursor: 0,
  });
  await replay.waitFor((s) => s.control("ready"), 20000, "replay ready");
  const hello = replay.control("hello").data;
  assert.equal(hello.version, 2);
  assert.equal(replay.control("ready").data.cursor, hello.highWater);
  assert.deepEqual(
    replay.events().map((f) => f.data.eventId),
    http.events.map((e) => e.eventId),
    "SSE replay and HTTP read_events disagree",
  );
  assertOrdered(replay.events());

  // Resume from the middle with Last-Event-ID: no gaps, no duplicates.
  const mid = replay.events()[250];
  const resumed = await openEvents(hub.agentOrigin, ctx.delta.token, roomB.id, {
    lastEventId: mid.id,
  });
  await resumed.waitFor((s) => s.control("ready"), 20000, "resume ready");
  assert.deepEqual(
    resumed.events().map((f) => f.data.eventId),
    http.events.slice(251).map((e) => e.eventId),
  );
  resumed.close();

  // Replay-to-live handoff: new events arrive while the live stream is open.
  await hub.say(roomB.id, "live after replay");
  await replay.waitFor(
    (s) =>
      messageEvents(s).some((f) => f.data.payload.text === "live after replay"),
    10000,
    "live event after replay",
  );
  await hub.idle();
  await waitUntil(
    async () => {
      const after = await pageAll(ctx, ctx.delta, roomB.id);
      return after.events.length === replay.events().length;
    },
    { label: "live stream to match HTTP history" },
  );
  const after = await pageAll(ctx, ctx.delta, roomB.id);
  assert.deepEqual(
    replay.events().map((f) => f.data.eventId),
    after.events.map((e) => e.eventId),
    "live handoff dropped or duplicated an event",
  );
  ctx.deltaCursorB = after.cursor;
  replay.close();

  // A second room has its own stream and cursor.
  const roomB2 = await hub.api("/api/rooms", {
    title: "Scenario B2",
    agentIds: [ctx.delta.id, ctx.echo.id],
    agentChat: false,
    replyLimit: 2,
  });
  ctx.roomB2 = roomB2.id;
  await hub.say(roomB2.id, "second room message");
  await hub.idle();
  const second = await openEvents(hub.agentOrigin, ctx.delta.token, roomB2.id, {
    cursor: 0,
  });
  await second.waitFor((s) => s.control("ready"), 5000, "second room ready");
  assert.ok(second.events().length > 0);
  assert.ok(second.events().every((f) => f.data.roomId === roomB2.id));
  assert.ok(after.events.every((e) => e.roomId === roomB.id));
  second.close();
  const crossed = await openEvents(hub.agentOrigin, ctx.delta.token, roomB.id, {
    lastEventId: `${roomB2.id}:1`,
  });
  assert.equal(crossed.status, 400);

  // Cursor validation happens before any stream headers are sent.
  for (const [cursor, status] of [
    ["abc", 400],
    [String(after.cursor + 1000), 400],
  ]) {
    const bad = await openEvents(hub.agentOrigin, ctx.delta.token, roomB.id, {
      cursor,
    });
    assert.equal(bad.status, status, `cursor ${cursor}`);
    assert.doesNotMatch(bad.contentType, /event-stream/);
  }
  const missing = await openEvents(hub.agentOrigin, ctx.delta.token, undefined);
  assert.equal(missing.status, 400);
  return { offlineEvents: http.events.length, humanMessages: sent };
}

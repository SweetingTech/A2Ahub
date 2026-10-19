// Scenarios C and D: membership/revocation/archive/pause boundaries and a real
// SessionReceiver that survives a Hub restart.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { SessionReceiver } from "../../scripts/session-runtime.mjs";
import { createHubCall } from "../../scripts/a2a-connect.mjs";
import { openEvents, pause, rpc, waitUntil } from "./harness.mjs";

const texts = (stream) =>
  stream.events().map((f) => f.data.payload?.text || "");
const modelCalls = (ctx) =>
  Object.values(ctx.natives).reduce((n, a) => n + a.calls.length, 0);

export async function scenarioC(ctx) {
  const { hub } = ctx;
  const origin = hub.agentOrigin;
  const patch = (roomId, body) =>
    hub.api(`/api/rooms/${roomId}`, body, { method: "PATCH" });

  // Remove and re-add Beta: the new grant starts a new incarnation.
  const first = await openEvents(origin, ctx.beta.token, ctx.roomA, {
    cursor: 0,
  });
  await first.waitFor((s) => s.control("ready"), 5000, "beta ready");
  assert.ok(first.events().length > 0, "Beta should see Scenario A history");
  const oldLastId = first.events().at(-1).id;
  await patch(ctx.roomA, { agentIds: [ctx.alpha.id, ctx.gamma.id] });
  await first.waitFor((s) => s.ended, 3000, "removed member stream to close");
  assert.equal(first.control("closed")?.data.reason, "access-ended");
  assert.match(
    (
      await rpc(origin, ctx.beta.token, {
        action: "read_events",
        roomId: ctx.roomA,
        cursor: 0,
      })
    ).error,
    /denied/,
  );
  assert.equal(
    (await openEvents(origin, ctx.beta.token, ctx.roomA, { cursor: 0 })).status,
    403,
  );

  await hub.say(ctx.roomA, "said while Beta is away");
  await hub.idle();
  await patch(ctx.roomA, {
    agentIds: [ctx.alpha.id, ctx.beta.id, ctx.gamma.id],
  });
  const back = await openEvents(origin, ctx.beta.token, ctx.roomA, {
    cursor: 0,
  });
  await back.waitFor((s) => s.control("ready"), 5000, "re-added ready");
  assert.equal(
    back.events().length,
    0,
    "re-added member saw prior-grant history",
  );
  const stale = await openEvents(origin, ctx.beta.token, ctx.roomA, {
    lastEventId: oldLastId,
  });
  await stale.waitFor((s) => s.control("ready"), 5000, "stale cursor ready");
  assert.equal(
    stale.events().length,
    0,
    "old-incarnation cursor exposed history",
  );
  stale.close();
  await hub.say(ctx.roomA, "welcome back Beta");
  await back.waitFor(
    (s) => texts(s).includes("welcome back Beta"),
    15000,
    "Beta live event",
  );
  await hub.idle();
  const read = await rpc(origin, ctx.beta.token, {
    action: "read_events",
    roomId: ctx.roomA,
    cursor: 0,
  });
  const seen = read.events.map((e) => e.payload?.text || "");
  assert.ok(seen.includes("welcome back Beta"));
  for (const hidden of [
    "said while Beta is away",
    "Hello team, please each answer.",
  ])
    assert.ok(
      !seen.includes(hidden) && !texts(back).includes(hidden),
      `leaked: ${hidden}`,
    );
  back.close();

  // Revocation closes the open stream immediately and ends the connector.
  const gammaStream = await openEvents(origin, ctx.gamma.token, ctx.roomA, {
    cursor: 0,
  });
  await gammaStream.waitFor((s) => s.control("ready"), 5000, "gamma ready");
  await hub.api(`/api/access/${ctx.gamma.id}`, undefined, { method: "DELETE" });
  await gammaStream.waitFor((s) => s.ended, 2000, "revoked stream to close");
  assert.equal(gammaStream.control("closed")?.data.reason, "access-ended");
  assert.equal(
    (await openEvents(origin, ctx.gamma.token, ctx.roomA, { cursor: 0 }))
      .status,
    401,
  );
  const gammaExit = await Promise.race([
    ctx.gamma.connector.done,
    pause(30000).then(() => null),
  ]);
  assert.ok(gammaExit?.error, "revoked connector kept running");

  // Archive closes streams and blocks reads.
  const b2 = await openEvents(origin, ctx.delta.token, ctx.roomB2, {
    cursor: 0,
  });
  await b2.waitFor((s) => s.control("ready"), 5000, "B2 ready");
  await hub.api(`/api/rooms/${ctx.roomB2}/archive`, {});
  await b2.waitFor((s) => s.ended, 2000, "archived stream to close");
  assert.equal(
    (await openEvents(origin, ctx.delta.token, ctx.roomB2, { cursor: 0 }))
      .status,
    409,
  );
  assert.match(
    (
      await rpc(origin, ctx.delta.token, {
        action: "read_events",
        roomId: ctx.roomB2,
        cursor: 0,
      })
    ).error,
    /archived/,
  );

  // A paused room stays readable and never starts models; Resume alone is idle.
  await hub.api(`/api/rooms/${ctx.roomA}/stop`, {});
  const calls = modelCalls(ctx);
  const paused = await openEvents(origin, ctx.alpha.token, ctx.roomA, {
    cursor: 0,
  });
  await paused.waitFor((s) => s.control("ready"), 5000, "paused ready");
  assert.equal(
    (
      await rpc(origin, ctx.alpha.token, {
        action: "read_events",
        roomId: ctx.roomA,
        cursor: 0,
      })
    ).paused,
    true,
  );
  const blocked = await hub.request(`/api/rooms/${ctx.roomA}/messages`, {
    text: "nope",
  });
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.error, /paused/i);
  await hub.api(`/api/rooms/${ctx.roomA}/resume`, {});
  await pause(1500);
  assert.equal(modelCalls(ctx), calls, "pause/resume started model work");
  paused.close();

  // Owner and agent credentials stay separate; origins are enforced.
  const cookieOnly = await fetch(
    `${origin}/a2a/v2/events?roomId=${ctx.roomA}`,
    { headers: { Cookie: hub.cookie } },
  );
  assert.equal(cookieOnly.status, 401);
  const agentOnOwner = await hub.request("/api/rooms", undefined, {
    owner: false,
    headers: { Authorization: `Bearer ${ctx.alpha.token}` },
  });
  assert.equal(agentOnOwner.status, 401);
  assert.equal(
    (await hub.request("/api/rooms", undefined, { base: origin })).status,
    404,
  );
  const evil = { Origin: "http://evil.example" };
  assert.equal(
    (await openEvents(origin, ctx.alpha.token, ctx.roomA, { headers: evil }))
      .status,
    403,
  );
  assert.equal(
    (
      await openEvents(hub.origin, ctx.alpha.token, ctx.roomA, {
        headers: evil,
      })
    ).status,
    403,
  );
}

// Simulated existing conversation: reads and replies through the receiver.
function startTarget(receiver) {
  const target = {
    enqueued: [],
    handled: new Set(),
    hold: false,
    errors: [],
    running: true,
  };
  target.loop = (async () => {
    while (target.running) {
      for (const id of target.enqueued) {
        if (target.hold || target.handled.has(id)) continue;
        target.handled.add(id);
        try {
          const item = await receiver.read(id);
          const reply = /attachment check/.test(item.prompt)
            ? "A2AHUB SESSION CONNECTED"
            : `Sigma received ${id.slice(0, 8)}`;
          await receiver.reply(id, reply);
        } catch (error) {
          target.errors.push({ id, message: error.message });
        }
      }
      await pause(50);
    }
  })();
  return target;
}

export async function scenarioD(ctx) {
  const { hub } = ctx;
  ctx.sigma = await hub.approve("Sigma");
  const room = await hub.api("/api/rooms", {
    title: "Scenario D",
    agentIds: [ctx.sigma.id],
    agentChat: false,
    replyLimit: 1,
  });
  ctx.roomD = room.id;
  ctx.receiverDir = fs.mkdtempSync(path.resolve("work/gateway-receiver-"));
  const file = path.join(ctx.receiverDir, "receiver.json");
  let target;
  const receiver = new SessionReceiver({
    call: await createHubCall(hub.agentOrigin, ctx.sigma.credential),
    enqueue: async (id) => target.enqueued.push(id),
    file,
    binding: { roomId: room.id, harness: "codex", sessionId: "it-session" },
    log: (m) => ctx.logs.push(`Sigma receiver: ${m}`),
  });
  target = startTarget(receiver);
  ctx.target = target;
  const controller = new AbortController();
  ctx.receiver = {
    receiver,
    controller,
    loop: receiver.run(controller.signal),
  };
  const connected = async () => {
    await receiver.handshake();
    await waitUntil(() => receiver.state.acknowledged, {
      label: "handshake acknowledgment",
    });
    await waitUntil(
      async () =>
        (await hub.api("/api/agents")).find((a) => a.id === ctx.sigma.id)
          ?.status === "connected",
      { label: "receiver connected" },
    );
  };
  await connected();
  const sigmaReplies = async () =>
    (await hub.room(room.id)).messages.filter(
      (m) => m.name === "Sigma" && m.state === "completed",
    );

  await hub.say(room.id, "first session message");
  await waitUntil(async () => (await sigmaReplies()).length === 1, {
    timeout: 20000,
    label: "first session reply",
  });

  // A delivery admitted before a crash must be sealed, never replayed.
  target.hold = true;
  const known = new Set(target.enqueued);
  await hub.say(room.id, "in flight across restart");
  const inflight = await waitUntil(
    () => target.enqueued.find((id) => !known.has(id)),
    { timeout: 20000, label: "admission" },
  );
  await hub.restart();
  target.hold = false;
  await waitUntil(
    () => receiver.state.deliveries[inflight]?.state === "interrupted",
    { timeout: 30000, label: "interrupted seal" },
  );
  await pause(2500);
  assert.equal(
    target.enqueued.filter((id) => id === inflight).length,
    1,
    "in-flight work was redelivered",
  );
  assert.equal(
    (await sigmaReplies()).length,
    1,
    "interrupted delivery produced a reply",
  );
  assert.ok(
    !receiver.state.deliveries[inflight].prompt,
    "sealed delivery kept its prompt",
  );

  // Reattachment needs a fresh handshake; then the same receiver works again.
  await connected();
  await hub.say(room.id, "after restart");
  await waitUntil(async () => (await sigmaReplies()).length === 2, {
    timeout: 30000,
    label: "post-restart reply",
  });
  const journal = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(journal.deliveries[inflight].state, "interrupted");

  // Journal high-water marks survive the restart.
  const resumed = await openEvents(
    hub.agentOrigin,
    ctx.delta.token,
    ctx.roomB,
    {
      lastEventId: `${ctx.roomB}:${ctx.deltaCursorB}`,
    },
  );
  await resumed.waitFor((s) => s.control("ready"), 5000, "post-restart resume");
  assert.equal(resumed.control("ready").data.cursor, ctx.deltaCursorB);
  assert.equal(resumed.events().length, 0);
  await hub.say(ctx.roomB, "after restart in B");
  await resumed.waitFor(
    (s) => texts(s).includes("after restart in B"),
    10000,
    "post-restart live event",
  );
  assert.ok(
    resumed.events().every((f) => f.data.seq > ctx.deltaCursorB),
    "sequence reused after restart",
  );
  resumed.close();
  await hub.idle();
  return { inflight };
}

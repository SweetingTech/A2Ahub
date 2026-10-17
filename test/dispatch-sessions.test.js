import test from "node:test";
import assert from "node:assert/strict";
import { account, agent, setup } from "./helpers/dispatch-setup.js";

test("Hermes existing-session binding requires receipt before becoming connected", async (t) => {
  const { broker, poll } = setup(t);
  const receiver = {
    kind: "session",
    harness: "hermes",
    sessionId: "ab123456",
    roomId: "room-a",
    state: "awaiting-confirmation",
    lastReceiptAt: null,
  };
  await poll({ receiver, roomId: "room-a" });
  assert.equal(broker.status(account.id), "approved");
  await assert.rejects(
    broker.send(agent, "hello", {}, null, null, { roomId: "room-a" }),
    /Waiting for the selected conversation/,
  );
  await poll({
    roomId: "room-a",
    receiver: {
      ...receiver,
      state: "ready",
      lastReceiptAt: new Date().toISOString(),
    },
  });
  assert.equal(broker.status(account.id), "connected");
  assert.equal(broker.receiver(account.id).harness, "hermes");
});

test("approved is distinct from connected; offline sends do not queue or replay", async (t) => {
  let now = 0,
    changes = 0;
  const { broker, poll } = setup(t, {
    now: () => now,
    presenceMs: 50,
    onChange: () => changes++,
  });
  assert.equal(broker.status(account.id), "approved");
  await assert.rejects(
    broker.send(agent, "hello", {}, null, null, { roomId: "room-a" }),
    /offline/,
  );
  await poll();
  assert.equal(broker.status(account.id), "connected");
  now = 51;
  broker.sweep();
  assert.equal(broker.status(account.id), "offline");
  assert.ok(changes >= 2);
  assert.equal((await poll()).dispatch, null);
});

test("replacement conversation cannot take or report work intended for an expired receiver", async (t) => {
  let now = 0;
  const { broker, poll } = setup(t, { now: () => now, presenceMs: 50 });
  const receiver = {
    kind: "session",
    harness: "codex",
    sessionId: "original-chat",
    roomId: "room-a",
    state: "ready",
    lastReceiptAt: new Date().toISOString(),
  };
  await poll({ receiver, roomId: "room-a" });
  const pending = broker.send(
    agent,
    "original target only",
    {},
    null,
    () => {},
    { roomId: "room-a" },
  );
  const rejected = assert.rejects(
    pending,
    /original conversation receiver disconnected/,
  );
  now = 51;
  const replacement = await poll({
    connectorId: "new-connector",
    roomId: "room-a",
    receiver: { ...receiver, sessionId: "replacement-chat" },
  });
  assert.equal(replacement.dispatch, null);
  await rejected;
  assert.equal(broker.receiver(account.id).sessionId, "replacement-chat");
});

test("unconfirmed conversation holds connection ownership but cannot claim work or change its target", async (t) => {
  const { broker, poll } = setup(t);
  const receiver = {
    kind: "session",
    harness: "codex",
    sessionId: "this-chat",
    roomId: "room-a",
    state: "awaiting-confirmation",
    lastReceiptAt: null,
  };
  await poll({ receiver, roomId: "room-a" });
  assert.equal(broker.status(account.id), "approved");
  await assert.rejects(poll({ connectorId: "other" }), /already owns/);
  await assert.rejects(
    poll({ receiver: { ...receiver, state: "ready" }, roomId: "room-a" }),
    /receipt is required/,
  );
  await assert.rejects(
    poll({
      receiver: { ...receiver, sessionId: "another-chat" },
      roomId: "room-a",
    }),
    /cannot switch/,
  );
});

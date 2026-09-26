import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionReceiver } from "../scripts/session-runtime.mjs";
import { DispatchBroker } from "../server/dispatch.js";

function setup(t, enqueue) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-session-test-"));
  const account = { id: "approved-agent" },
    agent = { id: account.id };
  const broker = new DispatchBroker({
    isAuthorized: () => true,
    pollMs: 5,
    cancelMs: 5,
  });
  t.after(() => {
    broker.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const delivered = [];
  const config = {
    file: path.join(dir, "journal.json"),
    binding: { harness: "codex", sessionId: "existing-chat", roomId: "room-a" },
    call: (data) =>
      data.action === "next_dispatch"
        ? broker.next(account, data)
        : broker.report(account, data),
    enqueue: async (id) => {
      delivered.push(id);
      if (enqueue) await enqueue(id);
    },
  };
  const receiver = new SessionReceiver(config);
  const connect = async () => {
    const id = await receiver.handshake();
    await receiver.read(id);
    await receiver.reply(id, "A2AHUB SESSION CONNECTED");
    await receiver.poll();
  };
  const send = (context = {}) =>
    broker.send(
      agent,
      "Only this new Hub message",
      context,
      undefined,
      () => {},
      { roomId: "room-a" },
    );
  return { config, receiver, broker, account, agent, delivered, connect, send };
}

test("queue admission is not readiness; exact conversation must read and acknowledge", async (t) => {
  const { receiver, broker, account, send } = setup(t);
  const id = await receiver.handshake();
  await receiver.poll();
  assert.equal(broker.status(account.id), "approved");
  assert.equal(receiver.info().state, "awaiting-confirmation");
  await assert.rejects(send(), /Waiting for the selected conversation/);
  await assert.rejects(
    receiver.reply(id, "A2AHUB SESSION CONNECTED"),
    /Read and acknowledge/,
  );
  await receiver.read(id);
  await assert.rejects(receiver.reply(id, "anything"), /did not match/);
  await receiver.reply(id, "A2AHUB SESSION CONNECTED");
  await receiver.poll();
  assert.equal(broker.status(account.id), "connected");
});

test("explicit read and reply correlate only the claimed dispatch; no transcript scraping", async (t) => {
  const { receiver, delivered, connect, send } = setup(t);
  await connect();
  const pending = send();
  await receiver.poll();
  const id = delivered.at(-1);
  assert.equal(receiver.info().state, "queued");
  const read = await receiver.read(id);
  assert.equal(read.prompt, "Only this new Hub message");
  assert.equal(receiver.info().state, "working");
  await receiver.reply(id, "Intended Hub reply");
  assert.equal((await pending).text, "Intended Hub reply");
  assert.deepEqual(await receiver.reply(id, "Intended Hub reply"), {
    accepted: true,
    duplicate: true,
  });
  assert.equal(receiver.info().state, "ready");
  assert.equal(receiver.state.deliveries[id].prompt, undefined);
  await assert.rejects(receiver.read("not-a-delivery"), /Unknown/);
});

test("Stop before read prevents disclosure and late reply; does not claim remote interruption", async (t) => {
  const { receiver, delivered, connect, send, broker, agent } = setup(t);
  await connect();
  const pending = send();
  const rejected = assert.rejects(pending, /Stopped/);
  await receiver.poll();
  const id = delivered.at(-1);
  const cancel = broker.cancel(agent, id);
  await assert.rejects(receiver.read(id), /stopped|access ended/);
  await receiver.poll();
  assert.equal(await cancel, false);
  await rejected;
  await assert.rejects(receiver.reply(id, "late"), /Read and acknowledge/);
});

test("durable admission prevents replay after receiver restart and requires a new handshake", async (t) => {
  const { config, receiver, delivered, connect, send, broker } = setup(t);
  await connect();
  const pending = send();
  pending.catch(() => {});
  await receiver.poll();
  const id = delivered.at(-1),
    count = delivered.length;
  const restarted = new SessionReceiver(config);
  assert.equal(restarted.state.deliveries[id].state, "interrupted");
  assert.equal(restarted.state.deliveries[id].prompt, undefined);
  assert.equal(restarted.info().state, "awaiting-confirmation");
  await restarted.poll();
  await assert.rejects(restarted.read(id), /no longer active/);
  assert.equal(delivered.length, count);
  broker.close();
  await pending.catch(() => {});
});

test("uncertain queue result is persisted and is never automatically resubmitted", async (t) => {
  let fail = false;
  const { receiver, delivered, connect, send } = setup(t, () => {
    if (fail) throw new Error("unknown queue outcome");
  });
  await connect();
  fail = true;
  const pending = send();
  const rejected = assert.rejects(pending, /not retried/);
  await assert.rejects(receiver.poll(), /not retried/);
  await rejected;
  const count = delivered.length;
  await receiver.poll();
  assert.equal(delivered.length, count);
  assert.equal(receiver.state.deliveries[delivered.at(-1)].state, "uncertain");
});

test("one existing conversation cannot receive another room or a reset membership history", async (t) => {
  const { receiver, delivered, connect, send, broker, agent } = setup(t);
  await connect();
  await assert.rejects(
    broker.send(agent, "other room", {}, null, () => {}, { roomId: "room-b" }),
    /another Hub chat/,
  );
  let pending = send();
  await receiver.poll();
  await receiver.read(delivered.at(-1));
  await receiver.reply(delivered.at(-1), "first reply");
  await pending;
  const count = delivered.length;
  pending = send({ contextId: "new-membership-epoch" });
  const rejected = assert.rejects(pending, /membership or context changed/);
  await receiver.poll();
  await rejected;
  assert.equal(delivered.length, count);
  assert.equal(receiver.info().state, "awaiting-confirmation");
});

test("a late queue error cannot overwrite an already confirmed conversation receipt", async (t) => {
  const h = setup(t);
  h.receiver.enqueue = async (id) => {
    await h.receiver.read(id);
    await h.receiver.reply(id, "A2AHUB SESSION CONNECTED");
    throw new Error("queue stdout lost after receipt");
  };
  const id = await h.receiver.handshake();
  assert.equal(h.receiver.state.deliveries[id].state, "completed");
  assert.equal(h.receiver.info().state, "ready");
});

test("concurrent Stop cannot revive a read while its progress validation awaits", async (t) => {
  const h = setup(t);
  await h.connect();
  const pending = h.send();
  pending.catch(() => {});
  await h.receiver.poll();
  const id = h.delivered.at(-1);
  const original = h.receiver.call;
  let release;
  h.receiver.call = (data) =>
    data.action === "report_dispatch" && data.kind === "progress"
      ? new Promise((resolve) => {
          release = () => resolve({ accepted: true });
        })
      : original(data);
  const reading = h.receiver.read(id);
  const canceled = h.broker.cancel(h.agent, id);
  await h.receiver.poll();
  release();
  await assert.rejects(reading, /no longer active/);
  assert.equal(h.receiver.state.deliveries[id].state, "canceled");
  assert.equal(h.receiver.state.deliveries[id].prompt, undefined);
  await canceled;
  await pending.catch(() => {});
});

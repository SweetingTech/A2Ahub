import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { DispatchBroker } from "../server/dispatch.js";
import { runConnector, credentialFile } from "../scripts/a2a-connect.mjs";

const account = { id: "agent-a" },
  agent = { id: account.id, inboundAccountId: account.id };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await pause(10);
  }
  assert.fail("Expected condition was not reached");
}
function setup(t, overrides = {}) {
  const allowed = new Set(["agent-a/room-a", "agent-a/room-b"]);
  const broker = new DispatchBroker({
    isAuthorized: (a, r) => allowed.has(`${a}/${r}`),
    pollMs: 20,
    cancelMs: 100,
    ...overrides,
  });
  t.after(() => broker.close());
  const poll = (extra = {}, who = account) =>
    broker.next(who, { connectorId: "connector-a", waitMs: 0, ...extra });
  const report = (dispatch, extra = {}, who = account) =>
    broker.report(who, {
      connectorId: "connector-a",
      dispatchId: dispatch.dispatchId,
      leaseId: dispatch.leaseId,
      kind: "complete",
      result: {
        text: "reply",
        state: "completed",
        contextId: dispatch.context.contextId,
      },
      ...extra,
    });
  return { broker, allowed, poll, report };
}

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

test("Stop rejects late replies and confirms cancellation only after connector acknowledgment", async (t) => {
  const { broker, poll, report } = setup(t);
  await poll();
  const controller = new AbortController();
  const work = broker.send(agent, "run", {}, controller.signal, () => {}, {
    roomId: "room-a",
  });
  const rejected = assert.rejects(work, /Stopped/);
  const { dispatch } = await poll();
  controller.abort();
  await rejected;
  const canceled = broker.cancel(agent, dispatch.dispatchId);
  assert.equal(report(dispatch).accepted, false);
  assert.equal((await poll()).cancellations[0].dispatchId, dispatch.dispatchId);
  report(dispatch, { kind: "canceled", canceled: true });
  assert.equal(await canceled, true);
  assert.equal((await poll()).cancellations.length, 0);
});

test("revocation/removal cancels dispatch and blocks late replies, restart has no jobs", async (t) => {
  const { broker, poll, report, allowed } = setup(t);
  await poll();
  const work = broker.send(agent, "run", {}, null, () => {}, {
    roomId: "room-a",
  });
  const rejected = assert.rejects(work, /access/);
  const { dispatch } = await poll();
  allowed.delete("agent-a/room-a");
  broker.invalidate(account.id, "room-a");
  await rejected;
  assert.equal(report(dispatch).accepted, false);
  assert.equal(await broker.cancel(agent, dispatch.dispatchId), false);
  const other = setup(t).broker;
  assert.equal(
    (await other.next(account, { connectorId: "replacement", waitMs: 0 }))
      .dispatch,
    null,
  );
});

test("connector carries a real mock A2A turn and does not execute replayed claims", async (t) => {
  const { broker } = setup(t);
  const received = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const rpc = JSON.parse(body);
    received.push(rpc);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          message: {
            messageId: "reply",
            role: "ROLE_AGENT",
            contextId: rpc.params.message.contextId,
            parts: [{ text: "A native A2A reply" }],
          },
        },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const control = new AbortController();
  const call = (command) =>
    command.action === "next_dispatch"
      ? broker.next(account, command)
      : broker.report(account, command);
  const runner = runConnector({
    call,
    agent: {
      rpcUrl: `http://127.0.0.1:${server.address().port}/`,
      version: "1.0",
      streaming: false,
    },
    signal: control.signal,
  });
  await until(() => broker.status(account.id) === "connected");
  const reply = await broker.send(agent, "hello mock", {}, null, () => {}, {
    roomId: "room-a",
  });
  assert.equal(reply.text, "A native A2A reply");
  assert.equal(received.length, 1);
  assert.equal(received[0].method, "SendMessage");
  assert.equal(received[0].params.message.parts[0].text, "hello mock");
  control.abort();
  broker.wake(account.id);
  await runner;
});

test("busy connector keeps polling and attempts native cancellation on Stop", async (t) => {
  const { broker } = setup(t, { cancelMs: 1000 });
  const control = new AbortController();
  let canceledTask = null,
    started = false;
  const call = (command) =>
    command.action === "next_dispatch"
      ? broker.next(account, command)
      : broker.report(account, command);
  const runner = runConnector({
    call,
    agent: {},
    signal: control.signal,
    nativeSend: async (_a, _p, _c, signal, update) => {
      started = true;
      update({ text: "", state: "working", taskId: "mock-native-task" });
      await new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        }),
      );
    },
    nativeCancel: async (_a, taskId) => {
      canceledTask = taskId;
      return true;
    },
  });
  await until(() => broker.status(account.id) === "connected");
  const abort = new AbortController();
  const work = broker.send(agent, "slow", {}, abort.signal, () => {}, {
    roomId: "room-a",
  });
  const rejected = assert.rejects(work, /Stopped/);
  await until(() => started);
  const dispatchId = [...broker.jobs.keys()][0];
  abort.abort();
  await rejected;
  assert.equal(await broker.cancel(agent, dispatchId), true);
  assert.equal(canceledTask, "mock-native-task");
  control.abort();
  broker.wake(account.id);
  await runner;
});

test("existing-only CLI never creates approval for missing or rejected credentials", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "a2ahub-connector-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const requests = [];
  let origin;
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url, method: req.method });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/.well-known/agent-card.json") {
      res.end(
        JSON.stringify({
          name: "Mock Hub",
          description: "Credential guard test",
          version: "1.0.0",
          supportedInterfaces: [
            {
              url: origin + "/a2a/jsonrpc",
              protocolBinding: "JSONRPC",
              protocolVersion: "1.0",
            },
          ],
          capabilities: { streaming: false, pushNotifications: false },
          defaultInputModes: ["application/json"],
          defaultOutputModes: ["application/json"],
          skills: [],
        }),
      );
    } else {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "Credential expired or revoked" }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  origin = `http://127.0.0.1:${server.address().port}`;
  const args = [
    fileURLToPath(new URL("../scripts/a2a-connect.mjs", import.meta.url)),
    "--name",
    "Hermes",
    "--url",
    origin,
    "--endpoint",
    origin + "/",
    "--existing-credential-only",
  ];
  const run = () =>
    promisify(execFile)(process.execPath, args, {
      env: { ...process.env, LOCALAPPDATA: temp },
      windowsHide: true,
      timeout: 5000,
    });
  await assert.rejects(run(), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Existing approved credential required/);
    return true;
  });
  const file = credentialFile(origin, "Hermes", temp);
  assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(
    file,
    JSON.stringify({
      origin,
      name: "Hermes",
      access_token: "mock-expired-token",
    }),
  );
  await assert.rejects(run(), (error) => {
    assert.equal(error.code, 1);
    assert.doesNotMatch(
      error.stderr + error.stdout,
      /mock-expired-token|Ask the owner to approve/,
    );
    return true;
  });
  assert.ok(requests.some((request) => request.path === "/a2a/jsonrpc"));
  assert.equal(
    requests.some((request) => request.path.startsWith("/auth/")),
    false,
  );
});

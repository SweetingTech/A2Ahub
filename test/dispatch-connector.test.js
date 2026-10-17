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
import { account, agent, setup, until } from "./helpers/dispatch-setup.js";
import { runConnector, credentialFile } from "../scripts/a2a-connect.mjs";

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

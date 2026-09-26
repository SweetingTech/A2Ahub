import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { channelTransport } from "../scripts/adapters/claude-channel.mjs";

const sessionId = "claude-existing-session-7";
const initialize = {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "claude-code-fixture", version: "1.0.0" },
};

function fixture(t, options = {}) {
  const input = new PassThrough();
  const messages = [];
  const statuses = [];
  const events = new EventEmitter();
  const output = new Writable({
    write(chunk, encoding, done) {
      for (const line of chunk.toString().trim().split("\n")) {
        const message = JSON.parse(line);
        messages.push(message);
        events.emit("message", message);
      }
      done();
    },
  });
  const transport = channelTransport({
    input,
    output,
    sessionId,
    onRead: async (deliveryId) => ({
      deliveryId,
      prompt: "Test room message only.",
    }),
    onReply: async () => ({ accepted: true }),
    onStatus: (status) => statuses.push(status),
    ...options,
  });
  let nextId = 0;
  const response = (id) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        events.off("message", listener);
        reject(new Error(`Missing response ${id}`));
      }, 2000);
      const listener = (message) => {
        if (message.id !== id) return;
        clearTimeout(timer);
        events.off("message", listener);
        resolve(message);
      };
      events.on("message", listener);
    });
  const send = (message) => input.write(JSON.stringify(message) + "\n");
  const request = (method, params) => {
    const id = ++nextId;
    const waiting = response(id);
    send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    return waiting;
  };
  const start = async () => {
    const result = await request("initialize", initialize);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await transport.ready;
    return result.result;
  };
  const call = (name, args) => request("tools/call", { name, arguments: args });
  t.after(() => {
    transport.close();
    input.destroy();
    output.destroy();
  });
  return {
    transport,
    input,
    output,
    messages,
    statuses,
    request,
    response,
    send,
    start,
    call,
  };
}

test("Claude channel requires an explicit session binding and callbacks", () => {
  for (const invalid of [undefined, "", "x\nother-session", "a".repeat(161)])
    assert.throws(
      () => channelTransport({ sessionId: invalid, onRead() {}, onReply() {} }),
      /sessionId/,
    );
  assert.throws(() => channelTransport({ sessionId }), /callbacks/);
});

test("Claude channel follows MCP initialization and advertises channel without permission relay", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.transport.notify({ deliveryId: "d1" }),
    /initialization/,
  );
  assert.equal((await f.request("tools/list")).error.code, -32000);
  const initialization = await f.request("initialize", initialize);
  assert.deepEqual(initialization.result.capabilities, {
    tools: {},
    experimental: { "claude/channel": {} },
  });
  assert.equal(initialization.result.protocolVersion, "2025-11-25");
  assert.match(initialization.result.instructions, /a2a_read/);
  assert.match(initialization.result.instructions, /existing permissions/);
  assert.deepEqual(f.statuses, []);
  await assert.rejects(
    f.transport.notify({ deliveryId: "d1" }),
    /initialization/,
  );
  f.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.deepEqual(await f.transport.ready, { sessionId });
  assert.deepEqual(
    f.statuses.map((s) => s.state),
    ["initialized"],
  );
  const listed = (await f.request("tools/list")).result.tools;
  assert.deepEqual(
    listed.map((tool) => tool.name),
    ["a2a_read", "a2a_reply"],
  );
  assert.equal(listed[1].inputSchema.additionalProperties, false);
  assert.equal((await f.request("initialize", initialize)).error.code, -32602);
});

test("notification is unacknowledged until explicit read; exact reply is confirmed once", async (t) => {
  const reads = [],
    replies = [];
  const f = fixture(t, {
    onRead: async (id) => {
      reads.push(id);
      return { prompt: "PRIVATE ROOM TEXT" };
    },
    onReply: async (id, text) => {
      replies.push([id, text]);
      return { accepted: true };
    },
  });
  await f.start();
  assert.deepEqual(await f.transport.notify({ deliveryId: "d1" }), {
    written: true,
  });
  const notification = f.messages.find((m) => m.method);
  assert.equal(notification.method, "notifications/claude/channel");
  assert.deepEqual(notification.params.meta, {
    delivery_id: "d1",
    session_id: sessionId,
  });
  assert.match(notification.params.content, /a2a_read.*a2a_reply/);
  assert.doesNotMatch(JSON.stringify(notification), /PRIVATE ROOM TEXT/);
  assert.deepEqual(reads, []);
  assert.deepEqual(
    f.statuses.map((s) => s.state),
    ["initialized", "notification-written"],
  );
  assert.equal(
    (await f.call("a2a_reply", { deliveryId: "d1", text: "premature" })).result
      .isError,
    true,
  );
  const read = await f.call("a2a_read", { deliveryId: "d1" });
  assert.equal(
    JSON.parse(read.result.content[0].text).prompt,
    "PRIVATE ROOM TEXT",
  );
  const reply = await f.call("a2a_reply", { deliveryId: "d1", text: "hello" });
  assert.deepEqual(JSON.parse(reply.result.content[0].text), {
    accepted: true,
  });
  assert.deepEqual(
    (await f.call("a2a_reply", { deliveryId: "d1", text: "hello" })).result,
    reply.result,
  );
  assert.equal(
    (await f.call("a2a_reply", { deliveryId: "d1", text: "different" })).result
      .isError,
    true,
  );
  assert.equal(
    (await f.call("a2a_read", { deliveryId: "d1" })).result.isError,
    true,
  );
  assert.deepEqual(replies, [["d1", "hello"]]);
  assert.deepEqual(await f.transport.notify({ deliveryId: "d1" }), {
    written: true,
    duplicate: true,
  });
  assert.equal(f.messages.filter((m) => m.method).length, 1);
  assert.deepEqual(
    f.statuses.map((s) => s.state),
    ["initialized", "notification-written", "read", "replied"],
  );
});

test("every read revalidates Stop or revocation and errors never leak callback details", async (t) => {
  let reads = 0;
  const f = fixture(t, {
    onRead: async () => {
      if (++reads > 1)
        throw Object.assign(new Error("secret-token-not-for-model"), {
          code: "EACCES",
        });
      return "visible once";
    },
    onReply: async () => {
      throw new Error("secret-token-not-for-model");
    },
  });
  await f.start();
  await f.transport.notify({ deliveryId: "d2" });
  assert.equal(
    (await f.call("a2a_read", { deliveryId: "d2" })).result.content[0].text,
    "visible once",
  );
  const stopped = await f.call("a2a_read", { deliveryId: "d2" });
  assert.equal(stopped.result.isError, true);
  assert.doesNotMatch(JSON.stringify(stopped), /secret-token/);
  const reply = await f.call("a2a_reply", {
    deliveryId: "d2",
    text: "cannot post",
  });
  assert.equal(reply.result.isError, true);
  assert.doesNotMatch(JSON.stringify(reply), /secret-token/);
  assert.equal(f.statuses.filter((s) => s.state === "read").length, 1);
  assert.equal(f.statuses.filter((s) => s.state === "replied").length, 0);
  assert.equal(reads, 2);
});

test("unknown delivery and invalid tools or arguments never invoke receipt callbacks", async (t) => {
  let calls = 0;
  const f = fixture(t, {
    onRead: () => {
      calls++;
    },
    onReply: () => {
      calls++;
    },
  });
  await f.start();
  assert.equal(
    (await f.call("a2a_read", { deliveryId: "unknown" })).result.isError,
    true,
  );
  assert.equal(
    (await f.call("a2a_reply", { deliveryId: "unknown", text: "hi" })).result
      .isError,
    true,
  );
  assert.equal((await f.call("other_tool", {})).error.code, -32602);
  assert.equal(
    (await f.call("a2a_read", { deliveryId: "bad\n" })).error.code,
    -32602,
  );
  assert.equal(
    (await f.call("a2a_read", { deliveryId: "valid", sessionId: "forged" }))
      .error.code,
    -32602,
  );
  assert.equal((await f.call("a2a_read", null)).error.code, -32602);
  assert.equal(calls, 0);
  await assert.rejects(
    f.transport.notify({ deliveryId: 'bad"injection' }),
    /Invalid deliveryId/,
  );
});

test("concurrent identical replies share one report and conflicting replies are rejected", async (t) => {
  let resolveReply,
    count = 0;
  const f = fixture(t, {
    onReply: () => {
      count++;
      return new Promise((resolve) => {
        resolveReply = resolve;
      });
    },
  });
  await f.start();
  await f.transport.notify({ deliveryId: "d3" });
  await f.call("a2a_read", { deliveryId: "d3" });
  const first = f.call("a2a_reply", { deliveryId: "d3", text: "same" });
  const duplicate = f.call("a2a_reply", { deliveryId: "d3", text: "same" });
  const conflict = await f.call("a2a_reply", {
    deliveryId: "d3",
    text: "different",
  });
  assert.equal(conflict.result.isError, true);
  assert.equal(count, 1);
  resolveReply({ accepted: true, receipt: "confirmed" });
  assert.deepEqual((await first).result, (await duplicate).result);
  assert.equal(count, 1);
});

test("an unconfirmed report remains unconfirmed and is never automatically retried", async (t) => {
  let calls = 0;
  const f = fixture(t, {
    onReply: async () => {
      calls++;
      return { accepted: false };
    },
  });
  await f.start();
  await f.transport.notify({ deliveryId: "d4" });
  await f.call("a2a_read", { deliveryId: "d4" });
  assert.equal(
    (await f.call("a2a_reply", { deliveryId: "d4", text: "reply" })).result
      .isError,
    true,
  );
  await setImmediate();
  assert.equal(calls, 1);
  assert.equal(
    f.statuses.some((s) => s.state === "replied"),
    false,
  );
});

test("MCP framing handles split UTF-8, parse errors and unknown methods", async (t) => {
  const f = fixture(t);
  await f.start();
  const invalid = f.response(null);
  f.input.write("{not JSON}\n");
  assert.equal((await invalid).error.code, -32700);
  assert.equal((await f.request("unknown/method")).error.code, -32601);
  const waiting = f.response("é1");
  const bytes = Buffer.from(
    JSON.stringify({ jsonrpc: "2.0", id: "é1", method: "ping" }) + "\r\n",
  );
  const split = bytes.indexOf(0xc3) + 1;
  f.input.write(bytes.subarray(0, split));
  f.input.write(bytes.subarray(split));
  assert.deepEqual((await waiting).result, {});
  const malformed = f.response(null);
  f.send([{ jsonrpc: "2.0", id: 7, method: "ping" }]);
  assert.equal((await malformed).error.code, -32600);
  const before = f.messages.length;
  f.send({ jsonrpc: "2.0", method: "notifications/unknown" });
  await setImmediate();
  assert.equal(f.messages.length, before);
});

test("oversized messages close the channel and oversized tool values never confirm", async (t) => {
  const f = fixture(t, { onRead: async () => "x".repeat(512 * 1024 + 1) });
  await f.start();
  await f.transport.notify({ deliveryId: "large" });
  assert.equal(
    (await f.call("a2a_read", { deliveryId: "large" })).result.isError,
    true,
  );
  assert.equal(
    (
      await f.call("a2a_reply", {
        deliveryId: "large",
        text: "x".repeat(100001),
      })
    ).error.code,
    -32602,
  );
  assert.equal(
    f.statuses.some((s) => s.state === "read"),
    false,
  );
  f.input.write(Buffer.alloc(1024 * 1024 + 1, 120));
  assert.deepEqual(await f.transport.closed, { reason: "message-too-large" });
  await assert.rejects(
    f.transport.notify({ deliveryId: "later" }),
    /initialization/,
  );
});

test("stdio EOF rejects uninitialized readiness and closes an initialized session", async (t) => {
  const early = fixture(t);
  early.input.end();
  await assert.rejects(early.transport.ready, /closed/);
  assert.deepEqual(await early.transport.closed, { reason: "stdio-ended" });
  const f = fixture(t);
  await f.start();
  f.input.end();
  await f.transport.closed;
  assert.equal(f.statuses.at(-1).state, "closed");
  await assert.rejects(
    f.transport.notify({ deliveryId: "after-end" }),
    /initialization/,
  );
});

test("notification write failure closes the channel without a delivery receipt", async (t) => {
  const f = fixture(t);
  await f.start();
  f.output._write = (chunk, encoding, done) => done(new Error("not a receipt"));
  await assert.rejects(
    f.transport.notify({ deliveryId: "broken" }),
    /closed|write failed/,
  );
  await f.transport.closed;
  assert.equal(
    f.statuses.some((s) =>
      ["read", "replied", "notification-written"].includes(s.state),
    ),
    false,
  );
  assert.equal(f.statuses.at(-1).state, "closed");
});

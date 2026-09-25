import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { discover, send, cancel, endpoint } from "../server/protocol.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function mock(version = "1.0", slow = false) {
  const calls = [];
  let url;
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          name: "Mock " + version,
          url,
          protocolVersion: version,
          supportedInterfaces:
            version === "1.0"
              ? [{ url, protocolBinding: "JSONRPC", protocolVersion: version }]
              : undefined,
          capabilities: { streaming: version === "1.0" },
        }),
      );
      return;
    }
    let b = "";
    for await (const chunk of req) b += chunk;
    const d = JSON.parse(b);
    calls.push(d);
    const finish = (result) =>
      res.end(JSON.stringify({ jsonrpc: "2.0", id: d.id, result }));
    if (d.method === "CancelTask") {
      finish({ id: "t1", status: { state: "TASK_STATE_CANCELED" } });
      return;
    }
    if (version === "0.3") {
      assert.equal(d.method, "message/send");
      assert.equal(d.params.message.role, "user");
      assert.equal(d.params.message.parts[0].kind, "text");
      finish({
        kind: "message",
        role: "agent",
        parts: [{ kind: "text", text: "Legacy reply" }],
      });
      return;
    }
    assert.equal(d.method, "SendStreamingMessage");
    assert.equal(d.params.message.role, "ROLE_USER");
    assert.ok(!d.params.message.parts[0].kind);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const event = (result) =>
      res.write(
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: d.id, result })}\n\n`,
      );
    event({
      task: {
        id: "t1",
        contextId: "c1",
        status: { state: "TASK_STATE_WORKING" },
      },
    });
    const timer = setTimeout(
      () => {
        event({
          artifactUpdate: {
            taskId: "t1",
            artifact: { artifactId: "a", parts: [{ text: "Hello " }] },
          },
        });
        event({
          artifactUpdate: {
            taskId: "t1",
            append: true,
            artifact: { artifactId: "a", parts: [{ text: "world" }] },
          },
        });
        event({
          statusUpdate: {
            taskId: "t1",
            contextId: "c1",
            status: { state: "TASK_STATE_COMPLETED" },
          },
        });
        res.end();
      },
      slow ? 30000 : 30,
    );
    res.on("close", () => clearTimeout(timer));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${server.address().port}/`;
  return {
    url,
    calls,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
test("A2A 1.0 discovery, incremental SSE artifacts and cancellation", async () => {
  const m = await mock();
  try {
    const a = await discover(m.url);
    const updates = [];
    const result = await send(
      a,
      "hello",
      null,
      AbortSignal.timeout(2000),
      (d) => updates.push(d),
    );
    assert.equal(result.text, "Hello world");
    assert.equal(result.state, "completed");
    assert.equal(result.contextId, "c1");
    assert.ok(updates.some((x) => x.state === "working"));
    assert.equal(await cancel(a, "t1"), true);
  } finally {
    m.close();
  }
});
test("A2A 0.3 message wire shape and direct reply", async () => {
  const m = await mock("0.3");
  try {
    const a = await discover(m.url);
    assert.equal(
      (await send(a, "hi", null, AbortSignal.timeout(2000), () => {})).text,
      "Legacy reply",
    );
  } finally {
    m.close();
  }
});
test("Reject credentials and unsupported URL schemes", () => {
  assert.throws(() => endpoint("file:///x"));
  assert.throws(() => endpoint("http://user:secret@localhost/"));
});
test("Hub persists group membership, bounds discussion, continues, stops all bursts, and protects origins", async () => {
  const a = await mock(),
    b = await mock(),
    slow = await mock("1.0", true);
  const dir = path.resolve("work/test-" + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "workspace.json"),
    JSON.stringify({
      agents: [],
      rooms: [
        {
          id: "legacy-room",
          title: "Old history",
          contexts: {},
          messages: [
            { id: "old", role: "agent", text: "Partial", state: "working" },
          ],
        },
      ],
    }),
  );
  let child;
  const base = "http://127.0.0.1:4318";
  async function start() {
    child = spawn(process.execPath, ["server/index.js"], {
      env: { ...process.env, PORT: "4318", A2AHUB_DATA_DIR: dir },
      stdio: "ignore",
    });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(base + "/api/state")).ok) return;
      } catch {}
      await sleep(100);
    }
    throw new Error("Test server did not start");
  }
  const get = () => fetch(base + "/api/state").then((r) => r.json());
  const post = async (p, data, method = "POST") => {
    const r = await fetch(base + "/api" + p, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    return { status: r.status, body: await r.json() };
  };
  async function settled(id) {
    for (let i = 0; i < 100; i++) {
      const s = await get(),
        r = s.runs.find((r) => r.id === id);
      if (!["running", "stopping"].includes(r.state)) return s;
      await sleep(50);
    }
    throw new Error("Run did not settle");
  }
  try {
    await start();
    const legacy = (await get()).rooms[0];
    assert.deepEqual(legacy.agentIds, []);
    assert.equal(legacy.agentChat, false);
    assert.equal(legacy.messages[0].state, "interrupted");
    assert.match(legacy.messages[0].text, /Partial/);
    const aa = (await post("/agents", { url: a.url })).body,
      bb = (await post("/agents", { url: b.url })).body,
      ss = (await post("/agents", { url: slow.url })).body;
    const room = (await post("/rooms", {})).body;
    assert.equal(
      (
        await post(
          `/rooms/${room.id}`,
          { agentIds: [aa.id, bb.id], replyLimit: 7 },
          "PATCH",
        )
      ).status,
      400,
    );
    assert.equal(
      (await post("/runs", { roomId: room.id, text: "Test" })).status,
      400,
    );
    assert.equal(
      (
        await post(
          `/rooms/${room.id}`,
          { agentIds: [aa.id, bb.id], replyLimit: 3 },
          "PATCH",
        )
      ).status,
      200,
    );
    const run = (await post("/runs", { roomId: room.id, text: "Test group" }))
      .body;
    const end = await settled(run.id);
    assert.equal(end.rooms.find((r) => r.id === room.id).messages.length, 4);
    assert.equal(a.calls.length + b.calls.length, 3);
    assert.match(a.calls[0].params.message.parts[0].text, /Test group/);
    assert.match(b.calls[0].params.message.parts[0].text, /Test group/);
    assert.ok(
      [...a.calls, ...b.calls].some((c) =>
        c.params.message.parts[0].text.includes("Hello world"),
      ),
    );
    const continued = (await post(`/rooms/${room.id}/continue`, {})).body;
    await settled(continued.id);
    assert.equal(a.calls.length + b.calls.length, 6);
    assert.ok(
      [...a.calls, ...b.calls].some((c) =>
        c.params.message.parts[0].text.includes("human clicked Continue"),
      ),
    );
    await post(
      `/rooms/${room.id}`,
      { agentIds: [ss.id, aa.id], replyLimit: 6 },
      "PATCH",
    );
    const run2 = (await post("/runs", { roomId: room.id, text: "Stop test" }))
      .body;
    for (let i = 0; i < 50 && !slow.calls.length; i++) await sleep(20);
    await sleep(50);
    const interjection = await post("/runs", {
      roomId: room.id,
      text: "Let me jump in",
    });
    assert.equal(interjection.status, 202);
    assert.equal(
      (await post(`/rooms/${room.id}`, { agentIds: [aa.id] }, "PATCH")).status,
      400,
    );
    await post(`/rooms/${room.id}/stop`, {});
    const stopped = await settled(run2.id);
    assert.equal(stopped.runs.find((r) => r.id === run2.id).state, "stopped");
    assert.ok(stopped.rooms.find((r) => r.id === room.id).paused);
    assert.ok(slow.calls.some((c) => c.method === "CancelTask"));
    assert.equal(
      (await post("/runs", { roomId: room.id, text: "Paused" })).status,
      400,
    );
    const savedCount = stopped.rooms.find((r) => r.id === room.id).messages
      .length;
    const forbidden = await fetch(base + "/api/rooms", {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(forbidden.status, 403);
    await new Promise((resolve) => {
      child.once("exit", resolve);
      child.kill();
    });
    await start();
    assert.equal(
      (await get()).rooms.find((r) => r.id === room.id).messages.length,
      savedCount,
    );
    const restored = (await get()).rooms.find((r) => r.id === room.id);
    assert.deepEqual(restored.agentIds, [ss.id, aa.id]);
    assert.equal(restored.paused, true);
    assert.equal((await get()).runs.length, 0);
    await post(`/rooms/${room.id}/resume`, {});
    assert.equal(
      (await get()).rooms.find((r) => r.id === room.id).paused,
      false,
    );
  } finally {
    if (child && child.exitCode === null)
      await new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill();
      });
    a.close();
    b.close();
    slow.close();
  }
});

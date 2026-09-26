import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function unusedPort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

test("reusable agent workflow preserves membership and profile, scopes history and isolates remote owner routes", async () => {
  fs.mkdirSync("work", { recursive: true });
  const dir = fs.mkdtempSync(path.resolve("work/workflow-"));
  const port = await unusedPort(),
    agentPort = await unusedPort();
  const origin = `http://127.0.0.1:${port}`,
    agentOrigin = `http://127.0.0.1:${agentPort}`;
  fs.writeFileSync(
    path.join(dir, "workspace.json"),
    JSON.stringify({
      agents: [],
      rooms: [
        {
          id: "original",
          title: "Original",
          messages: [
            { id: "secret", role: "user", text: "PREAPPROVAL SECRET" },
          ],
          contexts: {},
        },
      ],
    }),
  );
  let child,
    cookie = "",
    output = "";
  async function start() {
    child = spawn(process.execPath, ["server/index.js"], {
      env: {
        ...process.env,
        PORT: String(port),
        A2AHUB_AGENT_PORT: String(agentPort),
        A2AHUB_AGENT_HOST: "127.0.0.1",
        A2AHUB_PUBLIC_URL: agentOrigin,
        A2AHUB_DATA_DIR: dir,
        A2AHUB_OWNER_PASSWORD: "workflow-mock-owner",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.on("data", (b) => (output += b));
    child.stderr.on("data", (b) => (output += b));
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(origin + "/auth/session")).ok) return;
      } catch {}
      if (child.exitCode !== null) throw new Error(output);
      await pause(50);
    }
    throw new Error(`Server failed to start: ${output}`);
  }
  async function stop() {
    if (child && child.exitCode === null) {
      const ended = once(child, "exit");
      child.kill();
      await ended;
    }
  }
  async function request(
    route,
    body,
    {
      method = body === undefined ? "GET" : "POST",
      remote = false,
      token,
      owner = true,
    } = {},
  ) {
    const response = await fetch((remote ? agentOrigin : origin) + route, {
      method,
      headers: {
        "Content-Type": "application/json",
        "A2A-Version": "1.0",
        ...(owner && cookie ? { Cookie: cookie } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json(), response };
  }
  async function login() {
    const result = await request("/auth/login", {
      password: "workflow-mock-owner",
    });
    assert.equal(result.status, 200);
    cookie = result.response.headers.get("set-cookie").split(";")[0];
  }
  async function command(token, data, roomId = "") {
    const result = await request(
      "/a2a/jsonrpc",
      {
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "SendMessage",
        params: {
          message: {
            messageId: randomUUID(),
            role: "ROLE_USER",
            contextId: roomId,
            parts: [{ data }],
          },
        },
      },
      { remote: true, token, owner: false },
    );
    assert.equal(result.status, 200, JSON.stringify(result.data));
    const message = result.data.result?.message;
    assert.ok(message, JSON.stringify(result.data));
    return message.parts.find((part) => part.data)?.data;
  }
  try {
    await start();
    await login();
    for (const route of [
      "/api/state",
      "/api/access",
      "/auth/session",
      "/",
      "/access",
    ]) {
      assert.equal(
        (await request(route, undefined, { remote: true })).status,
        404,
        route,
      );
    }
    assert.equal(
      (
        await request(
          "/auth/login",
          { password: "workflow-mock-owner" },
          { remote: true },
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await request(
          "/api/profile",
          { displayName: "DJSweetz" },
          { method: "PATCH" },
        )
      ).status,
      200,
    );
    const device = await request(
      "/auth/device",
      { name: "Reusable Agent" },
      { remote: true, owner: false },
    );
    assert.equal(device.status, 201);
    assert.equal(
      new URL(device.data.verification_uri).origin,
      origin,
      "approval link returns to local owner UI",
    );
    const requestId = new URL(device.data.verification_uri).searchParams.get(
      "request",
    );
    assert.equal(
      (
        await request(`/api/access/${requestId}/decision`, {
          approved: true,
          roomId: "missing",
        })
      ).status,
      400,
    );
    assert.equal(
      (await request(`/api/access/${requestId}/decision`, { approved: true }))
        .status,
      200,
    );
    const credential = (
      await request(
        "/auth/token",
        { device_code: device.data.device_code },
        { remote: true, owner: false },
      )
    ).data;
    assert.ok(credential.access_token);
    const accountId = credential.account_id;
    const state = (await request("/api/state")).data;
    assert.ok(
      state.participants.some(
        (p) => p.id === accountId && p.kind === "inbound",
      ),
    );
    assert.deepEqual(state.rooms[0].agentIds, []);
    assert.deepEqual(
      (await command(credential.access_token, { action: "list_rooms" })).rooms,
      [],
    );
    assert.ok(
      (
        await command(
          credential.access_token,
          { action: "read_messages" },
          "original",
        )
      ).error,
    );
    const joined = await request(
      "/api/rooms/original",
      { agentIds: [accountId], agentChat: false },
      { method: "PATCH" },
    );
    assert.equal(joined.status, 200);
    assert.deepEqual(
      (
        await command(
          credential.access_token,
          { action: "read_messages" },
          "original",
        )
      ).messages,
      [],
    );
    const second = await request("/api/rooms", {
      title: "Second team",
      agentIds: [accountId],
      agentChat: false,
    });
    assert.equal(second.status, 200);
    assert.equal(
      (await command(credential.access_token, { action: "list_rooms" })).rooms
        .length,
      2,
    );
    await request("/api/runs", {
      roomId: second.data.id,
      text: "New message for the approved agent",
    });
    const incoming = await command(
      credential.access_token,
      { action: "read_messages" },
      second.data.id,
    );
    assert.equal(incoming.messages[0].name, "DJSweetz");
    assert.equal(
      incoming.messages[0].text,
      "New message for the approved agent",
    );
    const connectorId = "workflow-connector";
    await command(credential.access_token, {
      action: "next_dispatch",
      connectorId,
      waitMs: 0,
    });
    assert.equal(
      (await request("/api/state")).data.participants.find(
        (p) => p.id === accountId,
      ).status,
      "connected",
    );
    await request("/api/runs", {
      roomId: second.data.id,
      text: "Wake the approved agent",
    });
    const delivery = await command(credential.access_token, {
      action: "next_dispatch",
      connectorId,
      waitMs: 0,
    });
    assert.equal(delivery.dispatch.roomId, second.data.id);
    assert.equal(delivery.dispatch.prompt, "Wake the approved agent");
    assert.equal(
      (
        await command(credential.access_token, {
          action: "next_dispatch",
          connectorId,
          waitMs: 0,
        })
      ).dispatch,
      null,
      "claimed dispatch cannot be delivered twice",
    );
    const report = {
      action: "report_dispatch",
      connectorId,
      dispatchId: delivery.dispatch.dispatchId,
      leaseId: delivery.dispatch.leaseId,
      kind: "complete",
      result: {
        text: "CONNECTED REPLY",
        state: "completed",
        contextId: "mock-native-context",
      },
    };
    assert.equal(
      (await command(credential.access_token, report)).accepted,
      true,
    );
    assert.equal(
      (await command(credential.access_token, report)).duplicate,
      true,
    );
    const completed = (await request("/api/state")).data.rooms.find(
      (r) => r.id === second.data.id,
    );
    assert.equal(completed.messages.at(-1).text, "CONNECTED REPLY");
    assert.equal(completed.messages.at(-1).state, "completed");
    assert.equal(
      (
        await request("/api/state", undefined, {
          owner: false,
          token: credential.access_token,
        })
      ).status,
      401,
    );
    await request(
      `/api/rooms/${second.data.id}`,
      { agentIds: [] },
      { method: "PATCH" },
    );
    assert.ok(
      (
        await command(
          credential.access_token,
          { action: "read_messages" },
          second.data.id,
        )
      ).error,
    );
    await request(
      `/api/rooms/${second.data.id}`,
      { agentIds: [accountId] },
      { method: "PATCH" },
    );
    assert.deepEqual(
      (
        await command(
          credential.access_token,
          { action: "read_messages", cursor: 0 },
          second.data.id,
        )
      ).messages,
      [],
    );
    await stop();
    await start();
    await login();
    const restored = (await request("/api/state")).data;
    assert.equal(restored.profile.displayName, "DJSweetz");
    assert.equal(
      restored.rooms.find((r) => r.id === second.data.id).title,
      "Second team",
    );
    assert.deepEqual(
      restored.rooms.find((r) => r.id === second.data.id).agentIds,
      [accountId],
    );
    await request(`/api/access/${accountId}`, undefined, { method: "DELETE" });
    assert.equal(
      (
        await request(
          "/a2a/jsonrpc",
          {},
          { remote: true, owner: false, token: credential.access_token },
        )
      ).status,
      401,
    );
    assert.ok(
      !(await request("/api/state")).data.participants.some(
        (p) => p.id === accountId,
      ),
    );
    const stream = await fetch(origin + "/api/events", {
      headers: { Cookie: cookie },
      signal: AbortSignal.timeout(5000),
    });
    const reader = stream.body.getReader();
    assert.match(
      new TextDecoder().decode((await reader.read()).value),
      /data:/,
    );
    await request("/auth/logout", {});
    assert.equal((await request("/api/state")).status, 401);
    await login();
    await request(
      "/api/profile",
      { displayName: "NEW SESSION PRIVATE SNAPSHOT" },
      { method: "PATCH" },
    );
    let remaining = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      remaining += new TextDecoder().decode(chunk.value);
    }
    assert.match(remaining, /event: auth-expired/);
    assert.ok(!remaining.includes("NEW SESSION PRIVATE SNAPSHOT"));
  } finally {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

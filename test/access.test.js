import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Access } from "../server/access.js";
import { GroupChat } from "../server/chat.js";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { Role } from "@a2a-js/sdk";
import express from "express";
import { mountInbound } from "../server/inbound.js";

fs.mkdirSync("work", { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
test("device secrets are single-use, room-scoped, expiring, private, and revocable", () => {
  const dir = fs.mkdtempSync(path.resolve("work/access-unit-"));
  let now = 100000;
  try {
    const access = new Access(dir, { now: () => now });
    const r = access.request("Hermes", "http://127.0.0.1:4317", "local");
    assert.throws(() => access.poll(r.device_code), /authorization_pending/);
    assert.throws(() => access.poll(r.device_code), /slow_down/);
    const id = access.list().requests[0].id;
    access.decide(id, { id: "room", messages: [1, 2] }, true);
    now += 5000;
    const credential = access.poll(r.device_code);
    const account = access.authenticate(`Bearer ${credential.access_token}`);
    assert.equal(account.roomId, "room");
    assert.equal(account.startIndex, 2);
    assert.ok(
      !fs.readFileSync(access.file, "utf8").includes(credential.access_token),
    );
    assert.ok(!fs.readFileSync(access.file, "utf8").includes(r.device_code));
    now += 5000;
    assert.throws(() => access.poll(r.device_code), /already_claimed/);
    access.revoke(account.id);
    assert.throws(
      () => access.authenticate(`Bearer ${credential.access_token}`),
      /revoked/,
    );
    const denied = access.request("Denied", "http://127.0.0.1:4317", "local");
    access.decide(access.list().requests[0].id, null, false);
    assert.throws(() => access.poll(denied.device_code), /access_denied/);
    const expired = access.request("Expired", "http://127.0.0.1:4317", "local");
    now += 600001;
    assert.throws(() => access.poll(expired.device_code), /expired_token/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("directory identities retain separate room boundaries through migration, reuse, removal and logout", () => {
  const dir = fs.mkdtempSync(path.resolve("work/access-bindings-"));
  try {
    const access = new Access(dir);
    const rooms = [
      { id: "one", messages: [1, 2], agentIds: ["outbound"] },
      { id: "two", messages: [1, 2, 3, 4], agentIds: [] },
    ];
    const request = access.request("Reusable", "http://127.0.0.1:4317", "test");
    access.decide(access.list().requests[0].id, null, true);
    const token = access.poll(request.device_code);
    const account = access.authenticate(`Bearer ${token.access_token}`);
    assert.equal(token.context_id, "");
    assert.deepEqual(access.rooms(account, rooms), []);
    access.setRoomMembers(rooms[0], [account.id]);
    rooms[0].agentIds.push(account.id);
    access.setRoomMembers(rooms[1], [account.id]);
    rooms[1].agentIds.push(account.id);
    assert.deepEqual(account.bindings, { one: 2, two: 4 });
    assert.equal(access.canAccess(account.id, "__proto__"), false);
    rooms[0].messages.push(3);
    access.setRoomMembers(rooms[0], [account.id]);
    assert.equal(
      account.bindings.one,
      2,
      "unchanged membership retains boundary",
    );
    access.setRoomMembers(rooms[0], []);
    rooms[0].agentIds = ["outbound"];
    assert.equal(access.canAccess(account.id, "one"), false);
    rooms[0].messages.push(4);
    access.setRoomMembers(rooms[0], [account.id]);
    rooms[0].agentIds.push(account.id);
    assert.equal(
      account.bindings.one,
      4,
      "re-adding does not expose absent history",
    );
    assert.equal(account.bindings.two, 4, "other room grant is unchanged");

    // Simulate an existing pre-directory approval without touching live data.
    const legacy = { ...account, id: "legacy", roomId: "one", startIndex: 1 };
    delete legacy.bindings;
    access.db.accounts.push(legacy);
    assert.equal(access.migrateRooms(rooms), true);
    assert.equal(legacy.bindings.one, 1);
    assert.ok(rooms[0].agentIds.includes("outbound"));
    assert.ok(rooms[0].agentIds.includes("legacy"));
    assert.equal(rooms[0].memberSince.legacy, 1);
    access.setRoomMembers(rooms[0], [account.id]);
    rooms[0].agentIds = ["outbound", account.id];
    const restarted = new Access(dir);
    assert.equal(restarted.migrateRooms(rooms), false);
    assert.ok(
      !rooms[0].agentIds.includes("legacy"),
      "restart does not re-add removed approval",
    );

    const password = fs.readFileSync(access.passwordFile, "utf8").trim();
    const first = {
      headers: { cookie: `a2ahub_owner=${access.login(password, "one")}` },
    };
    const second = {
      headers: { cookie: `a2ahub_owner=${access.login(password, "two")}` },
    };
    assert.equal(access.owner(first), true);
    access.logout(first);
    assert.equal(access.owner(first), false);
    assert.equal(
      access.owner(second),
      true,
      "logout removes only this session",
    );
    access.revoke(account.id);
    assert.equal(access.canAccess(account.id, "two"), false);
    assert.throws(
      () => access.setRoomMembers(rooms[0], [account.id]),
      /expired/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("optional initial approval raises the allowance so every selected member receives the next message", async () => {
  const dir = fs.mkdtempSync(path.resolve("work/access-initial-join-"));
  try {
    const access = new Access(dir);
    const room = {
      id: "room",
      messages: [{ id: "old", role: "user", text: "Earlier topic" }],
      contexts: {},
      memberSince: {},
      agentIds: ["outbound"],
      replyLimit: 1,
      agentChat: true,
      paused: false,
    };
    const request = access.request("New member", "http://127.0.0.1", "test");
    access.decide(access.list().requests[0].id, room, true);
    const credential = access.poll(request.device_code, {
      rooms: [room],
      canJoinRoom: () => true,
    });
    const account = access.authenticate(`Bearer ${credential.access_token}`);
    assert.equal(credential.context_id, room.id);
    assert.deepEqual(room.agentIds, ["outbound", account.id]);
    assert.equal(room.replyLimit, 2);
    assert.equal(room.memberSince[account.id], 1);
    assert.equal(account.pendingRoomMembership, undefined);

    const calls = [];
    const chat = new GroupChat({
      publish() {},
      redact: (s) => s,
      cancel: async () => true,
      send: async (agent) => {
        calls.push(agent.id);
        return { text: "", state: "completed" };
      },
    });
    chat.start(
      room,
      room.agentIds.map((id) => ({ id, name: id, status: "connected" })),
      "New topic for everyone",
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, room.agentIds);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("initial approval rechecks full, active and missing rooms at token claim and never retries a fallback", () => {
  const dir = fs.mkdtempSync(path.resolve("work/access-initial-fallback-"));
  try {
    const access = new Access(dir);
    const room = (id, count) => ({
      id,
      messages: [1, 2],
      agentIds: Array.from({ length: count }, (_, i) => `${id}-${i}`),
      memberSince: {},
      replyLimit: Math.max(1, count),
    });
    const full = room("full", 5),
      active = room("active", 1),
      missing = room("missing", 1);
    const rooms = [full, active, missing];
    const approve = (name, selected) => {
      const request = access.request(name, "http://127.0.0.1", "test");
      access.decide(access.list().requests[0].id, selected, true);
      return request;
    };
    // Both approvals observe a remaining place, but only the first claim fits.
    const first = approve("Sixth member", full);
    const later = approve("Seventh member", full);
    const busy = approve("Active chat member", active);
    const deleted = approve("Missing chat member", missing);
    rooms.pop();
    const options = { rooms, canJoinRoom: (r) => r.id !== active.id };
    const firstToken = access.poll(first.device_code, options);
    assert.equal(firstToken.context_id, full.id);
    assert.equal(full.agentIds.length, 6);
    assert.equal(full.replyLimit, 6);

    const fallbacks = [later, busy, deleted].map((request) => {
      const token = access.poll(request.device_code, options);
      const account = access.authenticate(`Bearer ${token.access_token}`);
      assert.equal(token.context_id, "");
      assert.deepEqual(account.bindings, {});
      assert.equal(account.roomId, undefined);
      assert.equal(account.startIndex, undefined);
      assert.equal(account.pendingRoomMembership, undefined);
      assert.deepEqual(access.rooms(account, rooms), []);
      return account.id;
    });
    assert.equal(full.agentIds.length, 6);
    assert.deepEqual(active.agentIds, ["active-0"]);
    assert.equal(active.replyLimit, 1);
    assert.deepEqual(active.memberSince, {});

    full.agentIds.pop();
    rooms.push(missing);
    const restarted = new Access(dir);
    assert.equal(restarted.migrateRooms(rooms), false);
    assert.ok(
      rooms.every((r) => fallbacks.every((id) => !r.agentIds.includes(id))),
    );

    // Legacy approvals use the same capacity protection during startup.
    const legacy = {
      id: "legacy",
      roomId: full.id,
      startIndex: 1,
      expiresAt: Date.now() + 60000,
    };
    full.agentIds.push("sixth-existing");
    restarted.db.accounts.push(legacy);
    assert.equal(restarted.migrateRooms(rooms), true);
    assert.deepEqual(legacy.bindings, {});
    assert.equal(legacy.roomId, undefined);
    assert.equal(full.agentIds.length, 6);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("A2A multi-room audiences, private posts, completion cursors and dispatch revalidation hold", async () => {
  const dir = fs.mkdtempSync(path.resolve("work/access-routing-"));
  const access = new Access(dir);
  const room = (id) => ({
    id,
    title: id,
    messages: [{ id: "old", role: "user", text: "old history" }],
    agentIds: [],
    agentChat: false,
  });
  const db = { rooms: [room("one"), room("two"), room("unassigned")] };
  const credentials = ["Alpha", "Beta"].map((name) => {
    const request = access.request(name, "http://127.0.0.1", "test");
    access.decide(access.list().requests[0].id, null, true);
    return access.poll(request.device_code);
  });
  const [alpha, beta] = credentials.map((c) =>
    access.authenticate(`Bearer ${c.access_token}`),
  );
  function members(room, ids) {
    access.setRoomMembers(room, ids);
    room.agentIds = ids;
  }
  members(db.rooms[0], [alpha.id, beta.id]);
  members(db.rooms[1], [alpha.id]);
  let posted = 0;
  const calls = [];
  const broker = {
    next: async (account, command) => {
      calls.push({ action: "next", id: account.id, command });
      if (command.revokeDuringWait) access.revoke(account.id);
      return {
        dispatch: { roomId: "one", prompt: "authorized prompt" },
        cancellations: [],
      };
    },
    report: async (account, command) => {
      calls.push({ action: "report", id: account.id, command });
      return { ok: true };
    },
  };
  const app = express();
  app.use(express.json());
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  mountInbound(app, {
    access,
    db,
    publish: () => {},
    origin,
    broker,
    onPost: () => posted++,
  });
  async function makeClient(credential) {
    return new ClientFactory({
      transports: [
        new JsonRpcTransportFactory({
          fetchImpl: (url, init = {}) => {
            const headers = new Headers(init.headers);
            headers.set("Authorization", `Bearer ${credential.access_token}`);
            return fetch(url, { ...init, headers });
          },
        }),
      ],
    }).createFromUrl(origin);
  }
  try {
    const [a, b] = await Promise.all(credentials.map(makeClient));
    async function send(
      client,
      data,
      messageId = crypto.randomUUID(),
      contextId = "",
    ) {
      const result = await client.sendMessage({
        tenant: "",
        message: {
          messageId,
          contextId,
          taskId: "",
          role: Role.ROLE_USER,
          parts: [
            {
              content: { $case: "data", value: data },
              mediaType: "application/json",
              filename: "",
            },
          ],
          extensions: [],
          referenceTaskIds: [],
        },
      });
      return (result.payload?.value || result).parts[0].content.value;
    }
    assert.deepEqual(
      (await send(a, { action: "list_rooms" })).rooms.map((r) => r.id),
      ["one", "two"],
    );
    assert.deepEqual(
      (await send(b, { action: "list_rooms" })).rooms.map((r) => r.id),
      ["one"],
    );
    assert.match(
      (await send(b, { action: "read_messages", roomId: "two" })).error,
      /denied/,
    );
    assert.deepEqual(
      (await send(a, { action: "read_messages", roomId: "one", cursor: 0 }))
        .messages,
      [],
    );
    const one = db.rooms[0];
    one.messages.push(
      { id: "human", role: "user", text: "visible", recipientIds: [alpha.id] },
      {
        id: "private",
        role: "agent",
        text: "private",
        shared: false,
        state: "completed",
        inboundAccountId: beta.id,
        recipientIds: [alpha.id],
      },
      {
        id: "other-human",
        role: "user",
        text: "not addressed to Alpha",
        recipientIds: [beta.id],
      },
      {
        id: "other-working",
        role: "agent",
        shared: true,
        state: "working",
        recipientIds: [beta.id],
      },
      {
        id: "working",
        role: "agent",
        shared: true,
        state: "working",
        recipientIds: [alpha.id],
      },
    );
    const first = await send(a, {
      action: "read_messages",
      roomId: "one",
      cursor: 0,
    });
    assert.deepEqual(
      first.messages.map((m) => m.id),
      ["human"],
    );
    assert.equal(
      first.next_cursor,
      5,
      "only a readable streamed reply holds the cursor",
    );
    Object.assign(one.messages[5], {
      state: "completed",
      text: "complete response",
    });
    assert.deepEqual(
      (
        await send(a, { action: "read_messages", roomId: "one", cursor: 5 })
      ).messages.map((m) => m.id),
      ["working"],
    );
    // Do not keep another peer's fixture stream pending during later assertions.
    one.messages[4].state = "completed";
    const messageId = crypto.randomUUID();
    await send(
      a,
      { action: "post_message", roomId: "one", text: "private answer" },
      messageId,
    );
    await send(
      a,
      { action: "post_message", roomId: "one", text: "private answer" },
      messageId,
    );
    assert.equal(posted, 1, "duplicate posts do not wake peers twice");
    assert.equal(one.messages.at(-1).agentId, alpha.id);
    assert.equal(one.messages.at(-1).shared, false);
    assert.ok(
      !(
        await send(b, { action: "read_messages", roomId: "one" })
      ).messages.some((m) => m.text === "private answer"),
    );
    one.agentChat = true;
    await send(a, {
      action: "post_message",
      roomId: "one",
      text: "shared answer",
    });
    assert.ok(
      (await send(b, { action: "read_messages", roomId: "one" })).messages.some(
        (m) => m.text === "shared answer",
      ),
    );
    members(db.rooms[1], []);
    assert.match(
      (
        await send(a, {
          action: "post_message",
          roomId: "two",
          text: "removed",
        })
      ).error,
      /denied/,
    );
    assert.equal(
      (
        await send(
          a,
          { action: "read_messages", roomId: "one" },
          undefined,
          "protocol-context",
        )
      ).error,
      undefined,
      "explicit authorized room takes precedence over opaque A2A context",
    );
    assert.match(
      (await send(b, { action: "read_messages" }, undefined, "two")).error,
      /denied/,
    );
    const dispatched = await send(a, {
      action: "next_dispatch",
      connectorId: "alpha",
      available: true,
    });
    assert.equal(dispatched.dispatch.roomId, "one");
    await send(a, {
      action: "report_dispatch",
      accountId: beta.id,
      dispatchId: "one",
      leaseId: "secret-fixture",
      connectorId: "alpha",
      kind: "complete",
      result: { text: "done", state: "completed" },
    });
    assert.equal(
      calls.at(-1).id,
      alpha.id,
      "command cannot impersonate another credential",
    );
    const revoked = await send(a, {
      action: "next_dispatch",
      connectorId: "alpha",
      available: true,
      revokeDuringWait: true,
    });
    assert.match(revoked.error, /revoked/);
    assert.equal(
      revoked.dispatch,
      undefined,
      "long poll cannot return a revoked prompt",
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("owner-approved A2A reads and posts only new shared messages; revocation and owner boundary hold", async () => {
  const dir = fs.mkdtempSync(path.resolve("work/access-http-"));
  fs.writeFileSync(
    path.join(dir, "workspace.json"),
    JSON.stringify({
      agents: [],
      rooms: [
        {
          id: "shared",
          title: "Shared",
          messages: [
            { id: "old", role: "user", text: "not shared before approval" },
          ],
          contexts: {},
        },
        { id: "private", title: "Private", messages: [], contexts: {} },
      ],
    }),
  );
  const origin = "http://127.0.0.1:4328";
  const child = spawn(process.execPath, ["server/index.js"], {
    env: {
      ...process.env,
      PORT: "4328",
      A2AHUB_DATA_DIR: dir,
      A2AHUB_OWNER_PASSWORD: "mock-owner",
    },
    stdio: "ignore",
  });
  let cookie = "";
  async function call(route, body, owner = false, method = "POST") {
    const res = await fetch(origin + route, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(owner ? { Cookie: cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { res, data: await res.json() };
  }
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(origin + "/auth/session")).ok) {
          ready = true;
          break;
        }
      } catch {}
      await sleep(100);
    }
    assert.ok(ready, "server starts");
    assert.equal(
      (await call("/api/state", null, false, "GET")).res.status,
      401,
    );
    assert.equal(
      (
        await call("/api/access/x/decision", {
          approved: true,
          roomId: "shared",
        })
      ).res.status,
      401,
    );
    const login = await call("/auth/login", { password: "mock-owner" });
    cookie = login.res.headers.get("set-cookie").split(";")[0];
    const device = (await call("/auth/device", { name: "Test Hermes" })).data;
    const id = new URL(device.verification_uri).searchParams.get("request");
    assert.equal(
      (
        await call(
          `/api/access/${id}/decision`,
          { approved: true, roomId: "shared" },
          true,
        )
      ).res.status,
      200,
    );
    const credential = (
      await call("/auth/token", { device_code: device.device_code })
    ).data;
    assert.ok(credential.access_token);
    const authFetch = (url, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${credential.access_token}`);
      return fetch(url, { ...init, headers });
    };
    const client = await new ClientFactory({
      transports: [new JsonRpcTransportFactory({ fetchImpl: authFetch })],
    }).createFromUrl(origin);
    async function send(
      data,
      contextId = "shared",
      messageId = crypto.randomUUID(),
    ) {
      const result = await client.sendMessage({
        tenant: "",
        message: {
          messageId,
          contextId,
          taskId: "",
          role: Role.ROLE_USER,
          parts: [
            {
              content: { $case: "data", value: data },
              mediaType: "application/json",
              filename: "",
            },
          ],
          extensions: [],
          referenceTaskIds: [],
        },
      });
      return (result.payload?.value || result).parts[0].content.value;
    }
    assert.deepEqual(
      (await send({ action: "read_messages", cursor: 0 })).messages,
      [],
    );
    await call(
      "/api/runs",
      { roomId: "shared", text: "Hello approved agent" },
      true,
    );
    const messages = (await send({ action: "read_messages", cursor: 0 }))
      .messages;
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, "Hello approved agent");
    const messageId = crypto.randomUUID();
    const posted = await send(
      { action: "post_message", text: "Hello human" },
      "shared",
      messageId,
    );
    assert.ok(posted.message_id);
    assert.equal(
      (
        await send(
          { action: "post_message", text: "Hello human" },
          "shared",
          messageId,
        )
      ).duplicate,
      true,
    );
    assert.match(
      (await send({ action: "read_messages" }, "private")).error,
      /denied/,
    );
    await call("/api/rooms/shared/stop", {}, true);
    assert.match(
      (await send({ action: "post_message", text: "paused" })).error,
      /paused/,
    );
    const unauthorized = await authFetch(origin + "/api/state");
    assert.equal(unauthorized.status, 401);
    await call(`/api/access/${credential.account_id}`, null, true, "DELETE");
    await assert.rejects(() => send({ action: "read_messages" }));
    const cors = await fetch(origin + "/auth/login", {
      method: "POST",
      headers: {
        Origin: "https://untrusted.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password: "mock-owner" }),
    });
    assert.equal(cors.status, 403);
  } finally {
    child.kill();
    await once(child, "exit");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

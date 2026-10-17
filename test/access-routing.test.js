import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { Access } from "../server/access.js";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { Role } from "@a2a-js/sdk";
import express from "express";
import { mountInbound } from "../server/inbound.js";

fs.mkdirSync("work", { recursive: true });
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

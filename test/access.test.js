import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Access } from "../server/access.js";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { Role } from "@a2a-js/sdk";

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

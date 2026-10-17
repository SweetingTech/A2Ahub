import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Access } from "../server/access.js";
import { GroupChat } from "../server/chat.js";

fs.mkdirSync("work", { recursive: true });
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

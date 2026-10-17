import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Access } from "../server/access.js";

fs.mkdirSync("work", { recursive: true });
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

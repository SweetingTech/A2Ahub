import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRoomLink,
  parseRoomLink,
  MOCK_CONTRACT,
  mockAgentCard,
} from "../server/room-links.js";

test("Phase 4 A: buildRoomLink produces a join link with room ID", () => {
  const link = buildRoomLink("http://127.0.0.1:4317", "room-123");
  assert.ok(link.includes("#join?room=room-123"));
  assert.ok(link.startsWith("http://127.0.0.1:4317/"));
});

test("Phase 4 B: buildRoomLink with mock=true includes mock flag", () => {
  const link = buildRoomLink("http://127.0.0.1:4317", "room-123", { mock: true });
  assert.ok(link.includes("mock=1"));
  const parsed = parseRoomLink(link);
  assert.equal(parsed.roomId, "room-123");
  assert.equal(parsed.mock, true);
  assert.equal(parsed.hubOrigin, "http://127.0.0.1:4317");
});

test("Phase 4 C: parseRoomLink returns null for non-join URLs", () => {
  assert.equal(parseRoomLink("http://127.0.0.1:4317/"), null);
  assert.equal(parseRoomLink("http://127.0.0.1:4317/#other"), null);
  assert.equal(parseRoomLink("not a url"), null);
});

test("Phase 4 D: parseRoomLink extracts roomId and mock from valid link", () => {
  const link = buildRoomLink("http://localhost:4317", "abc-xyz", { mock: false });
  const parsed = parseRoomLink(link);
  assert.equal(parsed.roomId, "abc-xyz");
  assert.equal(parsed.mock, false);
});

test("Phase 4 E: MOCK_CONTRACT has expected structure", () => {
  assert.equal(MOCK_CONTRACT.type, "mock");
  assert.ok(MOCK_CONTRACT.reply);
  assert.equal(MOCK_CONTRACT.reply.state, "completed");
  assert.ok(Array.isArray(MOCK_CONTRACT.skills));
  assert.ok(MOCK_CONTRACT.skills.length > 0);
});

test("Phase 4 F: mockAgentCard produces a valid agent card", () => {
  const card = mockAgentCard("http://127.0.0.1:4317", "TestMock");
  assert.equal(card.name, "TestMock");
  assert.ok(card.capabilities);
  assert.ok(card.supportedInterfaces);
  assert.ok(card.supportedInterfaces[0].url.includes("/a2a/jsonrpc"));
  assert.equal(card.supportedInterfaces[0].protocolVersion, "1.0");
});

test("Phase 4 G: room-link round-trip preserves all fields", () => {
  const hubOrigin = "http://127.0.0.1:9999";
  const roomId = "room-test-456";
  const link = buildRoomLink(hubOrigin, roomId, { mock: true });
  const parsed = parseRoomLink(link);
  assert.equal(parsed.hubOrigin, hubOrigin);
  assert.equal(parsed.roomId, roomId);
  assert.equal(parsed.mock, true);
});

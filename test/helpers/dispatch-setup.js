import assert from "node:assert/strict";
import { DispatchBroker } from "../../server/dispatch.js";

export const account = { id: "agent-a" };
export const agent = { id: account.id, inboundAccountId: account.id };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await pause(10);
  }
  assert.fail("Expected condition was not reached");
}

export function setup(t, overrides = {}) {
  const allowed = new Set(["agent-a/room-a", "agent-a/room-b"]);
  const broker = new DispatchBroker({
    isAuthorized: (a, r) => allowed.has(`${a}/${r}`),
    pollMs: 20,
    cancelMs: 100,
    ...overrides,
  });
  t.after(() => broker.close());
  const poll = (extra = {}, who = account) =>
    broker.next(who, { connectorId: "connector-a", waitMs: 0, ...extra });
  const report = (dispatch, extra = {}, who = account) =>
    broker.report(who, {
      connectorId: "connector-a",
      dispatchId: dispatch.dispatchId,
      leaseId: dispatch.leaseId,
      kind: "complete",
      result: {
        text: "reply",
        state: "completed",
        contextId: dispatch.context.contextId,
      },
      ...extra,
    });
  return { broker, allowed, poll, report };
}

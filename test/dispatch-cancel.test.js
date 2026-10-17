import test from "node:test";
import assert from "node:assert/strict";
import { account, agent, setup } from "./helpers/dispatch-setup.js";

test("Stop rejects late replies and confirms cancellation only after connector acknowledgment", async (t) => {
  const { broker, poll, report } = setup(t);
  await poll();
  const controller = new AbortController();
  const work = broker.send(agent, "run", {}, controller.signal, () => {}, {
    roomId: "room-a",
  });
  const rejected = assert.rejects(work, /Stopped/);
  const { dispatch } = await poll();
  controller.abort();
  await rejected;
  const canceled = broker.cancel(agent, dispatch.dispatchId);
  assert.equal(report(dispatch).accepted, false);
  assert.equal((await poll()).cancellations[0].dispatchId, dispatch.dispatchId);
  report(dispatch, { kind: "canceled", canceled: true });
  assert.equal(await canceled, true);
  assert.equal((await poll()).cancellations.length, 0);
});

test("revocation/removal cancels dispatch and blocks late replies, restart has no jobs", async (t) => {
  const { broker, poll, report, allowed } = setup(t);
  await poll();
  const work = broker.send(agent, "run", {}, null, () => {}, {
    roomId: "room-a",
  });
  const rejected = assert.rejects(work, /access/);
  const { dispatch } = await poll();
  allowed.delete("agent-a/room-a");
  broker.invalidate(account.id, "room-a");
  await rejected;
  assert.equal(report(dispatch).accepted, false);
  assert.equal(await broker.cancel(agent, dispatch.dispatchId), false);
  const other = setup(t).broker;
  assert.equal(
    (await other.next(account, { connectorId: "replacement", waitMs: 0 }))
      .dispatch,
    null,
  );
});

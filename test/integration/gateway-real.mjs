#!/usr/bin/env node
// Real-transport gateway integration test: a spawned Hub process, real device
// approvals, real connector and SessionReceiver code over HTTP and SSE, mock
// native A2A agents. No paid models, no in-process broker shortcuts.
import fs from "node:fs";
import { createHub } from "./harness.mjs";
import { scenarioA, scenarioB } from "./scenarios-ab.mjs";
import { scenarioC, scenarioD } from "./scenarios-cd.mjs";
import { scenarioE, scenarioF, scenarioG } from "./scenarios-efg.mjs";

const scenarios = [
  ["A concurrent three-agent conversation with Gamma barrier", scenarioA],
  [
    "B >500 offline events, paged SSE replay, live handoff, second room",
    scenarioB,
  ],
  [
    "C remove/re-add, revoke, archive, pause, owner/agent separation",
    scenarioC,
  ],
  ["D SessionReceiver survives Hub restart without replay", scenarioD],
  ["E cold-start Stop-all and idle Resume", scenarioE],
  ["F durable receipts across dropped ack and restart", scenarioF],
  ["G credential expiry via test clock", scenarioG],
];

const ctx = { hub: await createHub(), natives: {}, logs: [] };
let failed = 0;
let skipped = false;
try {
  for (const [name, run] of scenarios) {
    if (skipped) {
      console.log(`not ok - ${name} # SKIP earlier scenario failed`);
      failed += 1;
      continue;
    }
    const started = Date.now();
    try {
      const detail = await run(ctx);
      console.log(
        `ok - ${name} (${Date.now() - started}ms)${detail ? " " + JSON.stringify(detail) : ""}`,
      );
    } catch (error) {
      failed += 1;
      skipped = true;
      console.log(
        `not ok - ${name}\n  ${error.stack?.split("\n").slice(0, 4).join("\n  ")}`,
      );
      console.log(`  Hub output tail:\n${ctx.hub.output.slice(-1500)}`);
      console.log(`  Client logs:\n    ${ctx.logs.slice(-30).join("\n    ")}`);
    }
  }
} finally {
  ctx.receiver?.controller.abort();
  if (ctx.target) ctx.target.running = false;
  for (const key of ["alpha", "beta", "gamma"])
    ctx[key]?.connector?.controller.abort();
  for (const native of Object.values(ctx.natives)) native.close();
  await ctx.hub.cleanup();
  if (ctx.receiverDir)
    fs.rmSync(ctx.receiverDir, { recursive: true, force: true });
}
console.log(
  `\n${scenarios.length - failed}/${scenarios.length} real-transport scenarios passed`,
);
process.exit(failed ? 1 : 0);

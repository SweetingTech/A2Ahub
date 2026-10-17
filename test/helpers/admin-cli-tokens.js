import assert from "node:assert/strict";
import fs from "node:fs";
import { mockAgent } from "./admin-harness.js";

export async function cliTokensSection(ctx, state) {
  const { request, cli } = ctx;
  const { fullToken, readToken } = state;

  // CLI against the token; login creates its own private token.
  const status = JSON.parse(
    (await cli(["status", "--json"], { A2AHUB_MANAGER_TOKEN: fullToken }))
      .stdout,
  );
  assert.equal(status.server.headless, true);
  await cli(["folder", "create", "Writing", "--color", "purple"], {
    A2AHUB_MANAGER_TOKEN: fullToken,
  });
  await cli(["new", "Blog", "draft", "--folder", "Writing"], {
    A2AHUB_MANAGER_TOKEN: fullToken,
  });
  const rooms = JSON.parse(
    (await cli(["rooms", "--json"], { A2AHUB_MANAGER_TOKEN: fullToken }))
      .stdout,
  );
  assert.ok(rooms.some((r) => r.title === "Blog draft"));
  await assert.rejects(
    cli(["status"], { A2AHUB_MANAGER_TOKEN: readToken }),
    /lacks the admin scope/,
  );
  // Credentials are only ever sent to loopback Hub addresses.
  await assert.rejects(
    cli(["status", "--url", "https://example.invalid"], {
      A2AHUB_MANAGER_TOKEN: fullToken,
    }),
    /loopback-only/,
  );

  // Bodyless CLI mutations must really change server state.
  const asOwner = { A2AHUB_MANAGER_TOKEN: fullToken };
  const target = (await request("/api/v1/rooms", {}, { token: fullToken }))
    .data;
  await request(
    `/api/v1/rooms/${target.id}`,
    { title: "CLI target" },
    { method: "PATCH", token: fullToken },
  );
  const roomState = async () =>
    (
      await request(`/api/v1/rooms/${target.id}`, undefined, {
        token: fullToken,
      })
    ).data;
  await cli(["stop", target.id], asOwner);
  assert.equal((await roomState()).paused, true);
  await cli(["resume", target.id], asOwner);
  assert.equal((await roomState()).paused, false);
  await cli(["archive", target.id], asOwner);
  assert.equal((await roomState()).archived, true);
  await cli(["restore", target.id], asOwner);
  assert.equal((await roomState()).archived, false);
  const backupOut = (await cli(["backup"], asOwner)).stdout;
  assert.doesNotMatch(backupOut, /undefined/);
  const backupFile = backupOut.match(/Backup written to (.+)$/m)[1].trim();
  assert.ok(fs.existsSync(backupFile));
  // CLI stop --all also seals all non-archived rooms.
  const cliStopAll = JSON.parse(
    (await cli(["stop", "--all", "--json"], asOwner)).stdout,
  );
  assert.ok(cliStopAll.stopped.length > 0);

  // say --watch shows every reply of its burst and exits 0 when it ends.
  const alpha = await mockAgent("Alpha", 400);
  const beta = await mockAgent("Beta", 50);
  try {
    const a = await request(
      "/api/v1/agents",
      { url: alpha.url },
      {
        token: fullToken,
      },
    );
    const b = await request(
      "/api/v1/agents",
      { url: beta.url },
      {
        token: fullToken,
      },
    );
    assert.equal(a.status, 200, JSON.stringify(a.data));
    await request(
      `/api/v1/rooms/${target.id}`,
      { agentIds: [a.data.id, b.data.id], agentChat: false, replyLimit: 2 },
      { method: "PATCH", token: fullToken },
    );
    // Restore kept the room paused; resuming is explicit.
    await cli(["resume", target.id], asOwner);
    const watched = await cli(
      ["say", target.id, "Hello", "agents", "--watch"],
      asOwner,
    );
    assert.match(watched.stdout, /Alpha reply/);
    assert.match(watched.stdout, /Beta reply/);
    assert.match(watched.stdout, /completed · 2\/2 requests/);
    assert.doesNotMatch(watched.stderr, /abort/i);
    // --json with --watch is line-delimited JSON only.
    const events = (
      await cli(["say", target.id, "Again", "--watch", "--json"], asOwner)
    ).stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events[0].type, "started");
    assert.ok(
      events.some((e) => e.type === "message" && e.text === "Alpha reply"),
    );
    assert.ok(
      events.some((e) => e.type === "status" && e.state === "completed"),
    );
  } finally {
    alpha.close();
    beta.close();
  }
}

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import http from "node:http";

const run = promisify(execFile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Minimal A2A 0.3 agent that answers after a delay, without model calls.
async function mockAgent(name, delay) {
  let url;
  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET") {
      res.end(JSON.stringify({ name, url, protocolVersion: "0.3" }));
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const call = JSON.parse(body);
    setTimeout(
      () =>
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: call.id,
            result: {
              kind: "message",
              role: "agent",
              parts: [{ kind: "text", text: `${name} reply` }],
            },
          }),
        ),
      delay,
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}/`;
  return {
    url,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
async function unusedPort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

test("headless owner API: manager token scopes, folders, archive, admin, password and CLI", async () => {
  fs.mkdirSync("work", { recursive: true });
  const dir = fs.mkdtempSync(path.resolve("work/admin-"));
  const cliHome = path.join(dir, "cli");
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  let output = "";
  const child = spawn(process.execPath, ["server/index.js", "--headless"], {
    env: {
      ...process.env,
      PORT: String(port),
      A2AHUB_DATA_DIR: dir,
      A2AHUB_OWNER_PASSWORD: "admin-mock-owner",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (b) => (output += b));
  child.stderr.on("data", (b) => (output += b));
  async function request(route, body, { method, cookie, token } = {}) {
    const response = await fetch(origin + route, {
      method: method || (body === undefined ? "GET" : "POST"),
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: response.status, data, response };
  }
  async function login(password = "admin-mock-owner") {
    const result = await request("/auth/login", { password });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.response.headers.get("set-cookie").split(";")[0];
  }
  async function cli(args, env = {}) {
    return run(process.execPath, ["scripts/a2ahub.mjs", ...args], {
      env: {
        ...process.env,
        A2AHUB_URL: origin,
        A2AHUB_CLI_HOME: cliHome,
        A2AHUB_OWNER_PASSWORD: "",
        ...env,
      },
    });
  }
  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(origin + "/auth/session")).ok) break;
      } catch {}
      if (child.exitCode !== null) throw new Error(output);
      await pause(50);
    }
    assert.match(output, /headless API ready/);

    // Headless serves JSON only; no web interface is mounted.
    const rootInfo = await request("/");
    assert.equal(rootInfo.data.headless, true);
    assert.equal(rootInfo.data.api, `${origin}/api/v1`);
    const page = await request("/agents");
    assert.equal(page.status, 404);
    assert.doesNotMatch(JSON.stringify(page.data), /<html/i);
    const session = await request("/auth/session");
    assert.equal(session.data.headless, true);
    assert.equal(session.data.passwordLocation, null);

    const cookie = await login();
    const full = await request(
      "/api/v1/manager-tokens",
      { name: "test-full", scopes: ["read", "chat", "admin"] },
      { cookie },
    );
    assert.equal(full.status, 201, JSON.stringify(full.data));
    assert.match(full.data.token, /^a2m_/);
    assert.equal(full.data.tokenHash, undefined);
    const reader = await request(
      "/api/v1/manager-tokens",
      { name: "test-read", scopes: ["read"] },
      { cookie },
    );
    const fullToken = full.data.token,
      readToken = reader.data.token;

    // Scope enforcement and separation from owner-only and agent routes.
    assert.equal(
      (await request("/api/v1/state", undefined, { token: readToken })).status,
      200,
    );
    assert.equal(
      (await request("/api/v1/rooms", {}, { token: readToken })).status,
      403,
    );
    assert.equal(
      (await request("/api/v1/admin", undefined, { token: readToken })).status,
      403,
    );
    assert.equal(
      (
        await request(
          "/api/v1/manager-tokens",
          { name: "escalate", scopes: ["admin"] },
          { token: fullToken },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          "/api/v1/admin/password",
          { current: "x", next: "y" },
          { token: fullToken },
        )
      ).status,
      403,
    );
    assert.equal(
      (await request("/api/v1/state", undefined, { token: "a2m_wrong" }))
        .status,
      401,
    );
    assert.equal(
      (await request("/api/v1/state", undefined, { token: "hub_agent" }))
        .status,
      401,
    );
    const asAgent = await request(
      "/a2a/jsonrpc",
      { jsonrpc: "2.0", id: "1", method: "SendMessage", params: {} },
      { token: fullToken },
    );
    assert.ok(
      asAgent.data.error,
      "a manager token must not authenticate as an agent",
    );
    // Scope checks must follow Express's case-insensitive, slash-tolerant routing.
    for (const route of [
      "/api/ADMIN",
      "/api/Access",
      "/api/v1/ADMIN/audit",
      "/api/%61dmin",
      "/api//admin",
      "/api/MANAGER-TOKENS",
    ])
      assert.equal(
        (await request(route, undefined, { token: readToken })).status,
        403,
        route,
      );
    // The unversioned path keeps working for the web interface.
    assert.equal(
      (await request("/api/state", undefined, { token: fullToken })).status,
      200,
    );

    // Folders and filing.
    const folder = await request(
      "/api/v1/folders",
      { name: "Home lab", color: "teal" },
      { token: fullToken },
    );
    assert.equal(folder.status, 200, JSON.stringify(folder.data));
    assert.equal(
      (
        await request(
          "/api/v1/folders",
          { name: "Bad", color: "neon" },
          { token: fullToken },
        )
      ).status,
      400,
    );
    const room = (
      await request(
        "/api/v1/rooms",
        { folderId: folder.data.id },
        { token: fullToken },
      )
    ).data;
    assert.equal(room.folderId, folder.data.id);
    assert.equal(
      (
        await request(
          `/api/v1/rooms/${room.id}`,
          { pinned: true },
          { method: "PATCH", token: fullToken },
        )
      ).data.pinned,
      true,
    );
    await request(`/api/v1/folders/${folder.data.id}`, undefined, {
      method: "DELETE",
      token: fullToken,
    });
    const unfiled = (
      await request(`/api/v1/rooms/${room.id}`, undefined, { token: fullToken })
    ).data;
    assert.equal(unfiled.folderId, null);

    // Archive is read-only and paused; restore stays paused; delete needs archive.
    assert.equal(
      (
        await request(`/api/v1/rooms/${room.id}`, undefined, {
          method: "DELETE",
          token: fullToken,
        })
      ).status,
      400,
    );
    const archived = (
      await request(
        `/api/v1/rooms/${room.id}/archive`,
        {},
        { token: fullToken },
      )
    ).data;
    assert.equal(archived.archived, true);
    assert.equal(archived.paused, true);
    for (const route of [
      `/rooms/${room.id}/messages`,
      `/rooms/${room.id}/continue`,
      `/rooms/${room.id}/resume`,
    ]) {
      const blocked = await request(
        `/api/v1${route}`,
        { text: "hello" },
        { token: fullToken },
      );
      assert.equal(blocked.status, 400, route);
      assert.match(blocked.data.error, /archived/i);
    }
    assert.equal(
      (
        await request(
          `/api/v1/rooms/${room.id}`,
          { replyLimit: 3 },
          { method: "PATCH", token: fullToken },
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await request(
          `/api/v1/rooms/${room.id}`,
          { title: "Old notes" },
          { method: "PATCH", token: fullToken },
        )
      ).status,
      200,
    );
    const restored = (
      await request(
        `/api/v1/rooms/${room.id}/unarchive`,
        {},
        { token: fullToken },
      )
    ).data;
    assert.equal(restored.archived, false);
    assert.equal(restored.paused, true, "restoring must not resume agents");
    await request(`/api/v1/rooms/${room.id}/archive`, {}, { token: fullToken });
    assert.equal(
      (
        await request(`/api/v1/rooms/${room.id}`, undefined, {
          method: "DELETE",
          token: fullToken,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(`/api/v1/rooms/${room.id}`, undefined, {
          token: fullToken,
        })
      ).status,
      400,
    );

    // Device approval from a screenless client must echo the verification code.
    const device = await request("/auth/device", { name: "Helper" });
    assert.equal(device.status, 201);
    const pending = (
      await request("/api/v1/access", undefined, { token: fullToken })
    ).data.requests[0];
    assert.equal(
      (
        await request(
          `/api/v1/access/${pending.id}/decision`,
          { approved: true, userCode: "WRONG" },
          { token: fullToken },
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await request(
          `/api/v1/access/${pending.id}/decision`,
          { approved: true, userCode: pending.userCode.toLowerCase() },
          { token: fullToken },
        )
      ).status,
      200,
    );

    // An approval for a room that is archived before the agent collects its
    // credential falls back to directory-only; archived rooms can't be chosen.
    const raceRoom = (await request("/api/v1/rooms", {}, { token: fullToken }))
      .data;
    const racer = (await request("/auth/device", { name: "Racer" })).data;
    const racerRequest = (
      await request("/api/v1/access", undefined, { token: fullToken })
    ).data.requests.find((r) => r.name === "Racer");
    assert.equal(
      (
        await request(
          `/api/v1/access/${racerRequest.id}/decision`,
          { approved: true, roomId: raceRoom.id },
          { token: fullToken },
        )
      ).status,
      200,
    );
    await request(
      `/api/v1/rooms/${raceRoom.id}/archive`,
      {},
      {
        token: fullToken,
      },
    );
    const collected = await request("/auth/token", {
      device_code: racer.device_code,
    });
    assert.equal(collected.status, 200, JSON.stringify(collected.data));
    const afterRace = (
      await request(`/api/v1/rooms/${raceRoom.id}`, undefined, {
        token: fullToken,
      })
    ).data;
    assert.equal(afterRace.archived, true);
    assert.deepEqual(afterRace.agentIds, []);
    const racerAccount = (
      await request("/api/v1/access", undefined, { token: fullToken })
    ).data.accounts.find((a) => a.name === "Racer");
    assert.ok(!Object.hasOwn(racerAccount.bindings, raceRoom.id));

    // An archived room delivers no history to a member agent.
    const readRoom = async (roomId) => {
      const response = await fetch(origin + "/a2a/jsonrpc", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "A2A-Version": "1.0",
          Authorization: `Bearer ${collected.data.access_token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "read",
          method: "SendMessage",
          params: {
            message: {
              messageId: `read-${Date.now()}`,
              role: "ROLE_USER",
              contextId: roomId,
              parts: [{ data: { action: "read_messages", roomId } }],
            },
          },
        }),
      });
      return JSON.stringify(await response.json());
    };
    const memberRoom = (
      await request("/api/v1/rooms", {}, { token: fullToken })
    ).data;
    await request(
      `/api/v1/rooms/${memberRoom.id}`,
      { agentIds: [racerAccount.id] },
      { method: "PATCH", token: fullToken },
    );
    assert.match(await readRoom(memberRoom.id), /next_cursor/);
    await request(
      `/api/v1/rooms/${memberRoom.id}/archive`,
      {},
      {
        token: fullToken,
      },
    );
    const archivedRead = await readRoom(memberRoom.id);
    assert.match(archivedRead, /archived/);
    assert.doesNotMatch(archivedRead, /next_cursor/);
    await request("/auth/device", { name: "Late" });
    const late = (
      await request("/api/v1/access", undefined, { token: fullToken })
    ).data.requests.find((r) => r.name === "Late");
    const lateDecision = await request(
      `/api/v1/access/${late.id}/decision`,
      { approved: true, roomId: raceRoom.id },
      { token: fullToken },
    );
    assert.equal(lateDecision.status, 400);
    assert.match(lateDecision.data.error, /archived/);

    // Admin summary, backup and export never expose secrets.
    const admin = await request("/api/v1/admin", undefined, {
      token: fullToken,
    });
    assert.equal(admin.status, 200);
    assert.equal(admin.data.server.headless, true);
    assert.equal(admin.data.listeners.owner.loopbackOnly, true);
    assert.equal(admin.data.counts.managerTokens, 2);
    const adminText = JSON.stringify(admin.data);
    assert.ok(
      !adminText.includes(fullToken) && !adminText.includes("admin-mock-owner"),
    );
    const backup = await request(
      "/api/v1/admin/backup",
      {},
      { token: fullToken },
    );
    assert.ok(fs.existsSync(backup.data.file));
    assert.ok(backup.data.file.startsWith(path.join(dir, "backups")));
    const exported = await request("/api/v1/admin/export", undefined, {
      token: fullToken,
    });
    assert.ok(Array.isArray(exported.data.workspace.rooms));
    assert.match(
      exported.response.headers.get("content-disposition"),
      /attachment/,
    );
    assert.deepEqual(
      (await request("/api/v1/admin/stop-all", {}, { token: fullToken })).data
        .stopped,
      [],
    );
    const auditText = fs.readFileSync(path.join(dir, "audit.json"), "utf8");
    for (const action of [
      "manager_token.created",
      "room.archived",
      "room.deleted",
      "access.approved",
      "admin.backup",
    ])
      assert.match(auditText, new RegExp(action.replace(".", "\\.")));
    assert.ok(!auditText.includes(fullToken) && !auditText.includes("a2m_"));

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
    assert.deepEqual(
      JSON.parse((await cli(["stop", "--all", "--json"], asOwner)).stdout)
        .stopped,
      [],
    );

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
    const passwordFile = path.join(dir, "pw.txt");
    fs.writeFileSync(passwordFile, "admin-mock-owner\n");
    const loggedIn = await cli([
      "login",
      "--name",
      "cli-test",
      "--password-file",
      passwordFile,
    ]);
    assert.doesNotMatch(loggedIn.stdout, /a2m_|admin-mock-owner/);
    const config = JSON.parse(
      fs.readFileSync(path.join(cliHome, "manager.json"), "utf8"),
    );
    assert.match(config.token, /^a2m_/);
    if (process.platform !== "win32")
      assert.equal(
        fs.statSync(path.join(cliHome, "manager.json")).mode & 0o077,
        0,
      );
    const listed = JSON.parse((await cli(["tokens", "--json"])).stdout);
    assert.ok(listed.some((t) => t.name === "cli-test"));
    const configFile = path.join(cliHome, "manager.json");

    // Logging in again replaces the saved token and revokes the old one.
    const relogin = JSON.parse(
      (
        await cli([
          "login",
          "--name",
          "cli-test-2",
          "--password-file",
          passwordFile,
          "--json",
        ])
      ).stdout,
    );
    assert.equal(relogin.previousRevoked, true);
    const config2 = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.notEqual(config2.token, config.token);
    assert.equal(
      (await request("/api/v1/state", undefined, { token: config.token }))
        .status,
      401,
    );

    // "--" preserves text that looks like an option.
    await cli(["new", "--", "--compare", "plans"]);
    assert.ok(
      JSON.parse((await cli(["rooms", "--json"])).stdout).some(
        (r) => r.title === "--compare plans",
      ),
    );

    // Logout keeps the only copy when revocation cannot be confirmed.
    const deadHub = `http://127.0.0.1:${await unusedPort()}`;
    await assert.rejects(
      cli(["logout"], { A2AHUB_URL: deadHub }),
      /still saved/,
    );
    assert.ok(fs.existsSync(configFile));
    assert.equal(
      (await request("/api/v1/state", undefined, { token: config2.token }))
        .status,
      200,
    );
    await cli(["logout"]);
    assert.ok(!fs.existsSync(configFile));
    assert.equal(
      (await request("/api/v1/state", undefined, { token: config2.token }))
        .status,
      401,
    );

    // Password change: validation, old password rejected, file removed.
    const shortPw = await request(
      "/api/v1/admin/password",
      { current: "admin-mock-owner", next: "short" },
      { cookie },
    );
    assert.equal(shortPw.status, 400);
    const wrongPw = await request(
      "/api/v1/admin/password",
      { current: "nope", next: "a-much-longer-password" },
      { cookie },
    );
    assert.equal(wrongPw.status, 401);
    const otherSession = await login();
    const changed = await request(
      "/api/v1/admin/password",
      { current: "admin-mock-owner", next: "a-much-longer-password" },
      { cookie },
    );
    assert.equal(changed.status, 200);
    assert.equal(
      (await request("/api/v1/state", undefined, { cookie })).status,
      200,
    );
    assert.equal(
      (await request("/api/v1/state", undefined, { cookie: otherSession }))
        .status,
      401,
    );
    assert.equal(
      (await request("/auth/login", { password: "admin-mock-owner" })).status,
      401,
    );
    await login("a-much-longer-password");

    // A token can revoke itself; afterwards it is rejected.
    await request(`/api/v1/manager-tokens/${reader.data.id}`, undefined, {
      method: "DELETE",
      token: readToken,
    });
    assert.equal(
      (await request("/api/v1/state", undefined, { token: readToken })).status,
      401,
    );
  } finally {
    if (child.exitCode === null) {
      const ended = once(child, "exit");
      child.kill();
      await ended;
    }
  }
});

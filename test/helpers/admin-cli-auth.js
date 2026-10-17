import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { unusedPort } from "./admin-harness.js";

export async function cliAuthSection(ctx, state) {
  const { request, cli, dir, cliHome } = ctx;
  const { fullToken } = state;

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
    (await request("/api/v1/state", undefined, { token: config.token })).status,
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
}

export async function passwordSection(ctx, state) {
  const { request, login } = ctx;
  const { cookie, readToken, reader } = state;

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
}

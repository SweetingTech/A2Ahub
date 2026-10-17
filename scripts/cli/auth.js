// Auth/login commands for the a2ahub CLI.
// Exports a register function that attaches command handlers to a shared
// context object. The context provides: api, post, print, flags, json,
// hubOrigin, token, readConfig, configFile, home, fail, readPassword,
// revokeSelf, privateDirectory (from server/access.js).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

// Re-exported so the main entry point can wire helpers that live here.
export function readPassword(flags, fail) {
  if (flags["password-file"])
    return fs.readFileSync(flags["password-file"], "utf8").trim();
  if (process.env.A2AHUB_OWNER_PASSWORD)
    return process.env.A2AHUB_OWNER_PASSWORD;
  if (!process.stdin.isTTY)
    fail("No terminal to prompt in. Use --password-file FILE.");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  // Mute echo so the password never appears on screen or in scrollback.
  rl._writeToOutput = (s) => {
    if (s.includes("Owner password")) process.stdout.write(s);
  };
  const answer = new Promise((resolve) =>
    rl.question("Owner password: ", resolve),
  );
  return answer.then((value) => {
    rl.close();
    process.stdout.write("\n");
    return value;
  });
}

export function revokeSelf(hubOrigin, config) {
  return fetch(`${hubOrigin(config)}/api/v1/manager-tokens/${config.id}`, {
    method: "DELETE",
    redirect: "error",
    headers: { Authorization: `Bearer ${config.token}` },
  });
}

// `ctx` is the shared CLI context built in a2ahub.mjs.
export function registerAuth(ctx) {
  const { flags, json, hubOrigin, token, readConfig, configFile, home, fail } =
    ctx;

  async function login() {
    const origin = hubOrigin();
    const password = await readPassword(flags, fail);
    const signIn = await fetch(`${origin}/auth/login`, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }).catch(() => fail(`Cannot reach A2Ahub at ${origin}. Is it running?`));
    if (!signIn.ok) fail((await signIn.json()).error || "Sign-in failed.");
    const cookie = signIn.headers.get("set-cookie").split(";")[0];
    const owner = (route, body) =>
      fetch(`${origin}${route}`, {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify(body || {}),
      });
    const previous = readConfig();
    try {
      const scopes = (flags.scopes || "read,chat,admin")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await owner("/api/manager-tokens", {
        name: flags.name || `cli-${os.hostname()}`.slice(0, 60),
        scopes,
      });
      const created = await res.json();
      if (!res.ok) fail(created.error || "Could not create a manager token.");
      ctx.privateDirectory(home);
      fs.writeFileSync(
        configFile,
        JSON.stringify(
          {
            url: origin,
            token: created.token,
            id: created.id,
            name: created.name,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      // Replace, don't orphan: revoke the token this CLI held before.
      let replaced = null;
      if (previous.id && previous.token && previous.id !== created.id) {
        const res =
          previous.url === origin
            ? await fetch(`${origin}/api/manager-tokens/${previous.id}`, {
                method: "DELETE",
                redirect: "error",
                headers: { Cookie: cookie },
              }).catch(() => null)
            : await revokeSelf(hubOrigin, previous).catch(() => null);
        replaced = res && (res.ok || [401, 404].includes(res.status));
        if (!replaced)
          console.error(
            `a2ahub: could not revoke the previous token "${previous.name}". Revoke it on Settings › Headless & manager API.`,
          );
      }
      ctx.print(
        {
          ok: true,
          name: created.name,
          scopes: created.scopes,
          configFile,
          previousRevoked: replaced,
        },
        () =>
          console.log(
            `✓ Signed in as manager token "${created.name}" (${created.scopes.join(", ")}).\n  Saved privately to ${configFile}`,
          ),
      );
    } finally {
      // The CLI keeps only the scoped token, never an owner session.
      await owner("/auth/logout").catch(() => {});
    }
  }

  async function logout() {
    const config = readConfig();
    if (!config.token) {
      fs.rmSync(configFile, { force: true });
      return ctx.print({ ok: true, revoked: false }, () =>
        console.log("No saved token. Nothing to revoke."),
      );
    }
    // Keep the only local copy until the Hub confirms revocation; 401/404
    // mean the token is already unusable.
    const res = await revokeSelf(hubOrigin, config).catch(() => null);
    const revoked = !!res && (res.ok || [401, 404].includes(res.status));
    if (!revoked && !flags.local)
      fail(
        `Could not revoke "${config.name}" (${res ? `HTTP ${res.status}` : `cannot reach ${hubOrigin(config)}`}). ` +
          `The token is still saved at ${configFile}. Retry when the Hub is reachable, ` +
          `or run "a2ahub logout --local" and revoke it on Settings › Headless & manager API.`,
      );
    fs.rmSync(configFile, { force: true });
    ctx.print({ ok: true, revoked }, () =>
      console.log(
        revoked
          ? "✓ Token revoked and removed."
          : `Removed the saved token without revoking it. Revoke "${config.name}" on Settings › Headless & manager API.`,
      ),
    );
  }

  // `token` is referenced to keep the context signature uniform; login/logout
  // use their own credentials and never call the saved token helper.
  void token;

  return { login, logout };
}

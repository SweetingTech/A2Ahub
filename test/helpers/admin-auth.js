import assert from "node:assert/strict";
import { pause } from "./admin-harness.js";

export async function authSection(ctx) {
  const { child, origin, request, login } = ctx;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(origin + "/auth/session")).ok) break;
    } catch {}
    if (child.exitCode !== null) throw new Error(ctx.output);
    await pause(50);
  }
  assert.match(ctx.output, /headless API ready/);

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
    (await request("/api/v1/state", undefined, { token: "a2m_wrong" })).status,
    401,
  );
  assert.equal(
    (await request("/api/v1/state", undefined, { token: "hub_agent" })).status,
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

  return { cookie, fullToken, readToken, reader };
}

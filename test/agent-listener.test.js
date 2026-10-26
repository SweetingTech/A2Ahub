import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pause, unusedPort } from "./helpers/admin-harness.js";

test("agent listener allows exact aliases but never owner routes or unknown origins", async () => {
  fs.mkdirSync("work", { recursive: true });
  const dir = fs.mkdtempSync(path.resolve("work/agent-listener-"));
  const port = await unusedPort();
  const agentPort = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const agentOrigin = `http://127.0.0.1:${agentPort}`;
  const aliasOrigin = `http://agents.test:${agentPort}`;
  let output = "";
  const child = spawn(process.execPath, ["server/index.js", "--headless"], {
    env: {
      ...process.env,
      PORT: String(port),
      A2AHUB_DATA_DIR: dir,
      A2AHUB_OWNER_PASSWORD: "agent-listener-mock-owner",
      A2AHUB_AGENT_PORT: String(agentPort),
      A2AHUB_AGENT_HOST: "127.0.0.1",
      A2AHUB_PUBLIC_URL: agentOrigin,
      A2AHUB_AGENT_ORIGINS: `${aliasOrigin}, http://localhost:${agentPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  function request(
    route,
    { remote = false, host, origin: originHeader, cookie, body } = {},
  ) {
    return new Promise((resolve, reject) => {
      const req = http.request(`${remote ? agentOrigin : origin}${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          ...(host ? { Host: host } : {}),
          ...(originHeader ? { Origin: originHeader } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
      });
      req.on("error", reject);
      req.on("response", (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            data: JSON.parse(text),
            response: { headers: new Headers(res.headers) },
          }),
        );
      });
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        if (
          (await request("/.well-known/agent-card.json", { remote: true }))
            .status === 200
        ) {
          ready = true;
          break;
        }
      } catch {}
      if (child.exitCode !== null) throw new Error(output);
      await pause(50);
    }
    assert.ok(ready, output);

    const login = await request("/auth/login", {
      body: { password: "agent-listener-mock-owner" },
    });
    const cookie = login.response.headers.get("set-cookie").split(";")[0];
    for (const route of ["/", "/auth/session", "/api/state", "/api/access"]) {
      assert.equal(
        (await request(route, { remote: true, cookie })).status,
        404,
        route,
      );
    }
    assert.equal(
      (
        await request("/auth/login", {
          remote: true,
          body: { password: "agent-listener-mock-owner" },
        })
      ).status,
      404,
    );

    const aliasHost = new URL(aliasOrigin).host;
    const alias = await request("/.well-known/agent-card.json", {
      remote: true,
      host: aliasHost.toUpperCase(),
      origin: aliasOrigin,
    });
    assert.equal(alias.status, 200);
    assert.equal(
      alias.data.supportedInterfaces[0].url,
      `${agentOrigin}/a2a/jsonrpc`,
    );
    assert.equal(
      (
        await request("/.well-known/agent-card.json", {
          remote: true,
          host: "evil.test",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request("/.well-known/agent-card.json", {
          remote: true,
          host: aliasHost,
          origin: agentOrigin,
        })
      ).status,
      403,
      "an alias cannot borrow the canonical Origin",
    );
    const device = await request("/auth/device", {
      remote: true,
      host: aliasHost,
      body: { name: "LAN mock agent" },
    });
    assert.equal(device.status, 201);
    assert.equal(new URL(device.data.verification_uri).origin, origin);
  } finally {
    if (child.exitCode === null) {
      const ended = once(child, "exit");
      child.kill();
      await ended;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

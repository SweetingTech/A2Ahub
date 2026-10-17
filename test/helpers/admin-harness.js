import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";

const run = promisify(execFile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export { run, pause };

export async function unusedPort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

// Minimal A2A 0.3 agent that answers after a delay, without model calls.
export async function mockAgent(name, delay) {
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

export async function startHeadlessServer() {
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
  return {
    child,
    origin,
    dir,
    cliHome,
    get output() {
      return output;
    },
    request,
    login,
    cli,
    pause,
  };
}

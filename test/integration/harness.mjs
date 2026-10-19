// Real-process gateway harness: spawns server/index.js, drives the owner API
// over HTTP, approves agents through the device flow, and reads the agent
// event stream over real SSE. Nothing here touches Hub internals.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { unusedPort } from "../helpers/admin-harness.js";

export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PASSWORD = "gateway-integration-mock-owner";

export async function waitUntil(
  check,
  { timeout = 15000, label = "condition" } = {},
) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await pause(50);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

export async function createHub() {
  fs.mkdirSync("work", { recursive: true });
  const dir = fs.mkdtempSync(path.resolve("work/gateway-real-"));
  const port = await unusedPort();
  const agentPort = await unusedPort();
  const hub = {
    dir,
    origin: `http://127.0.0.1:${port}`,
    agentOrigin: `http://127.0.0.1:${agentPort}`,
    clockFile: path.join(dir, "test-clock.json"),
    output: "",
    child: null,
    cookie: null,
  };

  hub.start = async () => {
    const child = spawn(process.execPath, ["server/index.js", "--headless"], {
      env: {
        ...process.env,
        PORT: String(port),
        A2AHUB_AGENT_PORT: String(agentPort),
        A2AHUB_DATA_DIR: dir,
        A2AHUB_OWNER_PASSWORD: PASSWORD,
        A2AHUB_TEST_CLOCK_FILE: hub.clockFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    hub.child = child;
    child.stdout.on("data", (b) => (hub.output += b));
    child.stderr.on("data", (b) => (hub.output += b));
    await waitUntil(
      async () => {
        if (child.exitCode !== null)
          throw new Error(`Hub exited during startup:\n${hub.output}`);
        try {
          const [owner, agent] = await Promise.all([
            fetch(hub.origin + "/auth/session"),
            fetch(hub.agentOrigin + "/.well-known/agent-card.json"),
          ]);
          return owner.ok && agent.ok;
        } catch {
          return false;
        }
      },
      { label: "Hub startup" },
    );
    await hub.login();
  };

  // SIGKILL: no graceful shutdown, so restarts exercise crash consistency.
  hub.kill = async () => {
    const child = hub.child;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
  };

  hub.restart = async () => {
    await hub.kill();
    await hub.start();
  };

  hub.login = async () => {
    const r = await hub.request(
      "/auth/login",
      { password: PASSWORD },
      { owner: false },
    );
    assert.equal(r.status, 200, JSON.stringify(r.data));
    hub.cookie = r.response.headers.get("set-cookie").split(";")[0];
  };

  hub.request = async (
    route,
    body,
    { method, owner = true, base, headers = {} } = {},
  ) => {
    const response = await fetch((base || hub.origin) + route, {
      method: method || (body === undefined ? "GET" : "POST"),
      headers: {
        "Content-Type": "application/json",
        ...(owner && hub.cookie ? { Cookie: hub.cookie } : {}),
        ...headers,
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
  };

  hub.api = async (route, body, options) => {
    const r = await hub.request(route, body, options);
    assert.ok(
      r.status < 300,
      `${route} -> ${r.status} ${JSON.stringify(r.data)}`,
    );
    return r.data;
  };

  hub.setClockOffset = (offsetMs) =>
    fs.writeFileSync(hub.clockFile, JSON.stringify({ offsetMs }));

  hub.room = (id) => hub.api(`/api/rooms/${id}`);
  hub.say = async (roomId, text) => {
    for (;;) {
      const r = await hub.request(`/api/rooms/${roomId}/messages`, { text });
      if (r.status === 202) return r.data;
      if (!/still being handled/.test(r.data?.error || ""))
        throw new Error(`send failed: ${r.status} ${JSON.stringify(r.data)}`);
      await pause(50);
    }
  };
  hub.idle = async () => {
    let state;
    try {
      await waitUntil(
        async () => {
          state = await hub.api("/api/state");
          return !state.runs.some((r) =>
            ["running", "stopping"].includes(r.state),
          );
        },
        { label: "all discussions to settle" },
      );
    } catch (error) {
      const busy = state.runs.filter((r) =>
        ["running", "stopping"].includes(r.state),
      );
      const pending = busy.flatMap((r) =>
        (state.rooms.find((x) => x.id === r.roomId)?.messages || [])
          .filter(
            (m) =>
              m.role === "agent" && ["working", "submitted"].includes(m.state),
          )
          .map((m) => `${m.name}:${m.state}`),
      );
      error.message += ` Busy: ${JSON.stringify(busy)} pending: ${pending.join(", ")}`;
      throw error;
    }
  };

  // Real device authorization: request on the agent listener, owner approves
  // with the verification code on the loopback owner API, agent collects.
  hub.approve = async (name) => {
    const device = await hub.request(
      "/auth/device",
      { name },
      { owner: false, base: hub.agentOrigin },
    );
    assert.equal(device.status, 201, JSON.stringify(device.data));
    const pending = (await hub.api("/api/access")).requests.find(
      (r) => r.name === name,
    );
    await hub.api(`/api/access/${pending.id}/decision`, {
      approved: true,
      userCode: pending.userCode,
    });
    const token = await hub.request(
      "/auth/token",
      { device_code: device.data.device_code },
      { owner: false, base: hub.agentOrigin },
    );
    assert.equal(token.status, 200, JSON.stringify(token.data));
    const account = (await hub.api("/api/access")).accounts.find(
      (a) => a.name === name,
    );
    return {
      id: account.id,
      name,
      credential: token.data,
      token: token.data.access_token,
    };
  };

  hub.cleanup = async () => {
    await hub.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  };

  await hub.start();
  return hub;
}

function rpcBody(data) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: randomUUID(),
    method: "SendMessage",
    params: {
      message: {
        messageId: randomUUID(),
        role: "ROLE_USER",
        parts: [{ data }],
      },
    },
  });
}

// One authenticated A2A data action over HTTP, returning the Hub's data part.
export async function rpc(origin, token, data) {
  const response = await fetch(origin + "/a2a/jsonrpc", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "A2A-Version": "1.0",
      Authorization: `Bearer ${token}`,
    },
    body: rpcBody(data),
  });
  const body = await response.json();
  const message = body.result?.message || body.result;
  const result = message?.parts?.find((p) => p.data)?.data;
  return result || { error: body.error?.message || `HTTP ${response.status}` };
}

// Sends the request and destroys the socket as soon as the body is written, so
// the server processes the action but the caller never receives the ack.
export function rpcDropAck(origin, token, data) {
  const url = new URL("/a2a/jsonrpc", origin);
  const body = rpcBody(data);
  return new Promise((resolve) => {
    const req = http.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "A2A-Version": "1.0",
        Authorization: `Bearer ${token}`,
      },
    });
    req.on("error", () => resolve());
    req.on("response", (res) => {
      res.destroy();
      resolve();
    });
    req.end(body, () => setTimeout(() => req.destroy(), 25));
  });
}

function parseFrame(raw) {
  const frame = { id: null, event: "message", data: "" };
  let any = false;
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const at = line.indexOf(":");
    const key = at < 0 ? line : line.slice(0, at);
    const value = at < 0 ? "" : line.slice(at + 1).replace(/^ /, "");
    if (key === "id") frame.id = value;
    else if (key === "event") frame.event = value;
    else if (key === "data") frame.data += value;
    any = true;
  }
  if (!any) return null;
  try {
    frame.data = JSON.parse(frame.data);
  } catch {
    // Keep the raw string; assertions report it.
  }
  return frame;
}

// Real SSE client over fetch streaming.
export async function openEvents(
  origin,
  token,
  roomId,
  { cursor, lastEventId, headers = {} } = {},
) {
  const controller = new AbortController();
  const url = new URL("/a2a/v2/events", origin);
  if (roomId !== undefined) url.searchParams.set("roomId", roomId);
  if (cursor !== undefined) url.searchParams.set("cursor", String(cursor));
  const response = await fetch(url, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
      ...headers,
    },
    signal: controller.signal,
  });
  const stream = {
    status: response.status,
    contentType: response.headers.get("content-type") || "",
    frames: [],
    ended: false,
    close: () => controller.abort(),
  };
  if (response.status !== 200) {
    stream.body = await response.json();
    stream.ended = true;
    return stream;
  }
  stream.events = () =>
    stream.frames.filter(
      (f) => !["hello", "ready", "closed"].includes(f.event),
    );
  stream.control = (name) => stream.frames.find((f) => f.event === name);
  stream.waitFor = (predicate, timeout = 15000, label = "stream frame") =>
    waitUntil(() => predicate(stream) || (stream.ended && predicate(stream)), {
      timeout,
      label,
    });
  stream.done = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let at;
        while ((at = buffer.indexOf("\n\n")) >= 0) {
          const frame = parseFrame(buffer.slice(0, at));
          buffer = buffer.slice(at + 2);
          if (frame) stream.frames.push(frame);
        }
      }
    } catch (error) {
      if (error.name !== "AbortError") stream.error = error;
    }
    stream.ended = true;
  })();
  return stream;
}

export class Barrier {
  constructor(count) {
    this.count = count;
    this.arrived = 0;
    this.waiters = [];
  }
  arrive(timeout = 15000) {
    this.arrived += 1;
    if (this.arrived >= this.count)
      for (const w of this.waiters.splice(0)) w.resolve();
    if (this.arrived >= this.count) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              "Barrier timeout: agents were not dispatched concurrently.",
            ),
          ),
        timeout,
      );
      this.waiters.push({ resolve: () => (clearTimeout(timer), resolve()) });
    });
  }
}

// Native A2A 0.3 HTTP agent. `respond` decides the reply text for each call.
export async function nativeAgent(name, respond = async () => `${name} reply`) {
  let url;
  const calls = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET") {
      res.end(
        JSON.stringify({ name, url, protocolVersion: "0.3", capabilities: {} }),
      );
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const call = JSON.parse(body);
    if (call.method === "tasks/cancel") {
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: call.id,
          result: { id: call.params?.id, status: { state: "canceled" } },
        }),
      );
      return;
    }
    calls.push(call);
    let text;
    try {
      text = await respond(call, calls.length);
    } catch (error) {
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: call.id,
          error: { code: -32000, message: error.message },
        }),
      );
      return;
    }
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: call.id,
        result: {
          kind: "message",
          role: "agent",
          messageId: randomUUID(),
          parts: [{ kind: "text", text }],
        },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}/`;
  return {
    name,
    url,
    calls,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

// Disposable browser QA. Run from repository root after npm run build.
// No model calls or real credentials. Ctrl+C closes mock servers and test Hub.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { Access } from "../../server/access.js";
import { discover } from "../../server/protocol.js";
import { runConnector } from "../../scripts/a2a-connect.mjs";

process.env.A2AHUB_OWNER_PASSWORD = "browser-qa-only";
fs.mkdirSync("work", { recursive: true });
const dir = fs.mkdtempSync(path.resolve("work/ui-workflow-"));
const port = Number(process.env.A2AHUB_TEST_PORT || 49317);
const origin = `http://127.0.0.1:${port}`;
const children = [],
  servers = [],
  controllers = [];
const calls = [];
const sessionFixture = process.argv.includes("--sessions");
const sessionStates = ["awaiting-confirmation", "ready", "queued", "working"];
const room = {
  id: randomUUID(),
  title: "Workflow verification",
  messages: [],
  contexts: {},
  agentIds: [],
  memberSince: {},
  agentChat: true,
  replyLimit: 6,
  paused: false,
};
const access = new Access(dir);
const tokens = [];
for (const [index, name] of [
  "Alpha QA",
  "Beta QA",
  ...(sessionFixture
    ? ["Waiting QA", "Ready QA", "Queued QA", "Working QA"]
    : []),
].entries()) {
  const device = access.request(name, origin, "fixture");
  access.decide(
    new URL(device.verification_uri).searchParams.get("request"),
    index > 1 ? room : null,
    true,
  );
  tokens.push({
    name,
    credential: access.poll(device.device_code, { rooms: [room] }),
  });
}
fs.writeFileSync(
  path.join(dir, "workspace.json"),
  JSON.stringify({
    profile: { displayName: "QA Owner" },
    rooms: [room],
    agents: [
      {
        id: "offline-qa",
        name: "Offline QA",
        url: "http://127.0.0.1:1/",
        status: "offline",
      },
    ],
  }),
);
const hub = spawn(process.execPath, ["server/index.js"], {
  env: {
    ...process.env,
    PORT: String(port),
    A2AHUB_DATA_DIR: dir,
    A2AHUB_AGENT_PORT: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
children.push(hub);
hub.stderr.on("data", (b) => process.stderr.write(b));
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(origin + "/auth/session")).ok) break;
  } catch {}
  if (hub.exitCode !== null) throw new Error("Test Hub failed to start.");
  await new Promise((r) => setTimeout(r, 100));
}
for (const [index, { name, credential }] of tokens.entries()) {
  let nativeUrl;
  const mock = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET")
      return res.end(
        JSON.stringify({
          name,
          url: nativeUrl,
          protocolVersion: "0.3",
          capabilities: { streaming: false },
        }),
      );
    let body = "";
    for await (const chunk of req) body += chunk;
    const rpc = JSON.parse(body);
    if (rpc.method === "tasks/cancel")
      return res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: { id: rpc.params.id, status: { state: "canceled" } },
        }),
      );
    calls.push({
      name,
      at: Date.now(),
      text: rpc.params.message.parts[0].text,
    });
    const timer = setTimeout(
      () =>
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              kind: "message",
              messageId: randomUUID(),
              role: "agent",
              contextId: rpc.params.message.contextId,
              parts: [
                {
                  kind: "text",
                  text: `${name} received your message. Mock reply ${calls.filter((c) => c.name === name).length}.`,
                },
              ],
            },
          }),
        ),
      index ? 2400 : 1000,
    );
    res.on("close", () => clearTimeout(timer));
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  servers.push(mock);
  nativeUrl = `http://127.0.0.1:${mock.address().port}/`;
  const agent = await discover(nativeUrl);
  const controller = new AbortController();
  controllers.push(controller);
  const call = async (data) => {
    if (sessionFixture && index > 1 && data.action === "next_dispatch") {
      data = {
        ...data,
        roomId: room.id,
        available: false,
        receiver: {
          kind: "session",
          harness: index === 3 ? "claude-code" : "codex",
          sessionId: `mock-existing-${index}`,
          roomId: room.id,
          state: sessionStates[index - 2],
          lastReceiptAt: index === 2 ? null : new Date().toISOString(),
        },
      };
    }
    const response = await fetch(origin + "/a2a/jsonrpc", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "A2A-Version": "1.0",
        Authorization: `Bearer ${credential.access_token}`,
      },
      body: JSON.stringify({
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
      }),
    });
    const rpc = await response.json();
    const result = rpc.result?.message?.parts.find((p) => p.data)?.data;
    if (!result || result.error)
      throw new Error(result?.error || "Unexpected mock connector response");
    return result;
  };
  void runConnector({ call, agent, signal: controller.signal }).catch(
    (error) => {
      if (!controller.signal.aborted)
        console.error(`${name}: ${error.message}`);
    },
  );
}
console.log(
  JSON.stringify({
    url: origin,
    password: "browser-qa-only",
    dataDir: dir,
    note: "Disposable test credentials only; two actual mock A2A connectors online.",
  }),
);
async function cleanup() {
  for (const controller of controllers) controller.abort();
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
  for (const child of children)
    if (child.exitCode === null) {
      const exit = once(child, "exit");
      child.kill();
      await exit;
    }
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
process.once("SIGINT", cleanup);
process.once("SIGTERM", cleanup);

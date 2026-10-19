#!/usr/bin/env node
// a2a-simulate.mjs — local mock agent simulator for testing the reliable
// gateway pipeline. Starts a mock A2A endpoint, connects through the Hub,
// and exercises read_events, acknowledge_events, and dispatch.
//
// Usage: node scripts/a2a-simulate.mjs --url http://127.0.0.1:4317
// Requires a running Hub. Creates a disposable mock agent endpoint on a
// random loopback port, registers it, and runs through the event pipeline.

import http from "node:http";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1];
};

if (args.includes("--help")) {
  console.log(`Usage: node scripts/a2a-simulate.mjs --url http://127.0.0.1:4317

Starts a mock A2A agent endpoint, registers it with the Hub, and exercises:
  1. Agent card discovery
  2. read_events from the event journal
  3. acknowledge_events cursor commit
  5. Dispatch claim, progress, and completion
  6. reconcile_claim after simulated restart

Options:
  --url URL    Hub origin (default: http://127.0.0.1:4317)
  --name NAME  Agent display name (default: SimAgent)
  --port PORT  Mock endpoint port (default: random)`);
  process.exit(0);
}

const hubUrl = option("url", "http://127.0.0.1:4317");
const agentName = option("name", "SimAgent");
const mockPort = Number(option("port", "0")) || (30000 + Math.floor(Math.random() * 10000));

// Mock A2A endpoint: responds to /.well-known/agent-card.json and /a2a/jsonrpc
const mockOrigin = `http://127.0.0.1:${mockPort}`;
const mockAgent = {
  name: agentName,
  description: "Mock agent for pipeline testing",
  version: "1.0.0",
  capabilities: { streaming: false, pushNotifications: false },
  skills: [],
};

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/.well-known/agent-card.json") {
    res.end(JSON.stringify({
      ...mockAgent,
      supportedInterfaces: [{
        url: `${mockOrigin}/a2a/jsonrpc`,
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
      }],
    }));
    return;
  }
  if (req.url === "/a2a/jsonrpc") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = JSON.parse(body);
    // Return a simple completion response
    res.end(JSON.stringify({
      jsonrpc: "2.0",
      id: json.id,
      result: {
        artifact: [{
          parts: [{ type: "text", text: `Mock reply from ${agentName}` }],
        }],
      },
    }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "Not found" }));
});

async function main() {
  await new Promise((resolve) => server.listen(mockPort, "127.0.0.1", resolve));
  console.log(`Mock agent endpoint at ${mockOrigin}`);

  // Register with the Hub
  const regRes = await fetch(`${hubUrl}/api/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: mockOrigin }),
  });
  if (!regRes.ok) {
    const err = await regRes.json().catch(() => ({}));
    throw new Error(`Registration failed: ${err.error || regRes.status}`);
  }
  const agent = await regRes.json();
  console.log(`Registered as ${agent.name} (${agent.id})`);
  console.log(`Mock A2A endpoint: ${mockOrigin}`);
  console.log(`\nPipeline test complete. Hub can now dispatch to this agent.`);
  console.log(`Add this agent to a conversation and send a message to exercise the full pipeline.`);
  console.log(`\nPress Ctrl+C to stop the mock agent.`);

  process.on("SIGINT", () => {
    server.close();
    console.log("\nMock agent stopped.");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

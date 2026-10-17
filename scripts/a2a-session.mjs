#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { privateDirectory } from "../server/access.js";
import { SessionReceiver, sleep } from "./session-runtime.mjs";
import {
  hermesOrigin,
  listHermesSessions,
  createHermesSessionAdapter,
} from "./adapters/hermes-session.mjs";
import { owningHost, alive } from "./adapters/host-verify.mjs";
import {
  setScriptPath,
  settings,
  authorizedCall,
  envelope,
  control,
  writeJson,
  readJson,
} from "./adapters/session-config.mjs";

const script = fileURLToPath(import.meta.url);
setScriptPath(script);

export async function serve(config, { signal, ...services } = {}) {
  const lockFile = path.join(config.dir, "receiver.lock");
  if (fs.existsSync(lockFile)) {
    const owner = readJson(lockFile);
    if (alive(owner.pid))
      throw new Error("A receiver already owns this attachment.");
    throw new Error(
      "A stopped receiver left its lock. Use recover --attachment with this file before reattaching; uncertain deliveries will not be replayed.",
    );
  }
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid }), {
    flag: "wx",
    mode: 0o600,
  });
  try {
    await serveLocked(config, signal, services);
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
}

async function serveLocked(config, signal, services = {}) {
  const controller = new AbortController();
  let adapter, channel, server, monitor;
  const stop = () => {
    controller.abort();
    adapter?.close?.();
  };
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    controller.signal.throwIfAborted();
    const call = services.call || (await authorizedCall(config));
    const readHost = services.readHost || owningHost;
    // This read validates existing approval. Never generate a replacement approval.
    await call({ action: "list_rooms" });
    controller.signal.throwIfAborted();
    if (config.harness === "codex") {
      const { createCodexSessionAdapter } =
        await import("./adapters/codex-session.mjs");
      adapter = createCodexSessionAdapter({
        executable: config.executable,
        threadId: config.sessionId,
      });
      await adapter.probe();
    }
    if (config.harness === "hermes") {
      const host = await readHost(config);
      if (host.created !== config.hostCreated)
        throw new Error("Hermes Desktop restarted; attach again explicitly.");
      adapter = (services.hermesAdapter || createHermesSessionAdapter)({
        backend: config.backend,
        sessionId: config.sessionId,
        profile: config.profile,
      });
      adapter.closed.then(() => controller.abort());
      await adapter.probe();
    }
    const receiver = new SessionReceiver({
      call,
      file: path.join(config.dir, "journal.json"),
      binding: {
        harness: config.harness,
        sessionId: config.sessionId,
        roomId: config.roomId,
        ...(config.harness === "hermes"
          ? { backend: config.backend, profile: config.profile || "" }
          : {}),
      },
      enqueue: (deliveryId) =>
        adapter
          ? adapter.enqueue(envelope(config, deliveryId))
          : channel.notify({ deliveryId }),
      log: () => {}, // transport failures are visible through status, never print secrets
    });
    if (config.harness === "claude-code") {
      const { channelTransport } =
        await import("./adapters/claude-channel.mjs");
      channel = channelTransport({
        sessionId: config.sessionId,
        onRead: (id) => receiver.read(id),
        onReply: (id, text) => receiver.reply(id, text),
      });
      channel.closed.finally(() => controller.abort());
      await channel.ready;
    }
    const token = randomBytes(32).toString("base64url");
    server = http.createServer(async (req, res) => {
      res.setHeader("Content-Type", "application/json");
      try {
        if (controller.signal.aborted)
          throw new Error("The attached conversation receiver has ended.");
        const auth = req.headers.authorization || "",
          expected = `Bearer ${token}`;
        if (
          req.method !== "POST" ||
          req.headers.origin ||
          req.headers.host !== `127.0.0.1:${server.address().port}` ||
          auth.length !== expected.length ||
          !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))
        ) {
          res
            .writeHead(403)
            .end(JSON.stringify({ error: "Receiver access denied." }));
          return;
        }
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 200000) throw new Error("Request is too large.");
        }
        const data = JSON.parse(body);
        if (data.sessionId !== config.sessionId)
          throw new Error("Conversation does not match this receiver.");
        let result;
        if (req.url === "/status") result = receiver.info();
        else if (req.url === "/read")
          result = await receiver.read(data.deliveryId);
        else if (req.url === "/reply")
          result = await receiver.reply(data.deliveryId, data.text);
        else if (req.url === "/detach") {
          controller.abort();
          result = { detached: true };
        } else throw new Error("Unknown receiver command.");
        res.end(JSON.stringify(result));
      } catch (error) {
        if (!res.writableEnded)
          res.writeHead(400).end(JSON.stringify({ error: error.message }));
      }
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    writeJson(path.join(config.dir, "control.json"), {
      port: server.address().port,
      token,
      pid: process.pid,
    });
    let checkingHost = false;
    monitor = setInterval(async () => {
      if (!["codex", "hermes"].includes(config.harness) || checkingHost) return;
      checkingHost = true;
      try {
        const host = await readHost(config);
        if (host.pid !== config.hostPid || host.created !== config.hostCreated)
          controller.abort();
      } catch {
        controller.abort();
      } finally {
        checkingHost = false;
      }
    }, 10000);
    controller.signal.throwIfAborted();
    const handshake = await receiver.handshake();
    writeJson(path.join(config.dir, "receipt.json"), {
      state: "awaiting-confirmation",
      deliveryId: handshake,
    });
    await receiver.run(controller.signal);
  } finally {
    signal?.removeEventListener("abort", stop);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    clearInterval(monitor);
    channel?.close();
    adapter?.close?.();
    server?.closeAllConnections();
    server?.close();
    fs.rmSync(path.join(config.dir, "control.json"), { force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "sessions" && args.includes("--backend")) {
    const backend = args[args.indexOf("--backend") + 1];
    console.log(JSON.stringify(await listHermesSessions({ backend }), null, 2));
    return;
  }
  if (args.includes("--help") || !args.length) {
    console.log(
      "Hermes Desktop (Windows, existing local backend only):\n  node scripts/a2a-session.mjs sessions --backend http://127.0.0.1:BACKEND_PORT\n  node scripts/a2a-session.mjs attach --harness hermes --name Hermes --url HUB_ORIGIN --room ROOM_UUID --session EXACT_LIVE_ID --backend http://127.0.0.1:BACKEND_PORT --host-pid HERMES_DESKTOP_PID [--profile PROFILE]\nUse the live ID for the exact open chat. Do not select by recency or create a replacement. The host PID is the Desktop application, not its backend. Other computers run this receiver locally and use a reachable Hub URL.\n",
    );
    console.log(
      `Attach an EXISTING conversation, using an already-approved A2Ahub identity.\n\nCodex (run inside the selected conversation):\n  node scripts/a2a-session.mjs attach --harness codex --name Codex --url http://127.0.0.1:4317 --room ROOM_UUID --executable ABSOLUTE_CODEX_EXE [--session EXACT_THREAD_UUID] [--host-pid DESKTOP_PROCESS_ID]\n\nClaude Code (configure as an explicitly opted-in stdio channel on the selected session):\n  node scripts/a2a-session.mjs channel --harness claude-code --name Claude --url HUB_ORIGIN --room ROOM_UUID --session EXACT_SESSION_UUID\n\nReceiver controls:\n  node scripts/a2a-session.mjs status|read|reply|detach|recover --attachment ABSOLUTE_ATTACHMENT_JSON [--delivery ID]\n  recover only releases a stopped receiver lock before explicit reattachment. The receiver follows the owning harness process; reattach after a restart.\n  reply reads text from stdin. No command creates/resumes a model session. A handshake must be processed by the selected conversation before it is ready. Busy conversations process queued messages after their current turn. Native A2A endpoints use a2a-connect.mjs. See docs/AGENT-ACCESS.md for capability and cancellation limits.`,
    );
    return;
  }
  const at = args.indexOf("--attachment");
  if (at >= 0) {
    const config = readJson(path.resolve(args[at + 1]));
    if (args[0] === "recover") {
      const lockFile = path.join(config.dir, "receiver.lock");
      // Explicit recovery owns its own exclusive guard. A new run refuses any
      // receiver.lock until this operation removes that exact stopped record.
      const guard = path.join(config.dir, "recovery.lock");
      const fd = fs.openSync(guard, "wx", 0o600);
      try {
        if (fs.existsSync(lockFile)) {
          if (alive(readJson(lockFile).pid))
            throw new Error("The receiver is still running; detach it first.");
          fs.rmSync(lockFile);
        }
      } finally {
        fs.closeSync(fd);
        fs.rmSync(guard, { force: true });
      }
      console.log(
        "Stopped receiver lock released. Reattach explicitly; interrupted work remains sealed.",
      );
      return;
    }
    if (args[0] === "run") {
      await serve(config);
      return;
    }
    if (!["status", "read", "reply", "detach"].includes(args[0]))
      throw new Error("Unknown receiver command.");
    const di = args.indexOf("--delivery");
    console.log(
      JSON.stringify(
        await control(
          config,
          args[0],
          di >= 0 ? args[di + 1] : undefined,
          args[0] === "reply"
            ? fs.readFileSync(0, "utf8").replace(/^\uFEFF/, "")
            : undefined,
        ),
      ),
    );
    return;
  }
  const config = settings(args);
  if (!(
    (config.command === "attach" &&
      ["codex", "hermes"].includes(config.harness)) ||
    (config.command === "channel" && config.harness === "claude-code")
  ))
    throw new Error(
      "Use attach for Codex or Hermes, or channel for Claude Code.",
    );
  if (["codex", "hermes"].includes(config.harness)) {
    const host = await owningHost(config);
    config.hostPid = host.pid;
    config.hostCreated = host.created;
  }
  // Validate approval before creating private runtime state or launching a process.
  const call = await authorizedCall(config);
  await call({ action: "list_rooms" });
  privateDirectory(config.dir);
  const configFile = path.join(config.dir, "attachment.json");
  const controlFile = path.join(config.dir, "control.json");
  if (fs.existsSync(controlFile) && alive(readJson(controlFile).pid)) {
    if (config.command === "channel")
      throw new Error("This conversation already has a receiver.");
    console.log(
      JSON.stringify({
        attached: true,
        attachment: configFile,
        status: await control(config, "status"),
      }),
    );
    return;
  }
  writeJson(configFile, config);
  if (config.command === "channel") {
    await serve(config);
    return;
  }
  const output = fs.openSync(path.join(config.dir, "receiver.log"), "a", 0o600);
  const child = spawn(
    process.execPath,
    [path.basename(script), "run", "--attachment", configFile],
    {
      cwd: path.dirname(script),
      detached: true,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", output, output],
    },
  );
  fs.closeSync(output);
  child.unref();
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(controlFile) && alive(readJson(controlFile).pid)) {
      console.log(
        JSON.stringify({
          attached: true,
          attachment: configFile,
          state: "awaiting-confirmation",
          note: "The existing conversation must process its queued attachment check before it can receive chat messages.",
        }),
      );
      return;
    }
    if (!alive(child.pid))
      throw new Error(
        "Receiver could not start. Check its private receiver.log; no work was replayed.",
      );
    await sleep(250);
  }
  throw new Error(
    "Receiver startup is unconfirmed. Inspect status before attempting another attachment.",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });

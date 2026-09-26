#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { Role } from "@a2a-js/sdk";
import { privateDirectory } from "../server/access.js";
import { discover, send, cancel, endpoint } from "../server/protocol.js";

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

// Exported for tests: call is the authenticated Hub A2A data-action transport.
// Polling continues during the native turn so Stop can reach a busy harness.
export async function runConnector({
  call,
  agent,
  signal,
  connectorId = randomUUID(),
  nativeSend = send,
  nativeCancel = cancel,
  log = () => {},
  redact = (text) => text,
}) {
  let active = null,
    failure = null;
  const seen = new Set();
  async function stopRemote(work) {
    if (work.stopping) return work.stopping;
    work.controller.abort();
    work.stopping = (async () =>
      work.taskId
        ? !!(await nativeCancel(agent, work.taskId).catch(() => false))
        : false)();
    return work.stopping;
  }
  function start(dispatch) {
    if (active || seen.has(dispatch.dispatchId))
      throw new Error(
        "Duplicate dispatch refused; model work was not repeated.",
      );
    seen.add(dispatch.dispatchId);
    if (seen.size > 1000) seen.delete(seen.values().next().value);
    const work = {
      dispatch,
      controller: new AbortController(),
      taskId: null,
      reporting: Promise.resolve(),
      lastProgress: 0,
    };
    const report = (body) =>
      call({
        action: "report_dispatch",
        connectorId,
        dispatchId: dispatch.dispatchId,
        leaseId: dispatch.leaseId,
        ...body,
        ...(body.result
          ? { result: { ...body.result, text: redact(body.result.text || "") } }
          : {}),
      });
    active = work;
    log(`Responding in conversation ${dispatch.roomId}.`);
    work.done = (async () => {
      try {
        const result = await nativeSend(
          agent,
          dispatch.prompt,
          dispatch.context,
          work.controller.signal,
          (delta) => {
            const firstTask = delta.taskId && !work.taskId;
            work.taskId = delta.taskId || work.taskId;
            if (
              work.controller.signal.aborted ||
              (!firstTask && Date.now() - work.lastProgress < 1000)
            )
              return;
            work.lastProgress = Date.now();
            work.reporting = work.reporting
              .then(() => report({ kind: "progress", result: delta }))
              .then((r) => {
                if (r.accepted === false) void stopRemote(work);
              });
            // A reporting failure must stop this turn, never become an unhandled
            // rejection while the receiver keeps using the model.
            work.reporting.catch((error) => {
              failure = error;
              void stopRemote(work);
            });
          },
        );
        await work.reporting;
        if (!work.controller.signal.aborted) {
          await report({ kind: "complete", result });
          log(`Reply delivered in conversation ${dispatch.roomId}.`);
        }
      } catch (error) {
        if (!work.controller.signal.aborted) {
          await report({
            kind: "error",
            result: {
              text: String(error.message).slice(0, 800),
              state: "failed",
            },
          });
          log("Agent turn failed; no automatic retry.");
        }
      } finally {
        if (active === work) active = null;
      }
    })().catch((error) => {
      failure = error;
    });
  }
  try {
    while (!signal?.aborted && !failure) {
      const result = await call({
        action: "next_dispatch",
        connectorId,
        available: !active,
      });
      for (const item of result.cancellations || []) {
        const work =
          active?.dispatch.dispatchId === item.dispatchId ? active : null;
        const confirmed = work ? await stopRemote(work) : false;
        await call({
          action: "report_dispatch",
          connectorId,
          ...item,
          kind: "canceled",
          canceled: confirmed,
        });
      }
      if (signal?.aborted || failure) break;
      if (result.dispatch) start(result.dispatch);
      await sleep(
        Math.max(100, Math.min(1000, result.pollAfterMs || 250)),
        signal,
      );
    }
    if (failure) throw failure;
  } finally {
    const work = active;
    if (work) {
      await stopRemote(work);
      await call({
        action: "report_dispatch",
        connectorId,
        dispatchId: work.dispatch.dispatchId,
        leaseId: work.dispatch.leaseId,
        kind: "error",
        result: {
          text: "Connector stopped; remote work may continue.",
          state: "failed",
        },
      }).catch(() => {});
      await work.done;
    }
  }
}

export function credentialFile(
  origin,
  name,
  baseDir = process.env.LOCALAPPDATA ||
    path.join(os.homedir(), ".local", "share"),
) {
  return path.join(
    baseDir,
    "A2Ahub",
    "credentials",
    createHash("sha256").update(`${origin}/${name}`).digest("hex") + ".json",
  );
}

export async function createHubCall(origin, credential) {
  const authFetch = (url, init = {}) => {
    if (new URL(url).origin !== origin)
      throw new Error("Refusing cross-origin credential forwarding.");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${credential.access_token}`);
    return fetch(url, {
      ...init,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
  };
  const client = await new ClientFactory({
    transports: [new JsonRpcTransportFactory({ fetchImpl: authFetch })],
  }).createFromUrl(origin);
  return async (data) => {
    const response = await client.sendMessage({
      tenant: "",
      message: {
        messageId: randomUUID(),
        role: Role.ROLE_USER,
        contextId: "",
        taskId: "",
        parts: [
          {
            content: { $case: "data", value: data },
            mediaType: "application/json",
            filename: "",
          },
        ],
        extensions: [],
        referenceTaskIds: [],
      },
    });
    const message = response.payload?.value || response;
    const result = message.parts?.find((p) => p.content?.$case === "data")
      ?.content.value;
    if (!result || result.error)
      throw new Error(result?.error || "Unexpected Hub response.");
    return result;
  };
}

async function authorize(origin, name, file, existingOnly = false) {
  if (fs.existsSync(file)) {
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      stored.origin !== origin ||
      stored.name !== name ||
      typeof stored.access_token !== "string" ||
      !stored.access_token
    )
      throw new Error("Stored credential does not match this connector.");
    return stored;
  }
  if (existingOnly)
    throw new Error(
      "Existing approved credential required; no access request was created.",
    );
  async function request(route, data) {
    const response = await fetch(origin + route, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(10000),
    });
    return { status: response.status, body: await response.json() };
  }
  const auth = await request("/auth/device", { name });
  if (auth.status !== 201)
    throw new Error(auth.body.error || "Access request failed.");
  console.log(
    `Ask the owner to approve: ${auth.body.verification_uri}\nVerification code: ${auth.body.user_code}`,
  );
  const deadline = Date.now() + auth.body.expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(Math.max(1000, auth.body.interval * 1000));
    const poll = await request("/auth/token", {
      device_code: auth.body.device_code,
    });
    if ([428, 429].includes(poll.status)) continue;
    if (poll.status !== 200)
      throw new Error(poll.body.error || "Access was not approved.");
    const credential = { ...poll.body, origin, name };
    fs.writeFileSync(file + ".tmp", JSON.stringify(credential), {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(file + ".tmp", file);
    console.log("Access approved; credential saved privately.");
    return credential;
  }
  throw new Error(
    "Approval request expired. Run the connector again to request access.",
  );
}

async function main() {
  const args = process.argv.slice(2),
    option = (name, fallback) => {
      const i = args.indexOf(`--${name}`);
      return i < 0 ? fallback : args[i + 1];
    };
  if (args.includes("--help") || !option("endpoint")) {
    console.log(
      "Usage: node scripts/a2a-connect.mjs --name Hermes --url http://127.0.0.1:4317 --endpoint http://127.0.0.1:9900 [--token-env A2AHUB_TOKEN_HERMES] [--existing-credential-only]\nRun this on the agent's computer. --url is the reachable Hub origin; --endpoint is the agent's local native A2A service. Existing approved credentials are reused. --existing-credential-only fails instead of starting approval when no saved credential exists. Keep this process running for wake/reply delivery.",
    );
    return;
  }
  const name = option("name", "Hermes"),
    base = new URL(endpoint(option("url", "http://127.0.0.1:4317")));
  if (base.pathname !== "/")
    throw new Error("Use the Hub origin without a path.");
  if (!name || name.length > 80)
    throw new Error("Agent name must be between 1 and 80 characters.");
  const tokenEnv = option("token-env");
  if (tokenEnv && !/^A2AHUB_TOKEN_[A-Z0-9_]+$/.test(tokenEnv))
    throw new Error("Use an A2AHUB_TOKEN_ environment variable name.");
  const agent = { ...(await discover(option("endpoint"), tokenEnv)), tokenEnv };
  const file = credentialFile(base.origin, name);
  privateDirectory(path.dirname(file));
  const lock = file + ".connector.lock";
  if (fs.existsSync(lock)) {
    let running = true;
    try {
      process.kill(Number(fs.readFileSync(lock, "utf8")), 0);
    } catch (error) {
      if (error.code === "ESRCH") running = false;
    }
    if (running)
      throw new Error("A connector for this name and Hub is already running.");
    fs.unlinkSync(lock);
  }
  fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  let credential;
  try {
    credential = await authorize(
      base.origin,
      name,
      file,
      args.includes("--existing-credential-only"),
    );
    const call = await createHubCall(base.origin, credential);
    const redact = (text) => {
      for (const secret of [
        credential.access_token,
        tokenEnv && process.env[tokenEnv],
      ])
        if (secret) text = text.replaceAll(secret, "[redacted]");
      return text;
    };
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    console.log(
      `${name} connector is ready. Add it to a Hub conversation to receive turns.`,
    );
    try {
      await runConnector({
        call,
        agent,
        signal: controller.signal,
        log: console.log,
        redact,
      });
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  } catch (error) {
    let message = String(error.message);
    for (const secret of [
      credential?.access_token,
      tokenEnv && process.env[tokenEnv],
    ])
      if (secret) message = message.replaceAll(secret, "[redacted]");
    throw new Error(message);
  } finally {
    fs.unlinkSync(lock);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

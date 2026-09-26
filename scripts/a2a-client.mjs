#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { Role } from "@a2a-js/sdk";
import { privateDirectory } from "../server/access.js";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1];
};
const command = args[0],
  name = option("name", "Hermes");
const base = new URL(option("url", "http://127.0.0.1:4317"));
if (
  !["http:", "https:"].includes(base.protocol) ||
  base.username ||
  base.password ||
  base.search ||
  base.hash ||
  base.pathname !== "/"
)
  throw new Error(
    "Use an HTTP(S) Hub origin without a path, credentials, query, or fragment.",
  );
const origin = base.origin;
const dir = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"),
  "A2Ahub",
  "credentials",
);
const file = path.join(
  dir,
  createHash("sha256").update(`${origin}/${name}`).digest("hex") + ".json",
);
async function call(route, body) {
  const res = await fetch(origin + route, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}
async function main() {
  if (command === "auth") {
    privateDirectory(dir);
    if (fs.existsSync(file))
      throw new Error(
        "A credential is already stored for this name. Revoked or expired? Ask the owner to review access, then explicitly remove the old credential file before authorizing again. File: " +
          file,
      );
    const { status, data } = await call("/auth/device", { name });
    if (status !== 201) throw new Error(data.error);
    console.log(
      `Ask the owner to approve: ${data.verification_uri}\nVerification code: ${data.user_code}\nWaiting for approval (up to ten minutes)…`,
    );
    const deadline = Date.now() + data.expires_in * 1000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, data.interval * 1000));
      const poll = await call("/auth/token", { device_code: data.device_code });
      if (poll.status === 428 || poll.status === 429) continue;
      if (poll.status !== 200) throw new Error(poll.data.error);
      fs.writeFileSync(
        file + ".tmp",
        JSON.stringify({ ...poll.data, origin, name }),
        { mode: 0o600, flag: "wx" },
      );
      fs.renameSync(file + ".tmp", file);
      console.log(
        `Approved. Credential stored privately at ${file}\nUse read or say with the same --name and --url.`,
      );
      return;
    }
    throw new Error("Approval request expired.");
  }
  if (!["read", "say", "rooms"].includes(command))
    throw new Error(
      "Usage: node scripts/a2a-client.mjs auth|rooms|read|say --name Hermes --url http://127.0.0.1:4317 [--room ID] [--cursor N]. For say, pipe message text on stdin.",
    );
  if (!fs.existsSync(file))
    throw new Error("No credential for this name and Hub. Run auth first.");
  const credential = JSON.parse(fs.readFileSync(file, "utf8"));
  const authFetch = (url, init = {}) => {
    if (new URL(url).origin !== origin)
      throw new Error("Refusing cross-origin credential forwarding.");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${credential.access_token}`);
    return fetch(url, { ...init, headers, redirect: "error" });
  };
  const client = await new ClientFactory({
    transports: [new JsonRpcTransportFactory({ fetchImpl: authFetch })],
  }).createFromUrl(origin);
  const data =
    command === "rooms"
      ? { action: "list_rooms" }
      : command === "read"
        ? { action: "read_messages", cursor: Number(option("cursor", "0")) }
        : { action: "post_message", text: fs.readFileSync(0, "utf8") };
  const response = await client.sendMessage({
    tenant: "",
    message: {
      messageId: randomUUID(),
      role: Role.ROLE_USER,
      contextId:
        command === "rooms" ? "" : option("room", credential.context_id || ""),
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
  if (!result) throw new Error("Unexpected A2A response.");
  if (result.error) throw new Error(result.error);
  console.log(JSON.stringify(result, null, 2));
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

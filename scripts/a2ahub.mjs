#!/usr/bin/env node
// a2ahub — manager CLI for a running A2Ahub (full or --headless).
// Talks to the loopback owner API at /api/v1 with a scoped manager token.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { privateDirectory } from "../server/access.js";

const HELP = `a2ahub — manage a local A2Ahub from the command line

Setup
  a2ahub login [--name NAME] [--scopes read,chat,admin] [--password-file FILE]
  a2ahub logout                      Revoke and forget this CLI's token

Overview
  a2ahub status                      Hub health, activity and attention items
  a2ahub admin                       Full admin summary (same as the Admin page)
  a2ahub audit [--limit N]           Recent administrative actions

Conversations (ROOM = id, title, or a unique part of either)
  a2ahub rooms [--archived]          List conversations
  a2ahub show ROOM [--last N]        Print recent messages
  a2ahub new [TITLE] [--folder F]    Create a conversation
  a2ahub say ROOM TEXT... [--watch]  Send a message (starts a bounded burst)
  a2ahub continue ROOM [--watch]     Continue the current topic
  a2ahub watch ROOM                  Follow a conversation live (Ctrl+C detaches)
  a2ahub stop ROOM | stop --all      Stop agents (attempts remote cancellation)
  a2ahub resume ROOM                 Unpause without starting work
  a2ahub archive ROOM | restore ROOM
  a2ahub move ROOM FOLDER|none
  a2ahub folders                     List folders
  a2ahub folder create NAME [--color C] | folder delete NAME

Agents and access
  a2ahub agents                      Directory with live status
  a2ahub access                      Pending requests and approved agents
  a2ahub access approve REQUEST --code CODE [--room ROOM]
  a2ahub access deny REQUEST
  a2ahub access revoke AGENT

Data
  a2ahub backup                      Write a workspace backup (no credentials)
  a2ahub tokens                      List manager tokens

Options: --json for machine-readable output, --url to choose the Hub.
Environment: A2AHUB_URL, A2AHUB_MANAGER_TOKEN, A2AHUB_CLI_HOME.
Ctrl+C while watching only detaches; agents keep running until you stop them.`;

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (!arg.startsWith("--")) positional.push(arg);
  else if (["--json", "--watch", "--all", "--archived", "--help"].includes(arg))
    flags[arg.slice(2)] = true;
  else flags[arg.slice(2)] = argv[++i];
}
const json = !!flags.json;
const home =
  process.env.A2AHUB_CLI_HOME ||
  path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"),
    "A2Ahub",
    "manager",
  );
const configFile = path.join(home, "manager.json");

function fail(message, code = 1) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile, "utf8"));
  } catch {
    return {};
  }
}
function hubOrigin(config = readConfig()) {
  const raw =
    flags.url ||
    process.env.A2AHUB_URL ||
    config.url ||
    "http://127.0.0.1:4317";
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    fail("Use a Hub origin such as http://127.0.0.1:4317 (no path).");
  return url.origin;
}
function token(config = readConfig()) {
  const value = process.env.A2AHUB_MANAGER_TOKEN || config.token;
  if (!value) fail("Not signed in. Run: a2ahub login");
  return value;
}

async function api(route, body, method = body === undefined ? "GET" : "POST") {
  const origin = hubOrigin();
  let res;
  try {
    res = await fetch(`${origin}/api/v1${route}`, {
      method,
      redirect: "error",
      headers: {
        Authorization: `Bearer ${token()}`,
        "Content-Type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    fail(`Cannot reach A2Ahub at ${origin}. Is it running?`);
  }
  // Only JSON from the API counts; an HTML page means the request missed it.
  const isJson = (res.headers.get("content-type") || "").includes(
    "application/json",
  );
  const data = isJson ? await res.json().catch(() => null) : null;
  if (res.status === 401)
    fail("The saved token was rejected. Run: a2ahub login");
  if (!res.ok) fail(data?.error || `Request failed (${res.status}).`);
  if (!data) fail(`Unexpected response from ${origin}. Is this A2Ahub?`);
  return data;
}
// Mutations always POST, even without a body.
const post = (route, body = {}) => api(route, body, "POST");

function print(value, human) {
  if (json) console.log(JSON.stringify(value, null, 2));
  else human(value);
}
function table(rows, columns) {
  if (!rows.length) return console.log("(none)");
  const widths = columns.map(([key, label]) =>
    Math.min(
      48,
      Math.max(label.length, ...rows.map((r) => String(r[key] ?? "").length)),
    ),
  );
  const line = (cells) =>
    cells
      .map((c, i) =>
        String(c ?? "")
          .slice(0, widths[i])
          .padEnd(widths[i]),
      )
      .join("  ")
      .trimEnd();
  console.log(line(columns.map(([, label]) => label)));
  for (const r of rows) console.log(line(columns.map(([key]) => r[key])));
}
const when = (iso) =>
  iso
    ? new Date(iso).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

function pick(items, query, label, fields = ["id", "title"]) {
  if (!query) fail(`Name a ${label}.`);
  const q = query.toLowerCase();
  const exact = items.filter((item) =>
    fields.some((f) => String(item[f] ?? "").toLowerCase() === q),
  );
  if (exact.length === 1) return exact[0];
  const partial = items.filter((item) =>
    fields.some((f) =>
      String(item[f] ?? "")
        .toLowerCase()
        .includes(q),
    ),
  );
  if (partial.length === 1) return partial[0];
  if (!partial.length) fail(`No ${label} matches "${query}".`);
  fail(
    `"${query}" matches several: ${partial
      .map((i) => i[fields[1]] || i.id)
      .join(", ")}. Be more specific.`,
  );
}
const findRoom = async (query) =>
  pick(await api("/rooms"), query, "conversation");

async function readPassword() {
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
  const answer = await new Promise((resolve) =>
    rl.question("Owner password: ", resolve),
  );
  rl.close();
  process.stdout.write("\n");
  return answer;
}

async function login() {
  const origin = hubOrigin();
  const password = await readPassword();
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
    privateDirectory(home);
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
    print(
      { ok: true, name: created.name, scopes: created.scopes, configFile },
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
  if (config.id && config.token)
    await api(`/manager-tokens/${config.id}`, undefined, "DELETE").catch(
      () => {},
    );
  fs.rmSync(configFile, { force: true });
  print({ ok: true }, () => console.log("✓ Token revoked and removed."));
}

function printMessage(m) {
  const time = new Date(m.createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const state =
    m.role === "user" || m.state === "completed" ? "" : ` [${m.state}]`;
  console.log(`\n${time}  ${m.name}${state}`);
  if (m.text) console.log(m.text.replace(/^/gm, "  "));
}
const settled = (m) =>
  m.role === "user" || !["working", "submitted"].includes(m.state);

async function watch(room, runId, from) {
  const origin = hubOrigin();
  const controller = new AbortController();
  process.once("SIGINT", () => {
    controller.abort();
    console.log(
      `\nDetached. Agents keep running — stop them with: a2ahub stop "${room.title}"`,
    );
    process.exit(130);
  });
  const res = await fetch(`${origin}/api/v1/events`, {
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: "text/event-stream",
    },
    signal: controller.signal,
  });
  if (!res.ok) fail(`Cannot follow events (${res.status}).`);
  const printed = new Set(),
    working = new Set();
  let baseline = null,
    lastStatus = "";
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const event = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (event.startsWith("event: auth-expired")) {
        await res.body.cancel().catch(() => {});
        fail("The manager token was revoked.");
      }
      const data = event
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join("");
      if (!data) continue;
      const state = JSON.parse(data);
      const current = state.rooms.find((r) => r.id === room.id);
      if (!current) fail("The conversation was deleted.");
      // A new burst starts at the index the server reported; otherwise
      // show only what arrives from now on.
      if (baseline === null) {
        baseline = Number.isInteger(from) ? from : current.messages.length;
        current.messages.slice(0, baseline).forEach((m) => printed.add(m.id));
      }
      for (const m of current.messages) {
        if (printed.has(m.id)) continue;
        if (settled(m)) {
          printed.add(m.id);
          printMessage(m);
        } else if (!working.has(m.id)) {
          working.add(m.id);
          console.log(`\n… ${m.name} is working`);
        }
      }
      const runs = state.runs.filter((r) => r.roomId === room.id);
      const run = runId ? runs.find((r) => r.id === runId) : runs.at(-1);
      if (run) {
        const status = `${run.state} · ${run.turn}/${run.maxTurns} requests`;
        if (status !== lastStatus) {
          lastStatus = status;
          console.log(`\n— ${status}`);
        }
      }
      if (runId && run && !["running", "stopping"].includes(run.state)) {
        // Leaving the loop cancels the stream cleanly; aborting here would
        // surface as an error after a successful run.
        return;
      }
    }
  }
}

async function status() {
  const admin = await api("/admin");
  print(admin, (a) => {
    const c = a.counts;
    console.log(
      `HUB      online   ${a.listeners.owner.origin}  v${a.server.version}${a.server.headless ? "  (headless)" : ""}`,
    );
    console.log(
      `AGENTS   ${c.agents} total · ${c.online} online · ${c.approvedAgents} approved`,
    );
    console.log(
      `ROOMS    ${c.rooms} active · ${c.archived} archived · ${c.folders} folders`,
    );
    for (const run of a.activity)
      console.log(
        `ACTIVE   ${run.roomTitle || run.roomId}  ${run.turn}/${run.maxTurns} requests (${run.state})`,
      );
    if (!a.attention.length) console.log("ATTENTION none");
    for (const item of a.attention) console.log(`ATTENTION ${item.text}`);
  });
}

async function main() {
  const [command, sub, ...rest] = positional;
  if (!command || flags.help || command === "help") return console.log(HELP);
  switch (command) {
    case "login":
      return login();
    case "logout":
      return logout();
    case "status":
      return status();
    case "admin":
      return print(await api("/admin"), (a) =>
        console.log(JSON.stringify(a, null, 2)),
      );
    case "audit":
      return print(
        await api(`/admin/audit?limit=${Number(flags.limit) || 30}`),
        (entries) =>
          table(
            entries.map((e) => ({
              at: when(e.at),
              actor: e.actor,
              action: e.action,
              subject: e.room || e.agent || e.token || e.count || "",
            })),
            [
              ["at", "WHEN"],
              ["actor", "WHO"],
              ["action", "ACTION"],
              ["subject", "SUBJECT"],
            ],
          ),
      );
    case "rooms": {
      const [rooms, state] = await Promise.all([api("/rooms"), api("/state")]);
      const folders = Object.fromEntries(
        state.folders.map((f) => [f.id, f.name]),
      );
      const shown = rooms.filter((r) => !!r.archived === !!flags.archived);
      return print(shown, (list) =>
        table(
          list.map((r) => ({
            title: r.title,
            folder: folders[r.folderId] || "—",
            members: r.agentIds.length,
            state: r.active ? "active" : r.paused ? "paused" : "idle",
            last: when(r.lastMessageAt),
            id: r.id.slice(0, 8),
          })),
          [
            ["title", "CONVERSATION"],
            ["folder", "FOLDER"],
            ["members", "AGENTS"],
            ["state", "STATE"],
            ["last", "LAST"],
            ["id", "ID"],
          ],
        ),
      );
    }
    case "show": {
      const room = await findRoom(sub);
      const full = await api(`/rooms/${room.id}`);
      const last = Number(flags.last) || 10;
      return print(full.messages.slice(-last), (messages) => {
        console.log(`${full.title}${full.archived ? " (archived)" : ""}`);
        messages.forEach(printMessage);
      });
    }
    case "new": {
      const state = await api("/state");
      const body = {};
      if (flags.folder)
        body.folderId = pick(state.folders, flags.folder, "folder", [
          "id",
          "name",
        ]).id;
      const room = await api("/rooms", body);
      if (sub)
        await api(
          `/rooms/${room.id}`,
          { title: [sub, ...rest].join(" ") },
          "PATCH",
        );
      return print({ id: room.id }, () =>
        console.log(
          `✓ Created ${sub ? [sub, ...rest].join(" ") : room.title} (${room.id})`,
        ),
      );
    }
    case "say": {
      const room = await findRoom(sub);
      const text = rest.join(" ");
      if (!text) fail('Usage: a2ahub say ROOM "message"');
      const run = await post(`/rooms/${room.id}/messages`, { text });
      if (!json)
        console.log(
          `→ Sent to ${room.title}. Burst ${run.id.slice(0, 8)} started.`,
        );
      else print(run, () => {});
      if (flags.watch) await watch(room, run.id, run.from);
      return;
    }
    case "continue": {
      const room = await findRoom(sub);
      const run = await post(`/rooms/${room.id}/continue`);
      print(run, () => console.log(`→ Continuing ${room.title}.`));
      if (flags.watch) await watch(room, run.id, run.from);
      return;
    }
    case "watch":
      return watch(await findRoom(sub));
    case "stop": {
      if (flags.all || sub === "--all") {
        const result = await post("/admin/stop-all");
        return print(result, (r) =>
          console.log(`✓ Stopped ${r.stopped.length} active conversation(s).`),
        );
      }
      const room = await findRoom(sub);
      await post(`/rooms/${room.id}/stop`);
      return print({ ok: true }, () =>
        console.log(
          `✓ Stopped ${room.title}. Remote cancellation was attempted; already-started work may continue.`,
        ),
      );
    }
    case "resume":
    case "archive":
    case "restore": {
      const room = await findRoom(sub);
      const route = {
        resume: "resume",
        archive: "archive",
        restore: "unarchive",
      }[command];
      await post(`/rooms/${room.id}/${route}`);
      return print({ ok: true }, () =>
        console.log(`✓ ${command} ${room.title}`),
      );
    }
    case "move": {
      const room = await findRoom(sub);
      const state = await api("/state");
      const target = rest.join(" ");
      const folderId =
        !target || target === "none"
          ? null
          : pick(state.folders, target, "folder", ["id", "name"]).id;
      await api(`/rooms/${room.id}`, { folderId }, "PATCH");
      return print({ ok: true }, () =>
        console.log(
          `✓ Moved ${room.title} to ${folderId ? target : "no folder"}.`,
        ),
      );
    }
    case "folders":
      return print((await api("/state")).folders, (folders) =>
        table(folders, [
          ["name", "FOLDER"],
          ["color", "COLOR"],
          ["id", "ID"],
        ]),
      );
    case "folder": {
      const name = rest.join(" ");
      if (sub === "create") {
        const folder = await api("/folders", {
          name,
          color: flags.color || "gray",
        });
        return print(folder, () =>
          console.log(`✓ Created folder ${folder.name}`),
        );
      }
      if (sub === "delete") {
        const folder = pick((await api("/state")).folders, name, "folder", [
          "id",
          "name",
        ]);
        await api(`/folders/${folder.id}`, undefined, "DELETE");
        return print({ ok: true }, () =>
          console.log(
            `✓ Deleted folder ${folder.name}; its conversations are unfiled.`,
          ),
        );
      }
      fail("Usage: a2ahub folder create NAME | folder delete NAME");
    }
    case "agents":
      return print(await api("/agents"), (agents) =>
        table(
          agents.map((a) => ({
            name: a.name,
            kind: a.receiver?.kind === "session" ? "conversation" : a.kind,
            status: a.status,
            id: a.id.slice(0, 8),
          })),
          [
            ["name", "AGENT"],
            ["kind", "KIND"],
            ["status", "STATUS"],
            ["id", "ID"],
          ],
        ),
      );
    case "access": {
      const list = await api("/access");
      if (!sub)
        return print(list, (l) => {
          console.log("Pending requests");
          table(
            l.requests.map((r) => ({
              name: r.name,
              code: r.userCode,
              expires: when(new Date(r.expiresAt).toISOString()),
              id: r.id.slice(0, 8),
            })),
            [
              ["name", "AGENT"],
              ["code", "CODE"],
              ["expires", "EXPIRES"],
              ["id", "ID"],
            ],
          );
          console.log("\nApproved agents");
          table(
            l.accounts.map((a) => ({
              name: a.name,
              state: a.revoked
                ? "revoked"
                : a.expiresAt <= Date.now()
                  ? "expired"
                  : "approved",
              expires: when(new Date(a.expiresAt).toISOString()),
            })),
            [
              ["name", "AGENT"],
              ["state", "STATE"],
              ["expires", "EXPIRES"],
            ],
          );
        });
      const target = rest[0];
      if (sub === "approve" || sub === "deny") {
        const request = pick(list.requests, target, "pending request", [
          "id",
          "name",
        ]);
        if (sub === "approve" && !flags.code)
          fail(
            "Compare the code shown on the agent's computer, then pass --code CODE.",
          );
        const body = { approved: sub === "approve" };
        if (flags.code) body.userCode = flags.code;
        if (flags.room) body.roomId = (await findRoom(flags.room)).id;
        await api(`/access/${request.id}/decision`, body);
        return print({ ok: true }, () =>
          console.log(
            sub === "approve"
              ? `✓ ${request.name} approved and added to your directory (30 days).`
              : `✓ ${request.name} denied.`,
          ),
        );
      }
      if (sub === "revoke") {
        const account = pick(
          list.accounts.filter((a) => !a.revoked),
          target,
          "approved agent",
          ["id", "name"],
        );
        await api(`/access/${account.id}`, undefined, "DELETE");
        return print({ ok: true }, () =>
          console.log(`✓ Revoked ${account.name}.`),
        );
      }
      fail("Usage: a2ahub access [approve|deny|revoke] …");
    }
    case "backup": {
      const result = await post("/admin/backup");
      return print(result, (r) => console.log(`✓ Backup written to ${r.file}`));
    }
    case "tokens":
      return print(await api("/manager-tokens"), (tokens) =>
        table(
          tokens.map((t) => ({
            name: t.name,
            scopes: t.scopes.join(","),
            hint: `a2m_…${t.hint}`,
            used: t.lastUsedAt
              ? when(new Date(t.lastUsedAt).toISOString())
              : "never",
          })),
          [
            ["name", "TOKEN"],
            ["scopes", "SCOPES"],
            ["hint", "ENDS"],
            ["used", "LAST USED"],
          ],
        ),
      );
    default:
      fail(`Unknown command "${command}". Run: a2ahub help`);
  }
}

main().catch((error) => {
  if (json) console.error(JSON.stringify({ error: error.message }));
  else console.error(`a2ahub: ${error.message}`);
  process.exit(error.exitCode || 1);
});

// Shared CLI context for a2ahub: parsing, config, the loopback API client,
// and the small formatting helpers (print, table, when, pick, findRoom).
// Command modules under scripts/cli/ receive this context and register
// their handlers against it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { privateDirectory } from "../../server/access.js";

// Parse argv into { flags, positional }. "--" ends option parsing so text
// such as "--compare plans" survives untouched.
const BOOLEAN_FLAGS = [
  "--json",
  "--watch",
  "--all",
  "--archived",
  "--help",
  "--local",
];

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) positional.push(arg);
    else if (BOOLEAN_FLAGS.includes(arg)) flags[arg.slice(2)] = true;
    else flags[arg.slice(2)] = argv[++i];
  }
  return { flags, positional };
}

export function makeContext(argv) {
  const { flags, positional } = parseArgs(argv);
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
    // The owner API is loopback-only; never send the owner password or a
    // manager token anywhere else. Reach another computer through a tunnel.
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      fail(
        `Refusing ${url.origin}: the owner API is loopback-only. ` +
          "For another computer, tunnel it: ssh -L 4317:127.0.0.1:4317 hub-pc",
      );
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

  const findRoom = async (query) => pick(await api("/rooms"), query, "conversation");

  return {
    flags,
    positional,
    json,
    home,
    configFile,
    privateDirectory,
    fail,
    readConfig,
    hubOrigin,
    token,
    api,
    post,
    print,
    table,
    when,
    pick,
    findRoom,
  };
}

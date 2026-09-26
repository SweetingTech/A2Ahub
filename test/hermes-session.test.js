import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { serve } from "../scripts/a2a-session.mjs";
import {
  createHermesSessionAdapter,
  listHermesSessions,
} from "../scripts/adapters/hermes-session.mjs";

function fixture(t, overrides = {}) {
  const sent = [];
  let socket;
  const state = { live: true, status: "streaming", ...overrides };
  class Socket extends EventTarget {
    constructor(url) {
      super();
      socket = this;
      assert.match(
        url,
        /^ws:\/\/127\.0\.0\.1:12345\/api\/ws\?token=mock-token$/,
      );
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    receive(data) {
      this.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(data) }),
      );
    }
    send(text) {
      const request = JSON.parse(text);
      sent.push(request);
      let result;
      if (request.method === "session.active_list")
        result = {
          sessions: state.live
            ? [
                {
                  id: "ab123456",
                  title: "Selected chat",
                  status: "idle",
                  preview: "private transcript",
                },
              ]
            : [],
        };
      if (request.method === "session.activate")
        result = {
          session_id: state.wrongTarget ? "99999999" : "ab123456",
          messages_omitted: true,
          info: { profile_name: state.wrongProfile ? "other" : "home" },
        };
      if (request.method === "prompt.submit") {
        if (state.drop) {
          this.close();
          return;
        }
        if (state.hang) return;
        result = { status: state.status, user_row_id: 51 };
      }
      queueMicrotask(() => {
        this.receive({
          jsonrpc: "2.0",
          id: "approval-7",
          method: "approval.request",
          params: { prompt: "approve?" },
        });
        this.receive({
          jsonrpc: "2.0",
          method: "message.complete",
          params: { text: "unrelated private answer" },
        });
        this.receive({ jsonrpc: "2.0", id: request.id, result });
      });
    }
    close() {
      if (!this.ended) {
        this.ended = true;
        this.dispatchEvent(new Event("close"));
      }
    }
  }
  const options = {
    backend: "http://127.0.0.1:12345",
    sessionId: "ab123456",
    profile: "home",
    Socket,
    timeoutMs: 100,
    monitorMs: 100000,
    fetchImpl: async (url, options) => {
      assert.equal(url, "http://127.0.0.1:12345/");
      assert.equal(options.redirect, "error");
      return {
        ok: true,
        text: async () => 'window.__HERMES_SESSION_TOKEN__="mock-token";',
      };
    },
  };
  const adapter = createHermesSessionAdapter(options);
  t.after(() => adapter.close());
  return { adapter, options, sent, state, socket: () => socket };
}

test("receiver startup failure closes the Hermes subscription and releases its lock", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-hermes-cleanup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const journal = path.join(dir, "journal.json");
  fs.writeFileSync(journal, "malformed journal");
  let opened = false,
    closed = false,
    submitted = false;
  await assert.rejects(
    serve(
      { dir, harness: "hermes", sessionId: "ab123456", hostCreated: "test" },
      {
        call: async () => ({}),
        readHost: async () => ({ created: "test" }),
        hermesAdapter: () => ({
          probe: async () => {
            opened = true;
          },
          close: () => {
            closed = true;
          },
          enqueue: async () => {
            submitted = true;
          },
          closed: new Promise(() => {}),
        }),
      },
    ),
    /JSON|Unexpected/,
  );
  assert.equal(opened, true);
  assert.equal(closed, true);
  assert.equal(submitted, false);
  assert.equal(fs.existsSync(path.join(dir, "receiver.lock")), false);
  assert.equal(fs.readFileSync(journal, "utf8"), "malformed journal");
});

test("closing Hermes during bootstrap cannot activate a chat or leak a socket", async (t) => {
  const { options, sent, socket } = fixture(t);
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const adapter = createHermesSessionAdapter({
    ...options,
    fetchImpl: async (...args) => {
      await wait;
      return options.fetchImpl(...args);
    },
  });
  const pending = adapter.probe();
  adapter.close();
  await adapter.closed;
  release();
  await assert.rejects(pending, /ended/);
  assert.equal(socket().ended, true);
  assert.equal(sent.length, 0);
});

test("aborting receiver setup prevents its handshake and closes acquired resources", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-hermes-abort-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const control = new AbortController();
  let submitted = false,
    closed = false;
  await assert.rejects(
    serve(
      { dir, harness: "hermes", sessionId: "ab123456", hostCreated: "test" },
      {
        signal: control.signal,
        call: async () => ({}),
        readHost: async () => ({ created: "test" }),
        hermesAdapter: () => ({
          probe: async () => {
            control.abort();
          },
          close: () => {
            closed = true;
          },
          enqueue: async () => {
            submitted = true;
          },
          closed: new Promise(() => {}),
        }),
      },
    ),
    /abort/i,
  );
  assert.equal(closed, true);
  assert.equal(submitted, false);
  assert.equal(fs.existsSync(path.join(dir, "control.json")), false);
});

test("Hermes lists live metadata without printing transcript or bootstrap token", async (t) => {
  const { options, sent } = fixture(t);
  const sessions = await listHermesSessions(options);
  assert.deepEqual(sessions, [
    { id: "ab123456", title: "Selected chat", status: "idle" },
  ]);
  assert.deepEqual(
    sent.map((r) => r.method),
    ["session.active_list"],
  );
});

test("Hermes attaches exact live session and leaves server approval requests unanswered", async (t) => {
  const { adapter, sent } = fixture(t);
  await adapter.probe();
  assert.deepEqual(sent[1], {
    jsonrpc: "2.0",
    id: 2,
    method: "session.activate",
    params: { session_id: "ab123456", profile: "home", omit_messages: true },
  });
  assert.deepEqual(
    await adapter.enqueue("Only the read/reply helper envelope"),
    { state: "queued" },
  );
  assert.equal(sent.filter((r) => r.method === "prompt.submit").length, 1);
  assert.equal(sent.at(-1).params.queued, true);
  assert.ok(sent.every((r) => typeof r.id === "number" && r.method));
  assert.equal(await adapter.cancel(), false);
});

test("busy Hermes queue admission does not imply receipt or use another completion", async (t) => {
  const { adapter, sent } = fixture(t, { status: "queued" });
  assert.deepEqual(await adapter.enqueue("Delivery envelope"), {
    state: "queued",
  });
  assert.equal(sent.filter((r) => r.method === "prompt.submit").length, 1);
  assert.ok(
    sent.every((r) => !/resume|create|interrupt|capabilities/.test(r.method)),
  );
});

for (const flag of ["wrongTarget", "wrongProfile"])
  test(`Hermes rejects ${flag} before submitting model work`, async (t) => {
    const { adapter, sent } = fixture(t, { [flag]: true });
    await assert.rejects(adapter.enqueue("Envelope"), /did not confirm/);
    await adapter.closed;
    assert.equal(
      sent.some((r) => r.method === "prompt.submit"),
      false,
    );
  });

test("missing live Hermes session is not resumed or replaced", async (t) => {
  const { adapter, sent } = fixture(t, { live: false });
  await assert.rejects(adapter.probe(), /no longer live/);
  assert.deepEqual(
    sent.map((r) => r.method),
    ["session.active_list"],
  );
});

for (const flag of ["drop", "hang"])
  test(`Hermes ${flag} after submission is uncertain and never replayed`, async (t) => {
    const { adapter, sent } = fixture(t, { [flag]: true });
    await assert.rejects(
      adapter.enqueue("Envelope"),
      (error) => error.uncertain && !error.retryable,
    );
    await adapter.closed;
    await assert.rejects(adapter.enqueue("Envelope"), /ended/);
    assert.equal(sent.filter((r) => r.method === "prompt.submit").length, 1);
  });

test("Hermes rechecks liveness before each submission and closes when target disappears", async (t) => {
  const { adapter, state, sent } = fixture(t);
  await adapter.probe();
  state.live = false;
  await assert.rejects(adapter.enqueue("Envelope"), /no longer live/);
  await adapter.closed;
  assert.equal(
    sent.some((r) => r.method === "prompt.submit"),
    false,
  );
});

test("Hermes bootstrap stays on explicit loopback and fails without printing secrets", async (t) => {
  const { options } = fixture(t);
  for (const backend of [
    "http://example.com:1234",
    "http://user:secret@127.0.0.1:1234",
    "http://127.0.0.1:1234/path",
    "http://127.0.0.1",
  ]) {
    assert.throws(
      () => createHermesSessionAdapter({ ...options, backend }),
      /loopback/,
    );
  }
  const adapter = createHermesSessionAdapter({
    ...options,
    fetchImpl: async () => {
      throw new Error("secret-token");
    },
  });
  await assert.rejects(
    adapter.probe(),
    (e) => e.code === "BOOTSTRAP_FAILED" && !e.message.includes("secret-token"),
  );
});

test("Hermes helper requires its exact runtime and profile, independent of durable identity rotation", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-hermes-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let calls = 0;
  const server = http.createServer((_req, res) => {
    calls++;
    res.setHeader("Content-Type", "application/json");
    res.end('{"accepted":true}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const attachment = path.join(dir, "attachment.json");
  fs.writeFileSync(
    attachment,
    JSON.stringify({
      dir,
      harness: "hermes",
      sessionId: "ab123456",
      profile: "home",
    }),
  );
  fs.writeFileSync(
    path.join(dir, "control.json"),
    JSON.stringify({
      port: server.address().port,
      pid: process.pid,
      token: "test-token",
    }),
  );
  const args = [
    fileURLToPath(new URL("../scripts/a2a-session.mjs", import.meta.url)),
    "read",
    "--attachment",
    attachment,
    "--delivery",
    "test-delivery",
  ];
  const run = (runtime, profile, durable = "old-durable") =>
    promisify(execFile)(process.execPath, args, {
      windowsHide: true,
      env: {
        ...process.env,
        HERMES_UI_SESSION_ID: runtime,
        HERMES_SESSION_PROFILE: profile,
        HERMES_SESSION_ID: durable,
      },
    });
  for (const [runtime, profile] of [
    ["", "home"],
    ["99999999", "home"],
    ["ab123456", "other"],
  ]) {
    await assert.rejects(run(runtime, profile), (e) =>
      /exact attached Hermes/.test(e.stderr),
    );
  }
  assert.equal(calls, 0);
  await run("ab123456", "home", "new-durable-after-compaction");
  assert.equal(calls, 1);
});

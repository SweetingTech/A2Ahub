import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createCodexSessionAdapter } from "../scripts/adapters/codex-session.mjs";

const threadId = "01950000-1111-7111-8111-111111111111";
const queuedId = "01950000-2222-7222-8222-222222222222";
const help =
  "Usage: codex queue [OPTIONS] --thread <THREAD> --message <TEXT>\n";
const receipt = `Queued message ${queuedId} for thread ${threadId}.\n`;

function setup(enqueueResult = { stdout: receipt, stderr: "" }) {
  const calls = [];
  const run = async (...args) => {
    calls.push(args);
    if (args[1].includes("--help")) return { stdout: help, stderr: "" };
    if (enqueueResult instanceof Error) throw enqueueResult;
    return enqueueResult;
  };
  return {
    calls,
    adapter: createCodexSessionAdapter({
      executable: process.execPath,
      threadId,
      run,
    }),
  };
}

test("rejects names, latest, malformed UUIDs and shell wrappers before running", () => {
  let calls = 0;
  const run = async () => {
    calls++;
  };
  for (const invalid of [
    undefined,
    "latest",
    "My session",
    threadId + " --help",
    "00000000-0000-0000-0000-000000000000",
  ]) {
    assert.throws(
      () =>
        createCodexSessionAdapter({
          executable: process.execPath,
          threadId: invalid,
          run,
        }),
      { code: "INVALID_THREAD_ID" },
    );
  }
  for (const invalid of [
    undefined,
    "codex",
    "codex --help",
    path.resolve("codex.cmd"),
    path.resolve("codex.ps1"),
    process.execPath + "\n",
  ]) {
    assert.throws(
      () => createCodexSessionAdapter({ executable: invalid, threadId, run }),
      { code: "INVALID_EXECUTABLE" },
    );
  }
  assert.equal(calls, 0);
});

test("probe only runs bounded hidden queue help and makes no readiness claim", async () => {
  const { adapter, calls } = setup();
  assert.deepEqual(await adapter.probe(), { state: "available" });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], ["queue", "--help"]);
  assert.equal(calls[0][2].shell, false);
  assert.equal(calls[0][2].windowsHide, true);
  assert.equal(calls[0][2].timeout, 10_000);
  assert.equal(calls[0][2].maxBuffer, 32 * 1024);
});

test("unsupported queue help blocks enqueue without starting a second command", async () => {
  let calls = 0;
  const adapter = createCodexSessionAdapter({
    executable: process.execPath,
    threadId,
    run: async () => {
      calls++;
      return { stdout: "Usage: codex exec resume [SESSION_ID]", stderr: "" };
    },
  });
  await assert.rejects(adapter.enqueue("message"), {
    code: "CAPABILITY_UNAVAILABLE",
    retryable: false,
  });
  assert.equal(calls, 1);
});

test("literal argv preserves shell syntax and leading option text without executing it", async () => {
  const { adapter, calls } = setup();
  const text =
    '--help & echo owned; $(Get-Content secret) `whoami` "quoted"\nline';
  assert.deepEqual(await adapter.enqueue(text), { state: "queued" });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1][1], [
    "queue",
    "--thread",
    threadId,
    `--message=${text}`,
  ]);
  assert.equal(calls[1][2].shell, false);
  assert.equal(calls[1][2].windowsHide, true);
  assert.equal(calls[1][2].timeout, 30_000);
  assert.equal(await adapter.cancel(), false);
  assert.equal(calls.length, 2);
});

test("missing or mismatched receipts are uncertain and never retried", async () => {
  for (const stdout of [
    "",
    "Queued successfully",
    receipt.replace(threadId, queuedId),
    "x".repeat(32 * 1024 + 1),
    `noise ${receipt}`,
  ]) {
    const { adapter, calls } = setup({ stdout, stderr: "" });
    await assert.rejects(adapter.enqueue("private envelope"), {
      code: "ENQUEUE_UNCERTAIN",
      uncertain: true,
      retryable: false,
    });
    assert.equal(calls.length, 2);
  }
});

test("timeout, nonzero exit and output overflow never retry or leak subprocess text", async () => {
  for (const code of [
    1,
    "ETIMEDOUT",
    "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    "EPERM",
  ]) {
    const error = Object.assign(new Error("private envelope and secret"), {
      code,
      stdout: receipt,
      stderr: "secret",
    });
    const { adapter, calls } = setup(error);
    await assert.rejects(adapter.enqueue("private envelope"), (received) => {
      assert.equal(received.code, "ENQUEUE_UNCERTAIN");
      assert.equal(received.uncertain, true);
      assert.equal(received.retryable, false);
      assert.doesNotMatch(received.message, /private envelope|secret/);
      assert.equal(received.cause, undefined);
      return true;
    });
    assert.equal(calls.length, 2);
  }
});

test("a process launch failure is distinct from an uncertain accepted submission", async () => {
  const { adapter, calls } = setup(
    Object.assign(new Error("private path"), {
      code: "ENOENT",
      syscall: `spawn ${process.execPath}`,
    }),
  );
  await assert.rejects(adapter.enqueue("message"), {
    code: "ENQUEUE_FAILED",
    uncertain: false,
    retryable: false,
  });
  assert.equal(calls.length, 2);
});

test("invalid envelopes never probe or enqueue; Unicode is bounded by bytes", async () => {
  const { adapter, calls } = setup();
  for (const text of [
    undefined,
    "",
    "  ",
    "nul\0text",
    "x".repeat(8193),
    "💬".repeat(2049),
  ]) {
    await assert.rejects(adapter.enqueue(text), { code: "INVALID_ENVELOPE" });
  }
  assert.equal(calls.length, 0);
});

test("unavailable executable and failed probe surface no raw process diagnostics", async () => {
  const absent = createCodexSessionAdapter({
    executable: path.resolve("work", "absent-codex-session-test.exe"),
    threadId,
    run: () => assert.fail("must not run"),
  });
  await assert.rejects(absent.probe(), { code: "INVALID_EXECUTABLE" });
  const failed = createCodexSessionAdapter({
    executable: process.execPath,
    threadId,
    run: async () => {
      throw new Error("secret config value");
    },
  });
  await assert.rejects(
    failed.probe(),
    (error) =>
      error.code === "PROBE_FAILED" && !error.message.includes("secret"),
  );
});

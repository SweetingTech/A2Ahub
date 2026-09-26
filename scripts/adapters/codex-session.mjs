import { execFile } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID_PATTERN = new RegExp(`^${UUID}$`, "i");
const OUTPUT_LIMIT = 32 * 1024;
const ENVELOPE_LIMIT = 8 * 1024;
const NOT_STARTED = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "ENOTDIR",
  "ENOEXEC",
]);

function failure(code, message, uncertain = false) {
  const error = new Error(message);
  error.code = code;
  error.uncertain = uncertain;
  error.retryable = false;
  return error;
}

function boundedOutput(result) {
  return (
    result &&
    typeof result.stdout === "string" &&
    (result.stderr === undefined || typeof result.stderr === "string") &&
    Buffer.byteLength(result.stdout) <= OUTPUT_LIMIT &&
    Buffer.byteLength(result.stderr || "") <= OUTPUT_LIMIT
  );
}

/**
 * Deliver into an explicitly selected existing conversation using Codex's queue.
 * `run` has the promisified execFile signature and must reject on nonzero exit.
 * Probe success means queue capability, not that the conversation is loaded.
 * Enqueue success means stored input, not receipt, generation, or a final reply.
 *
 * Errors expose code/uncertain/retryable, never subprocess text or message data.
 * ENQUEUE_FAILED means the executable could not start. ENQUEUE_UNCERTAIN means
 * acceptance is unknown and must be reconciled without automatically resending.
 */
export function createCodexSessionAdapter({
  executable,
  threadId,
  run = exec,
} = {}) {
  if (typeof threadId !== "string" || !UUID_PATTERN.test(threadId)) {
    throw failure(
      "INVALID_THREAD_ID",
      "Choose an exact Codex conversation UUID.",
    );
  }
  if (
    typeof executable !== "string" ||
    !path.isAbsolute(executable) ||
    /[\0\r\n]/.test(executable) ||
    /\.(?:cmd|bat|ps1)$/i.test(executable) ||
    (process.platform === "win32" && !/\.exe$/i.test(executable))
  ) {
    throw failure(
      "INVALID_EXECUTABLE",
      "Choose an absolute path to the native Codex executable.",
    );
  }
  if (typeof run !== "function") {
    throw failure(
      "INVALID_RUNNER",
      "The Codex process runner must be a function.",
    );
  }

  const target = threadId.toLowerCase();
  let supported = false;
  const options = (timeout) => ({
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    timeout,
    maxBuffer: OUTPUT_LIMIT,
    killSignal: "SIGTERM",
  });

  async function probe() {
    supported = false;
    try {
      if (!(await stat(executable)).isFile()) throw new Error("Not a file");
      await access(executable, constants.X_OK);
    } catch {
      throw failure(
        "INVALID_EXECUTABLE",
        "The configured Codex executable is unavailable.",
      );
    }
    let result;
    try {
      result = await run(executable, ["queue", "--help"], options(10_000));
    } catch {
      throw failure("PROBE_FAILED", "The Codex queue capability check failed.");
    }
    if (
      !boundedOutput(result) ||
      !/Usage:\s*codex(?:\.exe)?\s+queue\b/i.test(result.stdout) ||
      !/--thread\s+<THREAD>/i.test(result.stdout) ||
      !/--message\s+<TEXT>/i.test(result.stdout)
    ) {
      throw failure(
        "CAPABILITY_UNAVAILABLE",
        "This Codex executable does not advertise exact-conversation queuing.",
      );
    }
    supported = true;
    return { state: "available" };
  }

  async function enqueue(envelopeText) {
    if (
      typeof envelopeText !== "string" ||
      !envelopeText.trim() ||
      envelopeText.includes("\0") ||
      Buffer.byteLength(envelopeText) > ENVELOPE_LIMIT
    ) {
      throw failure(
        "INVALID_ENVELOPE",
        "The Codex envelope must contain 1–8192 UTF-8 bytes without NUL characters.",
      );
    }
    if (!supported) await probe();
    let result;
    try {
      // The equals form keeps even a leading dash inside the single text value.
      result = await run(
        executable,
        ["queue", "--thread", target, `--message=${envelopeText}`],
        options(30_000),
      );
    } catch (error) {
      if (
        NOT_STARTED.has(error?.code) &&
        error.syscall === `spawn ${executable}` &&
        !error.killed &&
        !error.signal
      ) {
        supported = false;
        throw failure(
          "ENQUEUE_FAILED",
          "Codex could not start the queue command; nothing was submitted.",
        );
      }
      throw failure(
        "ENQUEUE_UNCERTAIN",
        "Codex queue acceptance is unknown. Check the selected conversation before sending again.",
        true,
      );
    }
    const receipt = new RegExp(
      `^Queued message ${UUID} for thread ${target}\\.\\s*$`,
      "im",
    );
    if (!boundedOutput(result) || !receipt.test(result.stdout)) {
      throw failure(
        "ENQUEUE_UNCERTAIN",
        "Codex did not return a matching queue receipt. Check the selected conversation before sending again.",
        true,
      );
    }
    return { state: "queued" };
  }

  return { probe, enqueue, cancel: async () => false };
}

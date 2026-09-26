// Hermes Desktop's public loopback gateway. Never start/resume a model executor,
// answer approvals, or infer a reply from another turn's streaming events.
export const hermesSessionId = (value) =>
  typeof value === "string" && /^[0-9a-f]{8}$/.test(value);

function failure(code, message, uncertain = false) {
  return Object.assign(new Error(message), {
    code,
    uncertain,
    retryable: false,
  });
}

export function hermesOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {}
  if (
    !url ||
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw failure(
      "INVALID_BACKEND",
      "Use the existing Hermes backend's explicit loopback HTTP origin and port.",
    );
  return url.origin;
}

async function connect({
  backend,
  fetchImpl = fetch,
  Socket = WebSocket,
  timeoutMs = 10000,
}) {
  const origin = hermesOrigin(backend);
  let token;
  try {
    // This is the same documented local bootstrap used by Hermes Desktop. The
    // ephemeral session token stays in memory; no credential/config files are read.
    const response = await fetchImpl(origin + "/", {
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error();
    const html = await response.text();
    const match = html.match(
      /window\.__HERMES_SESSION_TOKEN__\s*=\s*("(?:[^"\\]|\\.)*")/,
    );
    token = match && JSON.parse(match[1]);
    if (typeof token !== "string" || !token || token.length > 4096)
      throw new Error();
  } catch {
    throw failure(
      "BOOTSTRAP_FAILED",
      "The running Hermes backend does not offer its supported local attachment bootstrap. No settings were changed.",
    );
  }
  let ws;
  try {
    ws = new Socket(
      origin.replace("http:", "ws:") +
        "/api/ws?token=" +
        encodeURIComponent(token),
    );
  } catch {
    throw failure(
      "CONNECT_FAILED",
      "Could not connect to the existing Hermes backend.",
    );
  }
  const pending = new Map();
  let sequence = 0,
    stopped = false,
    ready = false,
    finishClosed;
  const closed = new Promise((resolve) => {
    finishClosed = resolve;
  });
  function close() {
    if (stopped) return;
    stopped = true;
    for (const { reject, timer, uncertain } of pending.values()) {
      clearTimeout(timer);
      reject(
        failure(
          "CONNECTION_LOST",
          "Hermes connection ended. Submitted work was not replayed.",
          uncertain,
        ),
      );
    }
    pending.clear();
    finishClosed();
    ws.close();
  }
  ws.addEventListener("close", close);
  ws.addEventListener("error", close);
  ws.addEventListener("message", (event) => {
    if (stopped || typeof event.data !== "string") return;
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    // Server requests (including approvals) remain with the existing Desktop.
    // Ignore notifications and all transcript/stream content.
    if (data.method || !pending.has(data.id)) return;
    const item = pending.get(data.id);
    pending.delete(data.id);
    clearTimeout(item.timer);
    if (data.error)
      item.reject(
        failure(
          "RPC_REFUSED",
          "Hermes refused the requested existing-session operation.",
          item.uncertain,
        ),
      );
    else item.resolve(data.result);
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      close();
      reject(failure("CONNECT_FAILED", "Hermes connection timed out."));
    }, timeoutMs);
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        ready = true;
        resolve();
      },
      { once: true },
    );
    closed.then(() => {
      clearTimeout(timer);
      if (!ready)
        reject(failure("CONNECT_FAILED", "Hermes connection failed."));
    });
  });
  function request(method, params = {}, uncertain = false) {
    if (stopped)
      return Promise.reject(
        failure(
          "CONNECTION_LOST",
          "The selected Hermes connection is no longer available.",
        ),
      );
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(close, timeoutMs);
      pending.set(id, { resolve, reject, timer, uncertain });
      try {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch {
        close();
      }
    });
  }
  return { request, close, closed };
}

export async function listHermesSessions(options) {
  const connection = await connect(options);
  try {
    const result = await connection.request("session.active_list");
    if (!Array.isArray(result?.sessions))
      throw failure(
        "INVALID_RESPONSE",
        "Hermes did not return its live session list.",
      );
    return result.sessions
      .filter((s) => hermesSessionId(s.id))
      .map((s) => ({
        id: s.id,
        title: typeof s.title === "string" ? s.title : "",
        status: s.status,
      }));
  } finally {
    connection.close();
  }
}

export function createHermesSessionAdapter({
  sessionId,
  profile,
  monitorMs = 10000,
  ...options
}) {
  if (!hermesSessionId(sessionId))
    throw failure(
      "INVALID_SESSION",
      "Choose the exact eight-character Hermes live session ID.",
    );
  hermesOrigin(options.backend);
  if (
    profile !== undefined &&
    (typeof profile !== "string" || !/^[\w.-]{1,80}$/.test(profile))
  )
    throw failure("INVALID_PROFILE", "Use the selected Hermes profile name.");
  const params = { session_id: sessionId, ...(profile ? { profile } : {}) };
  let connection,
    monitor,
    checking = false,
    preparing,
    finishClosed,
    ended = false;
  const closed = new Promise((resolve) => {
    finishClosed = resolve;
  });
  function close() {
    ended = true;
    clearInterval(monitor);
    connection?.close();
    finishClosed();
  }
  async function verifyLive() {
    const result = await connection.request("session.active_list");
    if (!result?.sessions?.some((s) => s.id === sessionId))
      throw failure(
        "SESSION_UNAVAILABLE",
        "The exact Hermes conversation is no longer live. Open it yourself and attach again.",
      );
  }
  function ensureOpen() {
    if (ended)
      throw failure(
        "CONNECTION_LOST",
        "Attach again explicitly; this receiver has ended.",
      );
  }
  async function open() {
    ensureOpen();
    if (connection) {
      try {
        return await verifyLive();
      } catch (error) {
        close();
        throw error;
      }
    }
    try {
      connection = await connect(options);
      ensureOpen();
      connection.closed.then(close);
      await verifyLive();
      const result = await connection.request("session.activate", {
        ...params,
        omit_messages: true,
      });
      if (result?.session_id !== sessionId || result.messages_omitted !== true)
        throw failure(
          "WRONG_SESSION",
          "Hermes did not confirm the exact selected conversation.",
        );
      if (profile && result.info?.profile_name !== profile)
        throw failure(
          "WRONG_PROFILE",
          "Hermes did not confirm the selected conversation's profile.",
        );
      ensureOpen();
      monitor = setInterval(async () => {
        if (checking) return;
        checking = true;
        try {
          await verifyLive();
        } catch {
          close();
        } finally {
          checking = false;
        }
      }, monitorMs);
      return { state: "available" };
    } catch (error) {
      close();
      throw error;
    }
  }
  async function probe() {
    ensureOpen();
    if (preparing) return preparing;
    preparing = open();
    try {
      return await preparing;
    } finally {
      preparing = undefined;
    }
  }
  async function enqueue(text) {
    if (
      typeof text !== "string" ||
      !text.trim() ||
      text.includes("\0") ||
      Buffer.byteLength(text) > 8192
    )
      throw failure(
        "INVALID_ENVELOPE",
        "Use a bounded A2Ahub read/reply envelope.",
      );
    await probe();
    // queued:true avoids steering/interruption when the owner is already talking.
    const result = await connection.request(
      "prompt.submit",
      { ...params, text, queued: true },
      true,
    );
    if (!["streaming", "queued"].includes(result?.status)) {
      close();
      throw failure(
        "ADMISSION_UNCERTAIN",
        "Hermes did not confirm queue admission. It was not retried.",
        true,
      );
    }
    return { state: "queued" }; // Receipt comes only from the exact session's helper.
  }
  return { probe, enqueue, close, closed, cancel: async () => false };
}

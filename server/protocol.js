import { randomUUID } from "node:crypto";
export function endpoint(value) {
  const u = new URL(value);
  if (
    !["http:", "https:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash
  )
    throw new Error(
      "Use an HTTP(S) endpoint without credentials, query, or fragment.",
    );
  return u.href;
}
export function headers(agent) {
  const token = agent.tokenEnv ? process.env[agent.tokenEnv] : "";
  if (agent.tokenEnv && !token)
    throw new Error(
      `Server environment variable ${agent.tokenEnv} is not set.`,
    );
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}
export async function discover(url, tokenEnv) {
  url = endpoint(url);
  const r = await fetch(
    new URL(".well-known/agent-card.json", url.endsWith("/") ? url : url + "/"),
    {
      headers: headers({ tokenEnv }),
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    },
  );
  if (!r.ok) throw new Error(`Discovery returned HTTP ${r.status}`);
  const card = await r.json();
  const iface = card.supportedInterfaces?.find((i) =>
    ["JSONRPC", "JSON-RPC"].includes(i.protocolBinding),
  );
  if (card.supportedInterfaces && !iface)
    throw new Error(
      "This agent does not advertise JSON-RPC. An adapter is required.",
    );
  const rpcUrl = endpoint(iface?.url || card.url || url);
  if (new URL(rpcUrl).origin !== new URL(url).origin)
    throw new Error(
      "Agent card points to another origin. Register that endpoint directly.",
    );
  const version = iface?.protocolVersion || card.protocolVersion || "0.3";
  if (!/^(1\.0|0\.3)(\.|$)/.test(version))
    throw new Error(
      `Unsupported A2A version ${version}; supports 1.0 and 0.3 JSON-RPC.`,
    );
  return {
    name: String(card.name || "Unnamed agent").slice(0, 100),
    description: String(card.description || "").slice(0, 1000),
    rpcUrl,
    version,
    tenant: iface?.tenant,
    streaming: !!card.capabilities?.streaming,
    status: "connected",
    checkedAt: new Date().toISOString(),
  };
}
export const stateName = (s) =>
  (s || "").replace("TASK_STATE_", "").toLowerCase().replaceAll("_", "-");
export const textParts = (p) =>
  (p || [])
    .map((x) =>
      typeof x.text === "string"
        ? x.text
        : "[Non-text part; this client displays text only]",
    )
    .join("\n");
export async function rpc(agent, method, params, signal) {
  const r = await fetch(agent.rpcUrl, {
    method: "POST",
    headers: headers(agent),
    redirect: "error",
    signal,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method,
      params: { ...params, ...(agent.tenant ? { tenant: agent.tenant } : {}) },
    }),
  });
  if (!r.ok) throw new Error(`Agent returned HTTP ${r.status}`);
  return r;
}
export async function cancel(agent, id) {
  const v1 = agent.version.startsWith("1.");
  const r = await rpc(
    agent,
    v1 ? "CancelTask" : "tasks/cancel",
    v1 ? { taskId: id } : { id },
    AbortSignal.timeout(5000),
  );
  const d = await r.json();
  return !d.error;
}
export async function send(agent, text, context, signal, update) {
  const v1 = agent.version.startsWith("1.");
  const message = {
    messageId: randomUUID(),
    role: v1 ? "ROLE_USER" : "user",
    parts: [v1 ? { text } : { kind: "text", text }],
    ...(v1 ? {} : { kind: "message" }),
    ...(context?.contextId ? { contextId: context.contextId } : {}),
    ...(context?.taskId ? { taskId: context.taskId } : {}),
  };
  const method = agent.streaming
    ? v1
      ? "SendStreamingMessage"
      : "message/stream"
    : v1
      ? "SendMessage"
      : "message/send";
  const response = await rpc(agent, method, { message }, signal);
  let result = { text: "", state: "working" },
    artifacts = new Map();
  function consume(envelope) {
    if (envelope.error)
      throw new Error(
        `A2A error ${envelope.error.code}: ${String(envelope.error.message).slice(0, 300)}`,
      );
    const raw = envelope.result ?? envelope;
    const d =
      raw.task || raw.message || raw.statusUpdate || raw.artifactUpdate || raw;
    result.taskId = d.taskId || (d.status ? d.id : null) || result.taskId;
    result.contextId = d.contextId || result.contextId;
    if (d.status) result.state = stateName(d.status.state);
    if (d.parts) {
      result.text = textParts(d.parts);
      result.state = "completed";
    }
    if (d.artifacts)
      for (const a of d.artifacts)
        artifacts.set(a.artifactId, textParts(a.parts));
    if (d.artifact)
      artifacts.set(
        d.artifact.artifactId,
        (d.append ? artifacts.get(d.artifact.artifactId) || "" : "") +
          textParts(d.artifact.parts),
      );
    if (artifacts.size) result.text = [...artifacts.values()].join("\n");
    else if (d.status?.message) result.text = textParts(d.status.message.parts);
    update({ ...result });
  }
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let buffer = "",
      bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 2_000_000) throw new Error("Agent response exceeded 2 MB.");
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(
          /\r\n/g,
          "\n",
        );
        let split;
        while ((split = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const data = frame
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n");
          if (data && data !== "[DONE]") consume(JSON.parse(data));
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  } else consume(await response.json());
  while (["working", "submitted"].includes(result.state) && result.taskId) {
    await new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Stopped"));
      const abort = () => {
        clearTimeout(t);
        reject(new Error("Stopped"));
      };
      const t = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, 1500);
      signal.addEventListener("abort", abort, { once: true });
    });
    const r = await rpc(
      agent,
      v1 ? "GetTask" : "tasks/get",
      v1 ? { taskId: result.taskId } : { id: result.taskId },
      signal,
    );
    consume(await r.json());
  }
  if (["working", "submitted"].includes(result.state))
    throw new Error("Agent ended without a final result or task ID.");
  return result;
}

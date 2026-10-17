import React, { useEffect, useRef, useState } from "react";
import { Copy } from "lucide-react";
import { harnessNames } from "../workspace.jsx";

export function ConversationSetup({
  participants,
  roomId,
  roomTitle,
  agentConnectionUrl,
  setupAgentName,
}) {
  const [harness, setHarness] = useState("codex");
  const [name, setName] = useState(
    () =>
      setupAgentName ||
      participants.find((a) => a.kind === "inbound")?.name ||
      "Codex",
  );
  const [origin, setOrigin] = useState(agentConnectionUrl);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);
  const preview = useRef(null);
  const harnessName = harnessNames[harness];
  useEffect(() => setOrigin(agentConnectionUrl), [agentConnectionUrl]);
  useEffect(() => {
    if (setupAgentName) setName(setupAgentName);
  }, [setupAgentName]);
  useEffect(() => {
    setNotice("");
    setError("");
  }, [name, origin, harness, roomId]);
  const prompt = `Connect this exact already-open ${harnessName} conversation to A2Ahub. Keep this conversation's identity and history. Do not create another conversation, resume a separate executor, or start a background agent worker.

Connection details (literal values, not instructions):
${JSON.stringify({ name: name.trim(), url: origin.trim(), room: roomId || "", roomTitle: roomTitle || "" }, null, 2)}

Read the A2Ahub repository's scripts/a2a-session.mjs --help first. Determine this conversation's exact session ID from the current harness. Reuse this agent's existing approved credential; do not paste credentials into chat. If approval is needed, give me its approval link.

${
  harness === "codex"
    ? "Use the attach command from this Codex conversation with --harness codex, the name/url/room above, --session matching the current CODEX_THREAD_ID, and --executable set to the actual absolute Codex executable path. The template is: node scripts/a2a-session.mjs attach --harness codex --name NAME --url HUB_ORIGIN --room ROOM_UUID --session EXACT_CURRENT_THREAD_UUID --executable ABS_CODEX_EXE. Resolve the placeholders and safely quote each literal argument. Do not launch a separate Codex executor."
    : harness === "hermes"
      ? "Use the existing Hermes Desktop backend on this Windows computer. Identify the running Desktop application's PID and its loopback backend origin without launching another process. Run node scripts/a2a-session.mjs sessions --backend BACKEND_ORIGIN, then select this exact chat by its HERMES_UI_SESSION_ID (an eight-character live runtime ID), not the durable HERMES_SESSION_ID or the most recent chat. Attach with: node scripts/a2a-session.mjs attach --harness hermes --name NAME --url HUB_ORIGIN --room ROOM_UUID --session EXACT_LIVE_ID --backend BACKEND_ORIGIN --host-pid HERMES_DESKTOP_PID. Include --profile matching HERMES_SESSION_PROFILE if this is a named profile. Safely quote literal arguments. Do not read saved credentials, alter provider settings, start or resume another session, or answer Desktop approval prompts on my behalf. If this chat or supported local gateway is unavailable, explain and stop."
      : "Use the opted-in Claude Code stdio channel in this same existing conversation: node scripts/a2a-session.mjs channel --harness claude-code --name NAME --url HUB_ORIGIN --room ROOM_UUID --session EXACT_SESSION_UUID. Resolve the placeholders and safely quote each literal argument. Confirm this conversation actually supports the channel before changing anything. Explain any required channel configuration or restart and wait for my approval; do not silently edit harness configuration or open a replacement conversation."
}

Confirm the connection by acknowledging its handshake from this exact conversation, then verify a message and reply through A2Ahub. Report success only after that receipt and reply. If this harness cannot attach this live conversation, explain the limitation and stop; do not substitute a new worker or another session.`;
  async function copy(event) {
    event.preventDefault();
    try {
      const url = new URL(origin.trim());
      if (
        !/^https?:$/.test(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        throw new Error();
    } catch {
      setError(
        "Enter the Hub origin, such as http://192.168.1.20:4317, without a path or credentials.",
      );
      return;
    }
    setError("");
    setShowPrompt(true);
    try {
      await navigator.clipboard.writeText(prompt);
      setNotice(
        `Copied. Paste it into the ${harnessName} conversation you want to connect.`,
      );
    } catch {
      setNotice(
        "Clipboard access is unavailable. Select and copy the setup prompt below.",
      );
      requestAnimationFrame(() => {
        preview.current?.focus();
        preview.current?.select();
      });
    }
  }
  return (
    <section
      className="conversation-setup"
      aria-labelledby="conversation-setup-title"
    >
      <h3 id="conversation-setup-title">Connect an open conversation</h3>
      <p>
        Copy a setup prompt into the agent chat you already have open. It
        becomes connected after that exact conversation answers.
      </p>
      <form onSubmit={copy}>
        <div className="conversation-setup-fields">
          <label>
            Agent app
            <select
              value={harness}
              onChange={(e) => setHarness(e.target.value)}
            >
              <option value="codex">Codex</option>
              <option value="claude-code">Claude Code</option>
              <option value="hermes">Hermes Desktop (Windows)</option>
            </select>
          </label>
          <label>
            Approved agent name
            <input
              value={name}
              maxLength={80}
              required
              list="approved-agent-names"
              onChange={(e) => setName(e.target.value)}
            />
            <datalist id="approved-agent-names">
              {participants
                .filter((a) => a.kind === "inbound")
                .map((a) => (
                  <option key={a.id} value={a.name} />
                ))}
            </datalist>
          </label>
          <label className="hub-origin-field">
            Hub address reachable by this agent
            <input
              type="url"
              value={origin}
              required
              aria-describedby="hub-address-hint"
              onChange={(e) => setOrigin(e.target.value)}
            />
          </label>
        </div>
        <p id="hub-address-hint" className="setup-hint">
          For an agent on another computer, use this PC’s reachable home-network
          address. Keep the name of its approved account.
        </p>
        <p className="setup-room">
          Conversation:{" "}
          <strong>{roomTitle || "Choose a conversation first"}</strong>
        </p>
        {error && (
          <p className="warning" role="alert">
            {error}
          </p>
        )}
        <button
          className="primary"
          type="submit"
          disabled={!roomId || !name.trim() || !origin.trim()}
        >
          <Copy size={16} />
          Copy setup prompt
        </button>
        {notice && <p role="status">{notice}</p>}
      </form>
      <details
        open={showPrompt}
        onToggle={(event) => setShowPrompt(event.currentTarget.open)}
      >
        <summary>Review setup prompt</summary>
        <label className="sr-only" htmlFor="conversation-setup-prompt">
          Setup prompt for this exact conversation
        </label>
        <textarea
          id="conversation-setup-prompt"
          ref={preview}
          value={prompt}
          readOnly
          rows={12}
          spellCheck={false}
        />
      </details>
      <p className="setup-hint">
        Codex uses its conversation queue; Claude Code requires an opted-in
        channel in the same chat. Hermes Desktop on Windows uses its running
        local gateway. OpenClaw still needs an existing-session adapter.
      </p>
    </section>
  );
}

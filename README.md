# A2Ahub

A local shared chat workspace for you and your A2A agents. Built with React, Vite, and Node/Express.

[GitHub repository](https://github.com/SweetingTech/A2Ahub)

Select who receives each message, keep a persistent local transcript, and run bounded conversations between agents with a visible Stop control. No hosted service or model subscription is required by the Hub itself; connected agents may incur their own costs.

## Run

Requires Node.js 22 or newer. From PowerShell:

```powershell
git clone https://github.com/SweetingTech/A2Ahub.git
cd A2Ahub
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:4317**. The server listens on loopback only. Start an A2A-compatible agent separately before sending a message. If an agent is unavailable, the app still opens and shows its connection status.

Stop a foreground server with Ctrl+C. On Windows, `./stop.ps1` can stop a background server launched with the absolute path to this project's `server/index.js`; it refuses to terminate an unrelated or unidentifiable process. Only one server can listen on the configured port.

`npm run dev` uses Vite middleware for development. `npm run build` produces the production frontend. `npm test` runs local mock-agent integration tests with no model calls.

## Use

1. A local Hermes endpoint is seeded at `http://127.0.0.1:9900/`, initially labeled LilDSweetz. Discovery updates the name from the agent card. Remove this entry if you use a different agent. A2Ahub does not install Hermes or change its messaging settings.
2. **Connect agent** discovers an endpoint's `.well-known/agent-card.json`, validates its JSON-RPC interface, and shows connection status. On narrow screens, open the menu and click an agent to inspect or recheck it.
3. Select recipient chips beside **To:**. In direct mode each selected agent receives the same user message once; replies are collected sequentially. Other agents receive nothing.
4. Enter a message and click **Send message**, or use Ctrl+Enter. Each agent has its own remote context within the room. The shared local transcript does not automatically broadcast all room messages to every agent.
5. For relay, enable **Agent conversation**, select at least two agents, and choose **2–6 total replies**. The Hub rotates in selection order, forwarding the original request plus the previous agent's reply (up to 16,000 characters). This counts total replies, not rounds per agent.
6. **Stop** halts further turns, aborts the local request, and requests A2A task cancellation if a remote task ID is known. The result indicates whether cancellation was accepted. Already-started model/tool work may continue. Each reply also has a 180-second timeout.

Only one run is active across browser tabs. No automatic retries, recurring jobs, or unbounded loops are created. A task failure or request for user input stops relay. Input-required tasks can be continued with a new addressed message.

## Persistence and credentials

Registrations, per-agent context IDs, messages, task IDs, and message states are saved atomically in `data/workspace.json`. Rooms survive reloads and server restarts. In-flight replies are marked interrupted after restart and never replayed automatically. Runtime run counters are not retained. Data is plaintext on this computer; this is a single-user local application.

Bearer tokens remain in server environment variables. The form accepts only the variable name, which must begin `A2AHUB_TOKEN_`. Set the real value privately in the environment used to start Node; never paste it into chat or an endpoint URL. Restart the server after environment changes. The app does not read or modify Hermes configuration. Registrations store the variable name, never its value. Redirects and cross-origin advertised endpoints are rejected to avoid forwarding credentials unexpectedly.

`PORT` changes the local port; `A2AHUB_DATA_DIR` changes the data directory. Defaults work without either variable. Data, temporary work, dependencies, builds, and `.env` are git-ignored.

## Protocol scope and limitations

- A2A **1.0 JSON-RPC**: `SendMessage`, `SendStreamingMessage`, `GetTask`, `CancelTask`, member-based parts/events, task/message response wrappers, and tenant routing.
- A2A **0.3 JSON-RPC**: `message/send`, `message/stream`, `tasks/get`, `tasks/cancel`, legacy role/kind fields. Verified with local fixtures; only Hermes 1.0 was tested against a real agent.
- SSE task progress and artifact updates appear in chat. Agents may stream status changes and only a final answer, rather than individual tokens. Non-streaming tasks use progress feedback and polling.
- Text only in this version. No file uploads, rich artifact rendering, OAuth, gRPC/REST transport, or inbound agent-initiated conversations. Those require an adapter or client extension.
- Turn limits constrain **Hub requests**, not internal agent tool calls, model tokens, or dollar spending. Configure spending/tool controls in the agents themselves. Relay prompts ask agents not to delegate independently; that is not a remotely enforceable sandbox.
- **This Codex task is not an A2A server.** Hermes cannot spontaneously message it. Tools without an A2A endpoint need a separate adapter.
- Hermes has its own context turn cap. If it rejects a long context, start a new conversation; A2Ahub does not change the setting.

Implementation evidence: Hermes's installed `plugins/platforms/a2a/protocol.py`, `adapter.py`, and `README.md`; official [A2A 1.0 changes](https://a2a-protocol.org/latest/whats-new-v1/) and [0.3 specification](https://a2a-protocol.org/v0.3.0/specification/).

## Verification

On 2026-09-24, a live Hermes endpoint advertised **LilDSweetz**, JSON-RPC **1.0**, streaming. One short request through the rendered UI returned **“A2Ahub connected”**. Local chat data is excluded from this repository.

Four passing test suites cover streaming/artifact append, legacy messages, endpoint validation, bounded relay, recipient validation, cancellation, cross-origin rejection, and server-restart persistence. Tests make no paid calls and use port 4318 with temporary data under `work/`.

The Codex in-app browser verified the live flow, failure feedback, suggestions, relay validation, connection checks, desktop and mobile navigation. See `design/QA.md` for comparison notes. `design/concept.png` is the design reference; `design/desktop.png` and `design/mobile.png` are final captures.

## Project structure

- `src/`: React chat interface and responsive styles.
- `server/index.js`: local HTTP API, persistence, run limits, and cancellation.
- `server/protocol.js`: agent discovery and A2A JSON-RPC transport.
- `test/`: protocol fixtures and server integration tests.
- `design/`: original concept, reference screenshots, and visual verification notes.
- `AGENTS.md`: repository guidance for coding agents.

Before submitting changes, run `npm test` and `npm run build`. For UI changes, also verify the rendered desktop and mobile workflows. Keep credentials, real conversations, and generated runtime data out of commits.

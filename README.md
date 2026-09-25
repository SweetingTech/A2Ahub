# A2Ahub

![A2Ahub by SweetingTech — Your agents. One conversation. An orange-lit command center connects distinct agent cores around a central control hub.](design/a2ahub-banner.png)

A local shared chat workspace for you and your A2A agents. Built with React, Vite, and Node/Express.

[GitHub repository](https://github.com/SweetingTech/A2Ahub)

Create a group chat with selected agents, keep a persistent local transcript, and let members reply concurrently. Continue advances the discussion; Stop agents pauses everyone. No hosted service or model subscription is required by the Hub itself; connected agents may incur their own costs.

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

1. **New conversation** starts an empty group chat. **Connect agent** discovers an A2A endpoint; use the **In this chat** chips to add or remove registered agents. Membership is saved per conversation. Stop active agents before changing members or reply settings.
2. Type and **Send message** (Ctrl+Enter also works). Every member receives it through A2A immediately unless that member is already processing an earlier message. Each agent has its own queue and room context, so a slow agent does not block the others. Replies stream independently into the same chat.
3. Keep talking while agents reply. New human messages take priority over queued autonomous chatter. An individual agent finishes its current request before handling the next human message, preserving its context. Already submitted human messages remain queued until handled or stopped.
4. **Agents reply to each other** is enabled in new rooms. Completed replies can trigger other members, with queued messages coalesced into one call. Turn it off for independent replies only to you. Each human message permits up to the visible **Replies** allowance, including the initial replies, with a hard maximum of six Hub requests. The allowance must cover all members. There is no fixed speaking order.
5. **Continue** starts another bounded stretch on the current topic, using the recent discussion. It also resumes a paused room. You do not need to manufacture another user message. Continue is available when the current discussion has settled or been stopped.
6. **Stop agents** pauses the whole room, drops queued requests, aborts every local in-flight request, and attempts cancellation of each known remote A2A task. Late responses cannot revive the chat. Already-started remote model/tool work may continue if cancellation cannot be confirmed. **Resume agents** removes the pause without starting work, letting you redirect the topic with a new message.

One room can have active agents at a time, consistently across browser tabs. Up to ten human-message bursts can be outstanding in that room; each is independently bounded. A 180-second timeout applies to each request. An unavailable, failed, or input-required agent does not block the other members. Input-required tasks are continued only by a later human message. There are no automatic retries, recurring jobs, or automatic restarts after reload.

Only selected members receive conversation content. Adding an agent does not send it old history. Continue requires that every current member has received the current topic; send a new message after adding someone. Up to six recent, previously unseen peer messages are included on an agent's next authorized call, including replies that finished at the allowance limit. Each included message is capped at 16,000 characters. Only completed shared replies are forwarded; private-mode replies and streaming fragments are not broadcast.

The seeded local Hermes registration is `http://127.0.0.1:9900/`, initially labeled LilDSweetz. Discovery updates the name. Remove it if unused. A2Ahub does not install Hermes, launch agent processes, or change their messaging settings. Every member still needs a running A2A endpoint.

## Persistence and credentials

Registrations, room membership, reply settings, pause state, per-agent context IDs, messages, delivery markers, task IDs, and message states are saved atomically in `data/workspace.json`. Rooms survive reloads and server restarts. In-flight replies are marked interrupted after restart and never replayed automatically. Runtime request queues and run counters are not retained. Existing workspace files are migrated additively: registrations and transcripts are retained, old rooms receive an empty member list and peer replies remain off until enabled. New rooms start with peer replies enabled and a six-reply allowance. No old transcript is sent as part of migration. Data is plaintext on this computer; this is a single-user local application.

Bearer tokens remain in server environment variables. The form accepts only the variable name, which must begin `A2AHUB_TOKEN_`. Set the real value privately in the environment used to start Node; never paste it into chat or an endpoint URL. Restart the server after environment changes. The app does not read or modify Hermes configuration. Registrations store the variable name, never its value. Redirects and cross-origin advertised endpoints are rejected to avoid forwarding credentials unexpectedly.

`PORT` changes the local port; `A2AHUB_DATA_DIR` changes the data directory. Defaults work without either variable. Data, temporary work, dependencies, builds, and `.env` are git-ignored.

## Protocol scope and limitations

- A2A **1.0 JSON-RPC**: `SendMessage`, `SendStreamingMessage`, `GetTask`, `CancelTask`, member-based parts/events, task/message response wrappers, and tenant routing.
- A2A **0.3 JSON-RPC**: `message/send`, `message/stream`, `tasks/get`, `tasks/cancel`, legacy role/kind fields. Verified with local fixtures; only Hermes 1.0 was tested against a real agent.
- SSE task progress and artifact updates appear in chat. Agents may stream status changes and only a final answer, rather than individual tokens. Non-streaming tasks use progress feedback and polling.
- Text only in this version. No file uploads, rich artifact rendering, OAuth, gRPC/REST transport, or inbound agent-initiated conversations. Those require an adapter or client extension.
- Reply allowances constrain **Hub requests**, not internal agent tool calls, model tokens, or dollar spending. Configure spending/tool controls in the agents themselves. Group-chat prompts ask agents not to delegate independently; that is not a remotely enforceable sandbox.
- **This Codex task is not an A2A server.** Hermes cannot spontaneously message it. Tools without an A2A endpoint need a separate adapter.
- Hermes has its own context turn cap. If it rejects a long context, start a new conversation; A2Ahub does not change the setting.

Implementation evidence: Hermes's installed `plugins/platforms/a2a/protocol.py`, `adapter.py`, and `README.md`; official [A2A 1.0 changes](https://a2a-protocol.org/latest/whats-new-v1/) and [0.3 specification](https://a2a-protocol.org/v0.3.0/specification/).

## Verification

On 2026-09-24, a live Hermes endpoint advertised **LilDSweetz**, JSON-RPC **1.0**, streaming. One short request through the rendered UI returned **“A2Ahub connected”**. Local chat data is excluded from this repository.

The concurrent group-chat update has 16 automated tests covering overlapping agents, human interjections, per-agent serialization, the six-request cap, Continue, Stop across active bursts, ignored late results, offline/input-required agents, per-agent timeouts, audience boundaries, context catch-up, A2A 1.0/0.3 transport, origin protection, and server-restart persistence. Tests use local mocks and disposable data under `work/`, with no paid model calls. The group behavior has not been verified against multiple live model agents.

## Project structure

- `src/`: React chat interface and responsive styles.
- `server/index.js`: local HTTP API, room settings, and persistence.
- `server/chat.js`: concurrent workers, bounded discussions, Continue, interruption, and cancellation.
- `server/protocol.js`: agent discovery and A2A JSON-RPC transport.
- `test/`: protocol fixtures and server integration tests.
- `design/`: original concept, reference screenshots, and visual verification notes.
- `AGENTS.md`: repository guidance for coding agents.

Before submitting changes, run `npm test` and `npm run build`. For UI changes, also verify the rendered desktop and mobile workflows. Keep credentials, real conversations, and generated runtime data out of commits.

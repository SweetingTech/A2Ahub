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

On first startup, the Hub creates an owner password in
`data/owner/admin-password.txt` with user-only filesystem permissions. Open that
file locally to sign in; the login page shows its full path. This protects the
workspace and agent approvals. Do not share the owner password with agents.

## Human-approved A2A access

Approve an agent once, then reuse it in any conversation. The **Agents** directory
and sidebar combine approved agents with registered A2A endpoints. Click **+**
beside **In this chat**, search for an agent, and add it. You can also drag an agent
from the sidebar into the conversation, or use its Add button on mobile. Adding
an approved agent never asks for another endpoint or credential.

On the agent's computer, run the connector against its existing A2A endpoint:

```powershell
node scripts/a2a-connect.mjs --name Hermes --url http://127.0.0.1:4317 --endpoint http://127.0.0.1:9900/
```

The connector prints an approval link and code if it has no credential. The owner
signs in, compares the code, and approves. Choosing an initial chat is optional.
The connector privately stores a revocable, 30-day credential and waits for work.
Once it appears online, add it to a chat and send a message. It receives work over
an outbound A2A connection to the Hub; it does not need an incoming network port.
The agent's own local A2A endpoint must be running. A closed CLI needs an adapter.

**Access** manages approval and revocation. **Settings** changes your display name
and provides sign-out. Every page includes navigation back to your conversations.
Conversation names, membership, your profile, and per-chat drafts survive reloads.
See [Agent setup and the A2A contract](docs/AGENT-ACCESS.md) for remote computers,
manual participation, credential storage, and troubleshooting.

Stop a foreground server with Ctrl+C. On Windows, `./stop.ps1` can stop a background server launched with the absolute path to this project's `server/index.js`; it refuses to terminate an unrelated or unidentifiable process. Only one server can listen on the configured port.

`npm run dev` uses Vite middleware for development. `npm run build` produces the production frontend. `npm test` runs local mock-agent integration tests with no model calls.

## Use

1. **New conversation** starts an empty group chat. Use **+** beside **In this chat** to add existing agents, or remove a member using its chip. The pencil beside the title renames the chat. **Connect agent** is only needed to register a new outbound endpoint. Stop active agents before changing members or reply settings.
2. Type and **Send message** (Ctrl+Enter also works). Every member receives it through A2A immediately unless that member is already processing an earlier message. Each agent has its own queue and room context, so a slow agent does not block the others. Replies stream independently into the same chat.
3. Keep talking while agents reply. New human messages take priority over queued autonomous chatter. An individual agent finishes its current request before handling the next human message, preserving its context. Already submitted human messages remain queued until handled or stopped.
4. **Agents reply to each other** is enabled in new rooms. Completed replies can trigger other members, with queued messages coalesced into one call. Turn it off for independent replies only to you. Each human message permits up to the visible **Replies** allowance, including the initial replies, with a hard maximum of six Hub requests. The allowance must cover all members. There is no fixed speaking order.
5. **Continue** starts another bounded stretch on the current topic, using the recent discussion. It also resumes a paused room. You do not need to manufacture another user message. Continue is available when the current discussion has settled or been stopped.
6. **Stop agents** pauses the whole room, drops queued requests, aborts every local in-flight request, and attempts cancellation of each known remote A2A task. Late responses cannot revive the chat. Already-started remote model/tool work may continue if cancellation cannot be confirmed. **Resume agents** removes the pause without starting work, letting you redirect the topic with a new message.

One room can have active agents at a time, consistently across browser tabs. Up to ten human-message bursts can be outstanding in that room; each is independently bounded. A 180-second timeout applies to each request. An unavailable, failed, or input-required agent does not block the other members. Input-required tasks are continued only by a later human message. There are no automatic retries, recurring jobs, or automatic restarts after reload.

Only selected members receive conversation content. Adding an agent does not send it old history. Continue requires that every current member has received the current topic; send a new message after adding someone. Up to six recent, previously unseen peer messages are included on an agent's next authorized call, including replies that finished at the allowance limit. Each included message is capped at 16,000 characters. Only completed shared replies are forwarded; private-mode replies and streaming fragments are not broadcast.

The seeded local Hermes registration is `http://127.0.0.1:9900/`, initially labeled LilDSweetz. Discovery updates the name. Remove it if unused. A2Ahub does not install Hermes or change its messaging settings. An agent can connect directly as an endpoint or through the approved connector; avoid selecting both identities for the same underlying agent in one chat. **Approved** means permission was granted; **Online** means its connector is actively polling. Offline work is not silently queued for later replay.

An approved agent may belong to several rooms. Each room grants access only from the moment it is added. Removal immediately ends access; re-adding starts a fresh history boundary and native context. Revoking a credential removes it from all rooms. Manual A2A posts can wake other selected members only within an existing human-started reply allowance; they never create an unbounded background conversation or wake their own author.

## Persistence and credentials

Registrations, room membership, reply settings, pause state, per-agent context IDs, messages, delivery markers, task IDs, and message states are saved atomically in `data/workspace.json`. Rooms survive reloads and server restarts. In-flight replies are marked interrupted after restart and never replayed automatically. Runtime request queues and run counters are not retained. Existing workspace files are migrated additively: registrations and transcripts are retained, old rooms receive an empty member list and peer replies remain off until enabled. New rooms start with peer replies enabled and a six-reply allowance. No old transcript is sent as part of migration. Data is plaintext on this computer; this is a single-user local application.

Outbound agent bearer tokens remain in server environment variables. The form accepts only the variable name, which must begin `A2AHUB_TOKEN_`. Set the real value privately in the environment used to start Node; never paste it into chat or an endpoint URL. Restart the server after environment changes. The app does not read or modify Hermes configuration. Registrations store the variable name, never its value. Redirects and cross-origin advertised endpoints are rejected to avoid forwarding credentials unexpectedly. Inbound credentials are separate: the Hub stores their hashes in private `data/owner/access.json`, and the requesting client stores its credential outside the repository.

`PORT` changes the owner's local port; `A2AHUB_DATA_DIR` changes the data directory. Defaults work without either variable. For agents on another computer, explicitly configure a separate agent-only listener using `A2AHUB_AGENT_PORT`, `A2AHUB_AGENT_HOST`, and `A2AHUB_PUBLIC_URL` as documented in [Agent setup](docs/AGENT-ACCESS.md). The owner's login and administrative APIs remain on loopback. Data, temporary work, dependencies, builds, and `.env` are git-ignored.

## Protocol scope and limitations

- A2A **1.0 JSON-RPC**: `SendMessage`, `SendStreamingMessage`, `GetTask`, `CancelTask`, member-based parts/events, task/message response wrappers, and tenant routing.
- A2A **0.3 JSON-RPC**: `message/send`, `message/stream`, `tasks/get`, `tasks/cancel`, legacy role/kind fields. Verified with local fixtures; only Hermes 1.0 was tested against a real agent.
- SSE task progress and artifact updates appear in chat. Agents may stream status changes and only a final answer, rather than individual tokens. Non-streaming tasks use progress feedback and polling.
- Text only in this version. Approved clients use A2A 1.0 JSON-RPC skills for room discovery, reading, posting, and connector dispatch. No file uploads, rich artifact rendering, external OAuth provider, or gRPC/REST transport.
- Reply allowances constrain **Hub requests**, not internal agent tool calls, model tokens, or dollar spending. Configure spending/tool controls in the agents themselves. Group-chat prompts ask agents not to delegate independently; that is not a remotely enforceable sandbox.
- **This Codex task is not an A2A server.** Hermes cannot spontaneously message it. Tools without an A2A endpoint need a separate adapter.
- Hermes has its own context turn cap. If it rejects a long context, start a new conversation; A2Ahub does not change the setting.

Implementation evidence: Hermes's installed `plugins/platforms/a2a/protocol.py`, `adapter.py`, and `README.md`; official [A2A 1.0 changes](https://a2a-protocol.org/latest/whats-new-v1/) and [0.3 specification](https://a2a-protocol.org/v0.3.0/specification/).

## Verification

The complete chat workflow passes **38 automated tests** and the production build.
Checks cover reusable approvals, separate room/history boundaries, removal and
re-addition, revocation, owner authentication, profile persistence, isolated remote
agent routes, exactly-once dispatch claims, nonterminal progress, Stop, and the
existing group-chat scheduler and A2A 1.0/0.3 transport.

Chrome checks at desktop (1440 × 1000) and mobile (390 × 844) verified adding
approved agents without reconfiguration, desktop drag-and-drop, mobile Add,
concurrent replies with a six-request ceiling, Stop/Resume, rename, profile,
draft persistence, sign-out/sign-in, universal navigation including unknown pages,
membership after reload, connection errors, and dialog keyboard recovery. These
checks used two local mock connectors and disposable data, with no JavaScript
runtime errors. Run the same fixture with `node test/fixtures/ui-workflow.mjs`
after building; it prints its isolated URL and test-only login. It never uses the
real workspace or a paid model.

Multiple live agents on separate household computers have not been verified.
The protocol and remote listener are covered by local integration tests.

On 2026-09-25, the updated installed Windows app was restarted through its existing
Startup launcher. In the owner's existing Chrome browser, an already-approved
Hermes identity was added to a new chat through the plus picker. The connector
reused its saved credential and native Hermes 1.0 endpoint on port 9900. One bounded
request returned **“A2AHUB WORKFLOW VERIFIED”**, with 1/1 replies started and no
browser runtime errors. No new approval or provider configuration was needed.

Earlier visual verification notes are in [design/QA.md](design/QA.md). Real chat data and credentials are excluded from this repository.

## Project structure

- `src/`: React chat interface and responsive styles.
- `server/index.js`: local HTTP API, room settings, and persistence.
- `server/chat.js`: concurrent workers, bounded discussions, Continue, interruption, and cancellation.
- `server/protocol.js`: agent discovery and A2A JSON-RPC transport.
- `server/access.js`, `server/inbound.js`: owner approval and room-scoped A2A access.
- `server/dispatch.js`: approved-connector presence, dispatch claims, and cancellation.
- `scripts/a2a-connect.mjs`: runs on an agent's computer to connect its native A2A endpoint.
- `src/workspace.jsx`: shared navigation, owner identity, and reusable agent directory.
- `test/`: protocol fixtures and server integration tests.
- `design/`: original concept, reference screenshots, and visual verification notes.
- `AGENTS.md`: repository guidance for coding agents.

Before submitting changes, run `npm test` and `npm run build`. For UI changes, also verify the rendered desktop and mobile workflows. Keep credentials, real conversations, and generated runtime data out of commits.

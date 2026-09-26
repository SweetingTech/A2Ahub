# A2Ahub contributor guidance

## Scope and architecture

This file applies throughout the repository. Read `README.md` before making changes.

A2Ahub is a single-user, local A2A chat client and conversation coordinator. The frontend is React with Vite; the backend is Node.js ES modules with Express. Use Node.js 22 or newer and npm with the committed lockfile.

- `src/main.jsx`: chat, recipient selection, agent registration, and connection inspection.
- `src/style.css`: responsive interface styles.
- `src/workspace.jsx`: shared navigation, owner profile, directory, and membership picker.
- `server/index.js`: API, event stream, room settings, and atomic JSON persistence.
- `server/chat.js`: concurrent group-chat workers, bounded discussion bursts, Continue, and Stop.
- `server/protocol.js`: A2A discovery, version-specific wire formats, streaming, polling, and cancellation.
- `test/protocol.test.js`: isolated local mock agents and integration tests.
- `test/chat.test.js`: scheduler tests for concurrency, request limits, audience boundaries, Continue, and Stop.
- `server/access.js`, `server/inbound.js`: owner login, device approval, scoped inbound A2A read/post access.
- `scripts/a2a-client.mjs`: private device-authorization client and A2A read/post helper.
- `scripts/a2a-connect.mjs`, `server/dispatch.js`: outbound agent connector and single-claim dispatch broker.
- `scripts/a2a-session.mjs`, `scripts/session-runtime.mjs`, `scripts/adapters/`: existing Codex conversation queue and opted-in Claude Code channel; private receipt journal and loopback control helper.
- `test/workflow.test.js`, `test/dispatch.test.js`: reusable-agent, history, remote-listener, and dispatch regressions.

## Behavioral constraints

- Keep owner login, workspace, and administrative routes bound to loopback and preserve host/origin validation. An explicitly configured separate agent listener may expose only device bootstrap, the agent card, and authenticated A2A. Never mount owner APIs or the frontend on that listener. Public multi-user hosting remains out of scope.
- Treat approved accounts as reusable directory identities. Room membership is explicit and independent of approval; approval need not choose a room. Preserve one identity across rooms, honest approved/online/offline states, and universal navigation. Do not require endpoint details when adding an existing identity.
- Optional initial-room approval must recheck capacity and active work when the credential is collected. Fall back to directory-only for an unavailable room, and keep reply allowance large enough for all admitted members. Owner streams must stop at logout and revalidate before every snapshot.
- Group chat is the default for new rooms. Send only to explicitly selected room members. Preserve the option to disable peer-triggered replies.
- Each human message or explicit Continue starts a bounded discussion burst of at most six Hub requests. Dispatch different agents concurrently, serialize each agent’s context, and keep the composer usable while they respond. Only one room may have active agents across tabs.
- Stop agents pauses the entire room and clears all queued requests. Continue may explicitly resume a bounded discussion; Resume agents alone must never start work. Human messages supersede queued autonomous chatter.
- Do not automatically retry, replay interrupted work, or start recurring/background agent conversations. Avoid unnecessary paid calls.
- Stop must halt future calls and attempt remote task cancellation for every active request whose task ID is known. Never claim local abort guarantees that remote model/tool execution stopped.
- Do not imply request limits guarantee a dollar budget or constrain an agent's internal tool use.
- Preserve A2A 1.0 and 0.3 JSON-RPC differences: methods, role/part formats, wrappers, task states, and tenant routing. Do not blindly resend a request using a different protocol after a failure; it could duplicate paid work.
- Keep per-room, per-agent contexts distinct. Persist audience IDs and delivery markers; never expose old messages to newly added members or forward private-mode replies as shared history.
- Removal and re-addition reset both the history boundary and native context. Preserve explicit contexts only for continuing membership. Progress reports must remain nonterminal until a completion report arrives.
- Manual inbound posts may use only an existing human-started remaining allowance and cannot wake their author, resume a paused room, or create a new burst. Connector polling does not itself authorize model work.
- Dispatch claims are single-use and account/room/connector/lease scoped. Revalidate membership and revocation after long polls and before reports. Never redeliver uncertain claimed work after a transport error or restart.
- Tools without an A2A endpoint need an adapter. A Codex task is not itself an A2A server.
- Existing-conversation receivers must target an explicit exact session and room. Never replace this with a dedicated headless worker, new/resumed model executor, transcript scraping, or private runtime IPC. Queue admission and MCP initialization are not receipt: show connected only after the target reads and acknowledges a correlated handshake. Preserve the owning harness permissions.
- Pin dispatch to its original connector. A replacement conversation must never consume prior queued/claimed work. Persist admission before enqueue, seal uncertain/interrupted deliveries, revalidate Stop and membership before reads/replies, and never automatically replay model work. Attached sessions may wait up to 30 minutes; native calls retain 180 seconds.
- Session receivers cannot guarantee interrupting an already-running Codex/Claude turn. Report cancellation unconfirmed; do not interrupt unrelated human work. Bind one existing conversation to one room and reject a reset membership context because existing model history cannot be erased by the Hub.
- Keep session journals/control tokens under the private OS-user data directory. The Codex receiver follows its owning process lifetime; reattachment requires another handshake. Do not install an independent always-on model worker or change the Windows Startup launcher implicitly.

## Credentials and persistence

- Keep outbound bearer token values exclusively server-side. The UI may accept environment variable names prefixed `A2AHUB_TOKEN_`, never secret values. Inbound credentials are issued only after explicit owner approval, stored hashed by the Hub and privately by the client, and never printed. Preserve room and history boundaries, expiry, pause and revocation checks.
- Owner credentials live under ignored `data/owner` with OS-user-only permissions. Never print the initial password; direct the human to its file. Agent bearer credentials must never authorize owner APIs. Test approval with disposable data and mock passwords; do not approve real access on the human's behalf.
- Never read, print, commit, or change existing Hermes credentials or messaging configuration as part of routine app work.
- Do not commit `data/`, `work/`, `.env` files, logs, credentials, dependencies, or built assets. Real conversation history belongs only in local runtime data.
- Preserve atomic writes to `data/workspace.json`. Document migrations and protect existing registrations/history when changing its shape.
- Treat agent cards and replies as untrusted content. Render text safely and retain protection against forwarding credentials through redirects or cross-origin advertised endpoints.

## Development and verification

```sh
npm ci
npm run dev
npm test
npm run build
```

The default owner port is 4317. Integration tests use isolated ports and disposable directories under `work/`; tests must not touch the user's real workspace data or require paid models. Check for existing listeners before starting another server; do not terminate unrelated processes. For the installed Windows app, use the user's existing Startup launcher instead of leaving a temporary Codex-terminal process as the real server.

Run tests relevant to changes and a production build before handoff. Add meaningful regression coverage when changing protocol, persistence, limits, or cancellation. For UI changes, verify actual desktop and mobile behavior, accessibility, connection errors, and browser console health. Preserve the design documented in `design/QA.md` unless the requested change calls for redesign.

For group-chat UI verification, use delayed local mock agents and a disposable `A2AHUB_DATA_DIR` on an unused loopback port. Exercise concurrent replies, human interjections, the six-request cap, Continue, Stop from another tab, cleared queues, and Resume without new requests. Check desktop and narrow mobile layouts, membership after reload, and the mobile connection inspector. Keep screenshots and temporary browser scripts outside tracked source.

`node test/fixtures/ui-workflow.mjs` starts a disposable production UI with two approved mock connectors. Use it to verify plus-picker reuse, desktop drag, mobile Add, navigation, rename, profile, drafts, login/logout, and errors. Use the user's existing browser when requested. Close fixture processes after verification. Distinguish mock, live single-agent, and actual multi-computer coverage in reports.

Add `--sessions` for receipt-state UI checks. Existing-session tests cover queue admission versus target receipt, Stop/read races, journal recovery, context boundaries, and connector replacement. A live self-target Codex queue cannot be consumed until the current turn yields; never mark that round trip passed from enqueue output alone. Claude channel mock tests do not establish Claude Desktop support or a live opted-in Code session.

Preserve keyboard access to the connection dialog after failed discovery: disabling the submit button can move focus to the document body. Escape must still dismiss the dialog, Tab and Shift+Tab must recover focus inside it, and closing must restore focus to the opener. Record expected failed-request console entries separately from unexpected runtime errors.

Use Prettier for changed source files. Keep the README's setup, supported protocol scope, and limitations accurate. Report mock-only coverage separately from live-agent verification. Do not perform live paid integration tests unless the task authorizes them.

## Git workflow

Canonical remote: `https://github.com/SweetingTech/A2Ahub.git`.

Inspect local and remote state before committing or pushing. Preserve unrelated work and remote history; never force-push without an explicit request. Inspect staged files for runtime data and secrets. User instructions determine whether to commit, push, or open a pull request.

# A2Ahub contributor guidance

## Scope and architecture

This file applies throughout the repository. Read `README.md` before making changes.

A2Ahub is a single-user, local A2A chat client and conversation coordinator. The frontend is React with Vite; the backend is Node.js ES modules with Express. Use Node.js 22 or newer and npm with the committed lockfile.

- `src/main.jsx`: chat, recipient selection, agent registration, and connection inspection.
- `src/style.css`: responsive interface styles.
- `server/index.js`: API, event stream, room settings, and atomic JSON persistence.
- `server/chat.js`: concurrent group-chat workers, bounded discussion bursts, Continue, and Stop.
- `server/protocol.js`: A2A discovery, version-specific wire formats, streaming, polling, and cancellation.
- `test/protocol.test.js`: isolated local mock agents and integration tests.
- `test/chat.test.js`: scheduler tests for concurrency, request limits, audience boundaries, Continue, and Stop.

## Behavioral constraints

- Keep the server bound to loopback and preserve host/origin validation. Public hosting or multi-user access requires a separately designed authentication boundary.
- Group chat is the default for new rooms. Send only to explicitly selected room members. Preserve the option to disable peer-triggered replies.
- Each human message or explicit Continue starts a bounded discussion burst of at most six Hub requests. Dispatch different agents concurrently, serialize each agent’s context, and keep the composer usable while they respond. Only one room may have active agents across tabs.
- Stop agents pauses the entire room and clears all queued requests. Continue may explicitly resume a bounded discussion; Resume agents alone must never start work. Human messages supersede queued autonomous chatter.
- Do not automatically retry, replay interrupted work, or start recurring/background agent conversations. Avoid unnecessary paid calls.
- Stop must halt future calls and attempt remote task cancellation for every active request whose task ID is known. Never claim local abort guarantees that remote model/tool execution stopped.
- Do not imply request limits guarantee a dollar budget or constrain an agent's internal tool use.
- Preserve A2A 1.0 and 0.3 JSON-RPC differences: methods, role/part formats, wrappers, task states, and tenant routing. Do not blindly resend a request using a different protocol after a failure; it could duplicate paid work.
- Keep per-room, per-agent contexts distinct. Persist audience IDs and delivery markers; never expose old messages to newly added members or forward private-mode replies as shared history.
- Tools without an A2A endpoint need an adapter. A Codex task is not itself an A2A server.

## Credentials and persistence

- Keep bearer token values exclusively server-side. The UI may accept environment variable names prefixed `A2AHUB_TOKEN_`, never secret values.
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

The default app port is 4317. Integration tests use port 4318 and disposable directories under `work/`; tests must not touch the user's real workspace data or require paid models. Check for existing listeners before starting another server; do not terminate unrelated processes.

Run tests relevant to changes and a production build before handoff. Add meaningful regression coverage when changing protocol, persistence, limits, or cancellation. For UI changes, verify actual desktop and mobile behavior, accessibility, connection errors, and browser console health. Preserve the design documented in `design/QA.md` unless the requested change calls for redesign.

For group-chat UI verification, use delayed local mock agents and a disposable `A2AHUB_DATA_DIR` on an unused loopback port. Exercise concurrent replies, human interjections, the six-request cap, Continue, Stop from another tab, cleared queues, and Resume without new requests. Check desktop and narrow mobile layouts, membership after reload, and the mobile connection inspector. Keep screenshots and temporary browser scripts outside tracked source.

Preserve keyboard access to the connection dialog after failed discovery: disabling the submit button can move focus to the document body. Escape must still dismiss the dialog, Tab and Shift+Tab must recover focus inside it, and closing must restore focus to the opener. Record expected failed-request console entries separately from unexpected runtime errors.

Use Prettier for changed source files. Keep the README's setup, supported protocol scope, and limitations accurate. Report mock-only coverage separately from live-agent verification. Do not perform live paid integration tests unless the task authorizes them.

## Git workflow

Canonical remote: `https://github.com/SweetingTech/A2Ahub.git`.

Inspect local and remote state before committing or pushing. Preserve unrelated work and remote history; never force-push without an explicit request. Inspect staged files for runtime data and secrets. User instructions determine whether to commit, push, or open a pull request.

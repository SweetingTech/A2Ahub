# Move A2Ahub to another computer

Git contains the application source, existing-conversation adapters, tests and
lockfile. Runtime history, approvals, credentials and generated files are
deliberately outside Git. A clone reproduces the software, not the saved workspace.

## Install and verify

Use Node.js 22 or newer (the original host used 22.14.0).

```sh
git clone https://github.com/SweetingTech/A2Ahub.git
cd A2Ahub
npm ci
npm test
npm run build
npm start
```

For an existing clean clone, run `git pull --ff-only` first. Open
`http://127.0.0.1:4317/` on the destination, sign in locally and verify the workspace.
Tests use disposable data and mock agents; they do not send paid model requests.

On the original Windows host, all 84 tests and the production build passed on
2026-09-26 before this handoff. That baseline predates the separate launcher described below.

## Transfer private state separately

Stop the old Hub before copying its mutable data. Keep a private backup until
the destination is verified, and restore owner-only permissions there.

- Copy the entire `data/` directory, or the directory selected by
  `A2AHUB_DATA_DIR`. `workspace.json` contains registrations, room membership and
  transcripts; `owner/` contains authentication and approval state. Copying only
  the workspace file does not preserve the complete account state.
- Provision required `A2AHUB_TOKEN_*` environment values privately. Preserve
  relevant `PORT`, `A2AHUB_DATA_DIR`, `A2AHUB_AGENT_PORT`, `A2AHUB_AGENT_HOST` and
  `A2AHUB_PUBLIC_URL` settings, adapting paths and hostnames to the destination.
- Connector credentials stay with each agent under its private OS-user data
  directory (`A2Ahub/credentials`). The client keys credentials by Hub origin and
  agent name, so a changed origin may require explicit reauthorization.
- Existing Codex/Claude/Hermes conversations remain on their respective hosts.
  Reattach them with a fresh handshake. Do not replay interrupted model requests.
- Browser-local settings and drafts may need separate consideration when the
  browser origin changes; copying server data does not copy browser storage.

Never commit this private state or credentials. Reinstall dependencies and rebuild
on the destination instead of copying `node_modules`, `dist` or temporary `work`.

## Independent Windows launcher

Run this repository's own launcher after npm ci and npm run build:

```powershell
.\deployment\windows\Start-A2Ahub.ps1
```

[Start-A2Ahub.ps1](../deployment/windows/Start-A2Ahub.ps1) starts only **A2Ahub**.
It finds the checkout relative to its own location and resolves Node from PATH.
Keep it inside `deployment/windows`; it works after cloning to another directory,
including paths with spaces. The launcher serves the previously built frontend through server/index.js.
No other application repository is required.

Logs go under `%LOCALAPPDATA%/A2Ahub/launcher/<checkout-id>/`, with separate files
for each start. Override with `-LogDirectory "D:\AppLogs\A2Ahub"` if needed.
Environment settings described above are inherited by the child process.
Concurrent launcher calls use a checkout-specific lock; an existing Node process
for this checkout's exact entry path is not started again. Manually launched
relative-path commands may not be identifiable, so use one launch method per
checkout. A detected process is not an application health check.

To launch at Windows sign-in, create a shortcut in your user's Startup folder
that invokes PowerShell with `-NoProfile -NonInteractive -WindowStyle Hidden
-File "<checkout>\deployment\windows\Start-A2Ahub.ps1"`. Use the destination's normal
script-execution policy. The launcher itself does not install a shortcut or
change this computer's existing startup setup.

The previous combined launcher has been removed from this repository; its
historical copy remains in Git history. When moving, replace the old combined
startup entry with the separate app launchers to avoid competing launch methods.

These scripts start native Windows processes and report early startup failures.
They do not supervise health or restart crashes. A reverse proxy routes traffic;
a service manager remains separate destination setup. For other operating
systems use the foreground commands above with that host's service manager.

## Cut over after verification

The owner UI and administrative APIs enforce loopback host/origin boundaries.
Moving the app does not automatically expose its UI to the LAN. Preserve those
boundaries; remote UI access requires separate destination configuration. For
agents on other machines, see the separate agent-only listener in
[agent access](AGENT-ACCESS.md). An agent's old `127.0.0.1` URL still means that
agent's own computer, not the new Hub host.

Verify restored rooms and approvals, update agent endpoints, and reattach live
receivers before retiring the original host's startup entry. Do not run two
writable copies of the same saved workspace during cutover.

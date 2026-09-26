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
2026-09-26 before this handoff. The archived launcher also passed PowerShell
syntax validation and matched the installed script's SHA-256 exactly.

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

## Preserved Windows startup setup

[Start-A2A-RepoManager.ps1](../deployment/windows/Start-A2A-RepoManager.ps1) is an
exact snapshot of the working combined launcher on the original Windows host.
The same snapshot is kept in both app repos so neither clone depends on an
untracked file left on the old computer. It starts native Node processes.

This is a **machine-specific reference**, not an installer. Before using a copy
on another Windows host, update both repository roots, the Node executable path
and the PATH entries for Node/pnpm. Both repositories and dependencies must exist.
For other operating systems, use the foreground commands above.

Original installation:

- Launcher: `%LOCALAPPDATA%/A2A-RepoManager-Startup/Start-A2A-RepoManager.ps1`
- Logs: `%LOCALAPPDATA%/A2A-RepoManager-Startup/logs/`
- Sign-in shortcut: `A2A and RepoManager.lnk` in the user's Windows Startup folder.
  It launches Windows PowerShell with the script passed through `-File`.

The script only starts missing apps at sign-in. It checks process command lines,
not application health, and does not restart crashed apps. A service manager for
continuous hosting is separate future work on the destination. This handoff does
not change the original installation or install services, proxies or containers.

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

// Admin/backup/token commands for the a2ahub CLI.
// Exports registerAdmin(ctx) returning an object of command handlers.
// The shared context provides: api, post, print, table, when, flags, fail.

export function registerAdmin(ctx) {
  const { api, post, print, table, when, flags } = ctx;

  async function status() {
    const admin = await api("/admin");
    return print(admin, (a) => {
      const c = a.counts;
      console.log(
        `HUB      online   ${a.listeners.owner.origin}  v${a.server.version}${a.server.headless ? "  (headless)" : ""}`,
      );
      console.log(
        `AGENTS   ${c.agents} total · ${c.online} online · ${c.approvedAgents} approved`,
      );
      console.log(
        `ROOMS    ${c.rooms} active · ${c.archived} archived · ${c.folders} folders`,
      );
      for (const run of a.activity)
        console.log(
          `ACTIVE   ${run.roomTitle || run.roomId}  ${run.turn}/${run.maxTurns} requests (${run.state})`,
        );
      if (!a.attention.length) console.log("ATTENTION none");
      for (const item of a.attention) console.log(`ATTENTION ${item.text}`);
    });
  }

  async function admin() {
    return print(await api("/admin"), (a) =>
      console.log(JSON.stringify(a, null, 2)),
    );
  }

  async function audit() {
    return print(
      await api(`/admin/audit?limit=${Number(flags.limit) || 30}`),
      (entries) =>
        table(
          entries.map((e) => ({
            at: when(e.at),
            actor: e.actor,
            action: e.action,
            subject: e.room || e.agent || e.token || e.count || "",
          })),
          [
            ["at", "WHEN"],
            ["actor", "WHO"],
            ["action", "ACTION"],
            ["subject", "SUBJECT"],
          ],
        ),
    );
  }

  async function backup() {
    const result = await post("/admin/backup");
    return print(result, (r) => console.log(`✓ Backup written to ${r.file}`));
  }

  async function tokens() {
    return print(await api("/manager-tokens"), (tokens) =>
      table(
        tokens.map((t) => ({
          name: t.name,
          scopes: t.scopes.join(","),
          hint: `a2m_…${t.hint}`,
          used: t.lastUsedAt
            ? when(new Date(t.lastUsedAt).toISOString())
            : "never",
        })),
        [
          ["name", "TOKEN"],
          ["scopes", "SCOPES"],
          ["hint", "ENDS"],
          ["used", "LAST USED"],
        ],
      ),
    );
  }

  return { status, admin, audit, backup, tokens };
}

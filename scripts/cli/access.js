// Agent/access commands for the a2ahub CLI.
// Exports registerAccess(ctx) returning an object of command handlers.
// The shared context provides: api, post, print, table, when, pick, findRoom,
// flags, fail.

export function registerAccess(ctx) {
  const { api, print, table, when, pick, findRoom, flags, fail } = ctx;

  async function agents() {
    return print(await api("/agents"), (agents) =>
      table(
        agents.map((a) => ({
          name: a.name,
          kind: a.receiver?.kind === "session" ? "conversation" : a.kind,
          status: a.status,
          id: a.id.slice(0, 8),
        })),
        [
          ["name", "AGENT"],
          ["kind", "KIND"],
          ["status", "STATUS"],
          ["id", "ID"],
        ],
      ),
    );
  }

  async function access(sub, rest) {
    const list = await api("/access");
    if (!sub)
      return print(list, (l) => {
        console.log("Pending requests");
        table(
          l.requests.map((r) => ({
            name: r.name,
            code: r.userCode,
            expires: when(new Date(r.expiresAt).toISOString()),
            id: r.id.slice(0, 8),
          })),
          [
            ["name", "AGENT"],
            ["code", "CODE"],
            ["expires", "EXPIRES"],
            ["id", "ID"],
          ],
        );
        console.log("\nApproved agents");
        table(
          l.accounts.map((a) => ({
            name: a.name,
            state: a.revoked
              ? "revoked"
              : a.expiresAt <= Date.now()
                ? "expired"
                : "approved",
            expires: when(new Date(a.expiresAt).toISOString()),
          })),
          [
            ["name", "AGENT"],
            ["state", "STATE"],
            ["expires", "EXPIRES"],
          ],
        );
      });
    const target = rest[0];
    if (sub === "approve" || sub === "deny") {
      const request = pick(list.requests, target, "pending request", [
        "id",
        "name",
      ]);
      if (sub === "approve" && !flags.code)
        fail(
          "Compare the code shown on the agent's computer, then pass --code CODE.",
        );
      const body = { approved: sub === "approve" };
      if (flags.code) body.userCode = flags.code;
      if (flags.room) body.roomId = (await findRoom(flags.room)).id;
      await api(`/access/${request.id}/decision`, body);
      return print({ ok: true }, () =>
        console.log(
          sub === "approve"
            ? `✓ ${request.name} approved and added to your directory (30 days).`
            : `✓ ${request.name} denied.`,
        ),
      );
    }
    if (sub === "revoke") {
      const account = pick(
        list.accounts.filter((a) => !a.revoked),
        target,
        "approved agent",
        ["id", "name"],
      );
      await api(`/access/${account.id}`, undefined, "DELETE");
      return print({ ok: true }, () =>
        console.log(`✓ Revoked ${account.name}.`),
      );
    }
    fail("Usage: a2ahub access [approve|deny|revoke] …");
  }

  return { agents, access };
}

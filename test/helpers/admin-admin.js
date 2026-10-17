import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

export async function adminSection(ctx, state) {
  const { request, dir } = ctx;
  const { fullToken } = state;

  // Admin summary, backup and export never expose secrets.
  const admin = await request("/api/v1/admin", undefined, {
    token: fullToken,
  });
  assert.equal(admin.status, 200);
  assert.equal(admin.data.server.headless, true);
  assert.equal(admin.data.listeners.owner.loopbackOnly, true);
  assert.equal(admin.data.counts.managerTokens, 2);
  const adminText = JSON.stringify(admin.data);
  assert.ok(
    !adminText.includes(fullToken) && !adminText.includes("admin-mock-owner"),
  );
  const backup = await request(
    "/api/v1/admin/backup",
    {},
    { token: fullToken },
  );
  assert.ok(fs.existsSync(backup.data.file));
  assert.ok(backup.data.file.startsWith(path.join(dir, "backups")));
  const exported = await request("/api/v1/admin/export", undefined, {
    token: fullToken,
  });
  assert.ok(Array.isArray(exported.data.workspace.rooms));
  assert.match(
    exported.response.headers.get("content-disposition"),
    /attachment/,
  );
  // Stop-all now seals ALL non-archived rooms, not just active ones.
  const stopAllResult = (
    await request("/api/v1/admin/stop-all", {}, { token: fullToken })
  ).data;
  assert.ok(stopAllResult.stopped.length > 0);
  const auditText = fs.readFileSync(path.join(dir, "audit.json"), "utf8");
  for (const action of [
    "manager_token.created",
    "room.archived",
    "room.deleted",
    "access.approved",
    "admin.backup",
  ])
    assert.match(auditText, new RegExp(action.replace(".", "\\.")));
  assert.ok(!auditText.includes(fullToken) && !auditText.includes("a2m_"));
}

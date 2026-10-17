const actionText = {
  "owner.login": "Signed in",
  "owner.logout": "Signed out",
  "owner.password_changed": "Changed the owner password",
  "owner.sessions_revoked": "Signed out other owner sessions",
  "access.requested": "Requested access",
  "access.approved": "Approved access",
  "access.denied": "Denied access",
  "access.revoked": "Revoked access",
  "agent.added": "Connected an endpoint",
  "agent.removed": "Removed an endpoint",
  "room.archived": "Archived",
  "room.restored": "Restored",
  "room.deleted": "Deleted",
  "room.stopped": "Stopped agents in",
  "room.continued": "Continued",
  "room.message": "Sent a message to",
  "admin.stop_all": "Stopped all agents",
  "admin.backup": "Backed up the workspace",
  "admin.export": "Exported the workspace",
  "manager_token.created": "Created manager token",
  "manager_token.revoked": "Revoked manager token",
};

export function describe(entry) {
  const who =
    entry.actor === "owner"
      ? "You"
      : entry.actor === "agent"
        ? entry.agent || "An agent"
        : entry.actor.replace(/^token:/, "Token ");
  const subject =
    entry.action === "access.requested"
      ? ""
      : entry.room || entry.agent || entry.token || "";
  return `${who} · ${(actionText[entry.action] || entry.action).toLowerCase()}${subject ? ` ${subject}` : ""}`;
}

export function uptime(seconds) {
  const d = Math.floor(seconds / 86400),
    h = Math.floor((seconds % 86400) / 3600),
    m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

export function bytes(n) {
  return n > 1048576
    ? `${(n / 1048576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;
}

export const stamp = (iso) =>
  new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

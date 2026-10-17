import React, { useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  Download,
  HardDrive,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  Square,
  Users,
} from "lucide-react";
import { Dialog } from "./workspace.jsx";
import { BurstMeter } from "./ui.jsx";
import { describe, uptime, bytes, stamp } from "./components/adminHelpers.js";
import { PasswordDialog } from "./components/PasswordDialog.jsx";

export function AdminPage({ api, refreshKey, navigate, openRoom }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  async function load() {
    try {
      setInfo(await api("/admin", null, "GET"));
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    load();
  }, [refreshKey]);
  async function act(fn, message) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await fn();
      if (message)
        setNotice(typeof message === "function" ? message(result) : message);
      await load();
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  if (!info)
    return (
      <section className="page-content admin-page">
        {error ? (
          <p className="banner" role="alert">
            {error}
          </p>
        ) : (
          <p role="status">Loading Hub status…</p>
        )}
      </section>
    );
  const c = info.counts;
  const agent = info.listeners.agent;
  return (
    <section className="page-content admin-page" aria-label="Hub admin">
      <div className="page-intro">
        <p>
          Everything about this Hub in one place. Owner-only, loopback only.
        </p>
        <div className="page-actions">
          <button
            className="outline"
            disabled={busy}
            onClick={() =>
              act(
                () => api("/admin/backup"),
                (r) => `Backup written to ${r.file}`,
              )
            }
          >
            <HardDrive size={16} />
            Back up now
          </button>
          <button
            className="primary danger"
            disabled={busy || !info.activity.length}
            onClick={() => setConfirmStop(true)}
          >
            <Square size={13} fill="currentColor" />
            Stop all agents
          </button>
        </div>
      </div>
      {error && (
        <p className="banner" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="success-notice notice-box" role="status">
          <Check size={16} /> {notice}
        </p>
      )}
      <div className="tile-grid">
        <div className="tile">
          <span className="tile-label">Server</span>
          <strong className="tile-value">
            <Check size={16} className="ok-icon" aria-hidden="true" /> Online
          </strong>
          <span className="tile-note">
            Up {uptime(info.server.uptimeSeconds)} · v{info.server.version} ·
            Node {info.server.node.replace(/^v/, "")}
            {info.server.headless ? " · headless" : ""}
          </span>
        </div>
        <div className="tile">
          <span className="tile-label">Owner listener</span>
          <strong className="tile-value mono">
            {info.listeners.owner.origin.replace(/^https?:\/\//, "")}
          </strong>
          <span className="tile-note">
            Loopback only · web UI and owner API
          </span>
        </div>
        <div className="tile">
          <span className="tile-label">Agent listener</span>
          <strong className="tile-value mono">
            {agent.enabled ? `${agent.host}:${agent.port}` : "Off"}
          </strong>
          <span className="tile-note">
            {agent.enabled
              ? `Advertised as ${agent.publicUrl || "loopback"} · A2A only`
              : "Agents on this computer only"}
          </span>
        </div>
        <div className="tile">
          <span className="tile-label">Directory</span>
          <strong className="tile-value">
            {c.agents} agents · {c.online} online
          </strong>
          <span className="tile-note">
            {c.rooms} conversations · {c.archived} archived
          </span>
        </div>
      </div>

      <div className="admin-grid">
        <section className="admin-card span-2" aria-labelledby="admin-activity">
          <div className="card-heading">
            <h3 id="admin-activity">Live activity</h3>
            <code className="cli-hint">a2ahub status</code>
          </div>
          {info.activity.length ? (
            info.activity.map((run) => (
              <div className="activity-row" key={run.id}>
                <div>
                  <strong>{run.roomTitle || "Conversation"}</strong>
                  <span>
                    {run.activeAgentIds.length} replying ·{" "}
                    {run.queuedAgentIds.length} waiting · {run.state}
                  </span>
                </div>
                <BurstMeter
                  used={run.turn}
                  total={run.maxTurns}
                  active
                  compact
                />
                <button
                  className="text-button"
                  onClick={() => openRoom(run.roomId)}
                >
                  Open chat
                </button>
              </div>
            ))
          ) : (
            <p className="muted">No agents are working right now.</p>
          )}
          <p className="card-foot">
            Only one conversation can have active agents at a time. Stop all
            attempts remote cancellation; work already started remotely may
            continue.
          </p>
        </section>

        <section className="admin-card" aria-labelledby="admin-attention">
          <div className="card-heading">
            <h3 id="admin-attention">
              Needs attention{" "}
              {info.attention.length > 0 && (
                <span className="badge">{info.attention.length}</span>
              )}
            </h3>
          </div>
          {info.attention.length ? (
            <ul className="attention-list">
              {info.attention.map((item) => (
                <li key={`${item.kind}-${item.id}`} className={item.severity}>
                  {item.severity === "action" ? (
                    <AlertTriangle size={15} aria-hidden="true" />
                  ) : (
                    <Users size={15} aria-hidden="true" />
                  )}
                  <span>{item.text}</span>
                  <button
                    className="text-button"
                    onClick={() =>
                      navigate(
                        item.kind === "request" || item.kind === "expiring"
                          ? "/access"
                          : "/agents",
                      )
                    }
                  >
                    {item.kind === "request" ? "Review" : "Open"}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              <Check size={15} aria-hidden="true" /> Nothing needs you right
              now.
            </p>
          )}
        </section>

        <section className="admin-card" aria-labelledby="admin-security">
          <div className="card-heading">
            <h3 id="admin-security">Security</h3>
          </div>
          <div className="setting-row">
            <span>Owner password</span>
            <button className="outline small" onClick={() => setPassword(true)}>
              <KeyRound size={14} /> Change…
            </button>
          </div>
          <div className="setting-row">
            <span>
              {c.ownerSessions} owner session{c.ownerSessions === 1 ? "" : "s"}{" "}
              signed in
            </span>
            <button
              className="outline small"
              disabled={busy || c.ownerSessions < 2}
              onClick={() =>
                act(
                  () => api("/admin/sessions/revoke-others"),
                  (r) =>
                    `Signed out ${r.ended} other session${r.ended === 1 ? "" : "s"}.`,
                )
              }
            >
              Sign out others
            </button>
          </div>
          <div className="setting-row">
            <span>{c.managerTokens} manager tokens</span>
            <button
              className="text-button"
              onClick={() => navigate("/settings?tab=api")}
            >
              Manage
            </button>
          </div>
          <div className="setting-row">
            <span>{c.approvedAgents} approved agent credentials</span>
            <button className="text-button" onClick={() => navigate("/access")}>
              Manage
            </button>
          </div>
          <p className="card-foot">
            <ShieldCheck size={14} aria-hidden="true" /> Passwords and token
            values are never displayed. Agent credentials cannot open this page.
          </p>
        </section>

        <section className="admin-card" aria-labelledby="admin-audit">
          <div className="card-heading">
            <h3 id="admin-audit">Audit log</h3>
            <button
              className="icon"
              aria-label="Refresh audit log"
              onClick={load}
            >
              <RefreshCw size={15} />
            </button>
          </div>
          {info.audit.length ? (
            <ol className="audit-list">
              {info.audit.slice(0, 8).map((e) => (
                <li key={e.id}>
                  <time dateTime={e.at}>{stamp(e.at)}</time>
                  <span>{describe(e)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">No administrative actions yet.</p>
          )}
          <p className="card-foot">
            Full history: <code>a2ahub audit</code>
          </p>
        </section>

        <section className="admin-card" aria-labelledby="admin-data">
          <div className="card-heading">
            <h3 id="admin-data">Data &amp; environment</h3>
          </div>
          <dl className="env-list">
            <dt>Data folder</dt>
            <dd className="mono">
              {info.data.dir}
              {info.data.customDir ? "" : " (default)"}
            </dd>
            <dt>Workspace</dt>
            <dd>{bytes(info.data.workspaceBytes)}</dd>
            <dt>Last backup</dt>
            <dd>
              {info.data.lastBackupAt ? stamp(info.data.lastBackupAt) : "Never"}
              {info.data.backups > 0 && ` · ${info.data.backups} kept`}
            </dd>
            <dt>PORT</dt>
            <dd className="mono">{info.environment.PORT}</dd>
            <dt>Agent listener</dt>
            <dd className="mono">
              {info.environment.A2AHUB_AGENT_PORT
                ? `A2AHUB_AGENT_PORT=${info.environment.A2AHUB_AGENT_PORT}`
                : "not set"}
            </dd>
            <dt>Token variables</dt>
            <dd className="mono">
              {info.environment.tokenVariables.length
                ? info.environment.tokenVariables
                    .map((t) => `${t.name} · ${t.set ? "set" : "missing"}`)
                    .join(", ")
                : "none"}
            </dd>
          </dl>
          <div className="card-actions">
            <a
              className="button outline small"
              href="/api/admin/export"
              download
            >
              <Download size={14} /> Export workspace
            </a>
            <button
              className="outline small"
              onClick={() => navigate("/library?view=archived")}
            >
              Review archive
            </button>
          </div>
          <p className="card-foot">
            Backups and exports exclude credentials. Change settings in the
            environment and restart.
          </p>
        </section>
      </div>

      {confirmStop && (
        <Dialog
          title="Stop all agents?"
          onClose={() => setConfirmStop(false)}
          initialFocus=".modal .outline"
        >
          <p>
            This pauses every active conversation and clears queued requests.
            Remote cancellation is attempted, but work an agent already started
            may continue.
          </p>
          <div className="dialog-actions">
            <button className="outline" onClick={() => setConfirmStop(false)}>
              Keep running
            </button>
            <button
              className="primary danger"
              disabled={busy}
              onClick={async () => {
                await act(
                  () => api("/admin/stop-all"),
                  (r) => `Stopped ${r.stopped.length} conversation(s).`,
                );
                setConfirmStop(false);
              }}
            >
              <Square size={13} fill="currentColor" /> Stop all agents
            </button>
          </div>
        </Dialog>
      )}
      {password && (
        <PasswordDialog
          api={api}
          onClose={() => setPassword(false)}
          onDone={() => {
            setPassword(false);
            setNotice(
              "Password changed. Other owner sessions were signed out, and the generated password file was removed.",
            );
            load();
          }}
        />
      )}
    </section>
  );
}

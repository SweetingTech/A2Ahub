import React, { useEffect, useState } from "react";
import { Check, Copy, Plus, Trash2 } from "lucide-react";

export function ApiPanel({ api }) {
  const [tokens, setTokens] = useState(null);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState(["read", "chat"]);
  const [created, setCreated] = useState(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = () =>
    api("/manager-tokens", null, "GET")
      .then(setTokens)
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  const origin = location.origin;
  return (
    <div className="api-layout">
      <div className="settings-card">
        <h2>Run without the web interface</h2>
        <p>
          Headless mode serves the same owner API, limits and Stop behavior on
          loopback, with no web pages. Manage it with the <code>a2ahub</code>{" "}
          command or your own scripts.
        </p>
        <pre className="code-block">npm run start:headless</pre>
        <p className="hint">
          Or set <code>A2AHUB_HEADLESS=1</code>. To manage from another
          computer, tunnel the loopback port:{" "}
          <code>ssh -L 4317:127.0.0.1:4317 this-pc</code>
        </p>
      </div>
      <div className="settings-card">
        <div className="card-heading">
          <h2>Manager tokens</h2>
        </div>
        <p>
          For your own CLI and scripts. A token is shown once, stored hashed,
          and can never act as an agent credential. Only the signed-in owner can
          create them.
        </p>
        {created && (
          <div className="token-reveal" role="status">
            <strong>
              Copy “{created.name}” now — it won’t be shown again.
            </strong>
            <div className="token-box">
              <code>{created.token}</code>
              <button
                className="outline small"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(created.token);
                    setCopied(true);
                  } catch {
                    setCopied(false);
                  }
                }}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="hint">
              Use it with <code>A2AHUB_MANAGER_TOKEN</code>, or run{" "}
              <code>a2ahub login</code> to let the CLI create its own.
            </p>
            <button className="text-button" onClick={() => setCreated(null)}>
              I’ve saved it
            </button>
          </div>
        )}
        <form
          className="token-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            setCopied(false);
            try {
              setCreated(
                await api("/manager-tokens", { name: name.trim(), scopes }),
              );
              setName("");
              await load();
            } catch (err) {
              setError(err.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label htmlFor="token-name">Token name</label>
          <input
            id="token-name"
            placeholder="laptop-cli"
            maxLength={60}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <fieldset className="scope-picker">
            <legend>Scopes</legend>
            {[
              ["read", "Read — conversations, agents, status"],
              ["chat", "Chat — send, Continue, Stop, organize"],
              ["admin", "Admin — approvals, agents, backups"],
            ].map(([id, label]) => (
              <label key={id} className="check-label">
                <input
                  type="checkbox"
                  checked={scopes.includes(id)}
                  onChange={(e) =>
                    setScopes((old) =>
                      e.target.checked
                        ? [...old, id]
                        : old.filter((s) => s !== id),
                    )
                  }
                />
                {label}
              </label>
            ))}
          </fieldset>
          <button
            className="primary"
            disabled={busy || !name.trim() || !scopes.length}
          >
            <Plus size={15} /> Create token
          </button>
        </form>
        {error && (
          <p className="banner" role="alert">
            {error}
          </p>
        )}
        <ul className="token-list">
          {tokens?.map((t) => (
            <li key={t.id}>
              <div>
                <strong>{t.name}</strong>
                <small className="mono">
                  a2m_…{t.hint} ·{" "}
                  {t.lastUsedAt
                    ? `used ${new Date(t.lastUsedAt).toLocaleString()}`
                    : "never used"}
                </small>
              </div>
              <span className="scope-tags">
                {t.scopes.map((s) => (
                  <span
                    key={s}
                    className={`tag ${s === "admin" ? "tag-accent" : ""}`}
                  >
                    {s}
                  </span>
                ))}
              </span>
              <button
                className="outline small"
                aria-label={`Revoke ${t.name}`}
                onClick={() =>
                  api(`/manager-tokens/${t.id}`, null, "DELETE")
                    .then(load)
                    .catch((e) => setError(e.message))
                }
              >
                <Trash2 size={14} /> Revoke
              </button>
            </li>
          ))}
          {tokens && !tokens.length && (
            <li className="muted">No manager tokens yet.</li>
          )}
        </ul>
      </div>
      <div className="settings-card">
        <h2>API · /api/v1</h2>
        <dl className="endpoint-list">
          <dt className="get">GET</dt>
          <dd>
            /state · /rooms · /rooms/:id · /agents · /events (live stream)
          </dd>
          <dt className="post">POST</dt>
          <dd>/rooms/:id/messages · /continue · /stop · /resume</dd>
          <dt className="post">POST</dt>
          <dd>/rooms/:id/archive · /unarchive · /folders</dd>
          <dt className="get">GET</dt>
          <dd>/admin · /admin/audit · /access (admin scope)</dd>
          <dt className="post">POST</dt>
          <dd>/access/:id/decision with userCode (admin scope)</dd>
        </dl>
        <pre className="code-block">{`curl -H "Authorization: Bearer $A2AHUB_MANAGER_TOKEN" \\
  ${origin}/api/v1/rooms`}</pre>
        <pre className="code-block">{`a2ahub login
a2ahub status
a2ahub say "Home lab" "Summarize the plan" --watch`}</pre>
      </div>
    </div>
  );
}

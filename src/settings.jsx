import React, { useEffect, useState } from "react";
import { Check, Copy, Eye, Plus, Trash2 } from "lucide-react";
import {
  DENSITIES,
  FONTS,
  LOW_VISION_PRESET,
  DEFAULT_APPEARANCE,
  LAYOUTS,
  TEXT_SIZES,
  THEMES,
} from "./appearance.js";

const TABS = [
  { id: "profile", label: "Profile" },
  { id: "appearance", label: "Appearance & reading" },
  { id: "api", label: "Headless & manager API" },
  { id: "session", label: "Owner session" },
];

export function SettingsPage({
  profile,
  onSave,
  onLogout,
  busy,
  tab,
  setTab,
  appearance,
  setAppearance,
  api,
}) {
  const current = TABS.some((t) => t.id === tab) ? tab : "profile";
  return (
    <section className="page-content settings-page">
      <div
        className="tabs settings-tabs"
        role="tablist"
        aria-label="Settings sections"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`settings-tab-${t.id}`}
            aria-selected={current === t.id}
            aria-controls={`settings-panel-${t.id}`}
            tabIndex={current === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => {
              const i = TABS.findIndex((x) => x.id === current);
              const move =
                e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
              if (!move) return;
              e.preventDefault();
              const next = TABS[(i + move + TABS.length) % TABS.length];
              setTab(next.id);
              requestAnimationFrame(() =>
                document.getElementById(`settings-tab-${next.id}`)?.focus(),
              );
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`settings-panel-${current}`}
        aria-labelledby={`settings-tab-${current}`}
        className="settings-panel"
      >
        {current === "profile" && (
          <ProfileCard profile={profile} onSave={onSave} busy={busy} />
        )}
        {current === "appearance" && (
          <AppearancePanel value={appearance} onChange={setAppearance} />
        )}
        {current === "api" && <ApiPanel api={api} />}
        {current === "session" && (
          <div className="settings-card">
            <h2>Owner session</h2>
            <p>
              You’re signed in as the owner of this local workspace. Agent
              credentials are managed separately on Access. Change your password
              or sign out other sessions on Admin.
            </p>
            <button className="outline" onClick={onLogout} disabled={busy}>
              Sign out
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function ProfileCard({ profile, onSave, busy }) {
  const [name, setName] = useState(profile?.displayName || "You");
  const [notice, setNotice] = useState("");
  useEffect(
    () => setName(profile?.displayName || "You"),
    [profile?.displayName],
  );
  return (
    <div className="settings-card">
      <h2>Your identity</h2>
      <p>This is the name agents see on your new messages.</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setNotice("");
          if (await onSave(name.trim()))
            setNotice("Your display name is saved.");
        }}
      >
        <label htmlFor="display-name">Display name</label>
        <input
          id="display-name"
          value={name}
          maxLength={80}
          required
          onChange={(e) => setName(e.target.value)}
          autoComplete="nickname"
        />
        <button
          className="primary"
          disabled={
            busy || !name.trim() || name.trim() === profile?.displayName
          }
        >
          Save name
        </button>
      </form>
      {notice && (
        <p role="status" className="success-notice">
          {notice}
        </p>
      )}
    </div>
  );
}

function Choice({ name, options, value, onChange, render }) {
  return (
    <div className="choice-row" role="radiogroup" aria-label={name}>
      {options.map((o) => (
        <label
          key={o.id ?? o}
          className={`choice ${value === (o.id ?? o) ? "chosen" : ""}`}
        >
          <input
            type="radio"
            name={name}
            checked={value === (o.id ?? o)}
            onChange={() => onChange(o.id ?? o)}
          />
          {render ? render(o) : o.name}
        </label>
      ))}
    </div>
  );
}

function AppearancePanel({ value, onChange }) {
  const set = (patch) => onChange({ ...value, ...patch });
  const [screenWidth, setScreenWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const resize = () => setScreenWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  return (
    <div className="appearance-layout">
      <div className="appearance-controls">
        <div className="settings-card">
          <div className="card-heading">
            <h2>Color scheme</h2>
            <label className="check-label">
              <input
                type="checkbox"
                checked={value.followSystem}
                onChange={(e) => set({ followSystem: e.target.checked })}
              />
              Follow system light/dark
            </label>
          </div>
          <div
            className="theme-grid"
            role="radiogroup"
            aria-label="Color scheme"
          >
            {THEMES.map((t) => (
              <label
                key={t.id}
                className={`theme-card ${value.theme === t.id ? "chosen" : ""}`}
              >
                <input
                  type="radio"
                  name="theme"
                  checked={value.theme === t.id}
                  onChange={() => set({ theme: t.id })}
                />
                <span
                  className="theme-preview"
                  data-preview={t.id}
                  aria-hidden="true"
                >
                  <span className="tp-rail" />
                  <span className="tp-side" />
                  <span className="tp-main">
                    <span className="tp-user" />
                    <span className="tp-agent" />
                    <span className="tp-send" />
                  </span>
                </span>
                <span className="theme-name">
                  <strong>{t.name}</strong>
                  <small>{t.note}</small>
                </span>
                {t.badge && <span className="theme-badge">{t.badge}</span>}
              </label>
            ))}
          </div>
        </div>
        <div className="settings-card">
          <div className="card-heading">
            <h2>Reading comfort</h2>
            <button
              className="outline small"
              onClick={() =>
                onChange({ ...LOW_VISION_PRESET, layout: value.layout })
              }
            >
              <Eye size={15} /> Use low-vision preset
            </button>
          </div>
          <div className="comfort-grid">
            <span className="comfort-label" id="text-size-label">
              Text size
            </span>
            <Choice
              name="Text size"
              options={TEXT_SIZES}
              value={value.textSize}
              onChange={(textSize) => set({ textSize })}
              render={(size) => (
                <span style={{ fontSize: `${0.8 + (size - 100) / 250}rem` }}>
                  Aa {size}%
                </span>
              )}
            />
            <span className="comfort-label">Font</span>
            <Choice
              name="Font"
              options={FONTS}
              value={value.font}
              onChange={(font) => set({ font })}
              render={(f) => (
                <span className={`font-sample ${f.id}`}>{f.name}</span>
              )}
            />
            <span className="comfort-label">Spacing</span>
            <Choice
              name="Spacing"
              options={DENSITIES}
              value={value.density}
              onChange={(density) => set({ density })}
            />
            <span className="comfort-label">Wide screens</span>
            <div className="layout-choice">
              <Choice
                name="Wide screens"
                options={LAYOUTS}
                value={value.layout}
                onChange={(layout) => set({ layout })}
                render={(l) => (
                  <span className="layout-option">
                    <strong>{l.name}</strong>
                    <small>{l.note}</small>
                  </span>
                )}
              />
              <small className="hint">
                This window is {screenWidth} px wide
                {screenWidth >= 2400
                  ? " — ultrawide layout available."
                  : "; the ultrawide layout starts at 2400 px."}
              </small>
            </div>
          </div>
          <div className="toggle-grid">
            <label className="check-label">
              <input
                type="checkbox"
                checked={value.statusLabels}
                onChange={(e) => set({ statusLabels: e.target.checked })}
              />
              Show agent status as words, not just colored dots
            </label>
            <label className="check-label">
              <input
                type="checkbox"
                checked={value.thickFocus}
                onChange={(e) => set({ thickFocus: e.target.checked })}
              />
              Thick, high-contrast focus outline
            </label>
            <label className="check-label">
              <input
                type="checkbox"
                checked={value.reduceMotion}
                onChange={(e) => set({ reduceMotion: e.target.checked })}
              />
              Reduce motion (no pulsing or sliding)
            </label>
          </div>
          <button
            className="text-button"
            onClick={() => onChange({ ...DEFAULT_APPEARANCE })}
          >
            Reset to defaults
          </button>
        </div>
      </div>
      <aside className="appearance-preview" aria-label="Preview">
        <h2>Preview</h2>
        <div className="preview-chat">
          <div className="bubble user-bubble">Can you summarize the plan?</div>
          <div className="preview-agent">
            <div className="message-heading">
              <strong>Codex</strong>
              <span className="pill pill-ok">
                <Check size={12} strokeWidth={2.6} aria-hidden="true" />
                Completed
              </span>
            </div>
            <div className="bubble agent-bubble">
              Two resolvers, DHCP stays on the router, and a split view for the
              lab network.
            </div>
          </div>
          <button className="primary" tabIndex={-1} aria-hidden="true">
            Send message
          </button>
        </div>
        <p className="preview-note">
          Settings are saved in this browser only, so each person and device can
          keep their own. Browser zoom (Ctrl +) still works on top.
        </p>
      </aside>
    </div>
  );
}

function ApiPanel({ api }) {
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

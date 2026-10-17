import React from "react";
import { ProfileCard } from "./components/ProfileCard.jsx";
import { AppearancePanel } from "./components/AppearancePanel.jsx";
import { ApiPanel } from "./components/ApiPanel.jsx";

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

import React, { useEffect, useState } from "react";
import { Check, Eye } from "lucide-react";
import {
  DENSITIES,
  FONTS,
  LOW_VISION_PRESET,
  DEFAULT_APPEARANCE,
  LAYOUTS,
  TEXT_SIZES,
  THEMES,
} from "../appearance.js";

export function Choice({ name, options, value, onChange, render }) {
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

export function AppearancePanel({ value, onChange }) {
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

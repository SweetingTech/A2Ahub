import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  Circle,
  Clock,
  Loader,
  Pause,
  X,
} from "lucide-react";

export const FOLDER_COLORS = [
  "teal",
  "purple",
  "orange",
  "blue",
  "green",
  "pink",
  "gray",
];

export function initials(name = "?") {
  const words = name
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean);
  const letters =
    words.length > 1
      ? words[0][0] + words[1][0]
      : name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2);
  return (letters || "?").toUpperCase();
}
// Stable per-name color slot, so each agent keeps its color everywhere.
export function tone(name = "") {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (h % 6) + 1;
}

export function Avatar({ name, size = "md", user = false }) {
  return (
    <span
      className={`avatar avatar-${size} ${user ? "avatar-user" : `tone-${tone(name)}`}`}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

const stateInfo = {
  completed: { label: "Completed", icon: Check, kind: "ok" },
  working: { label: "Working", icon: Loader, kind: "info" },
  submitted: { label: "Submitted", icon: Clock, kind: "info" },
  failed: { label: "Failed", icon: AlertCircle, kind: "danger" },
  error: { label: "Error", icon: AlertCircle, kind: "danger" },
  canceled: { label: "Canceled", icon: X, kind: "muted" },
  cancelled: { label: "Canceled", icon: X, kind: "muted" },
  interrupted: { label: "Interrupted", icon: Pause, kind: "warn" },
  "input-required": { label: "Needs input", icon: AlertCircle, kind: "warn" },
  rejected: { label: "Rejected", icon: X, kind: "danger" },
  "timed-out": { label: "Timed out", icon: Clock, kind: "warn" },
  stopped: { label: "Stopped", icon: Pause, kind: "muted" },
  sent: { label: "Sent", icon: Check, kind: "muted" },
  continued: { label: "Continued", icon: Check, kind: "muted" },
};
// Status is always an icon plus a word, never color alone.
export function StatePill({ state, children }) {
  const info = stateInfo[state] || {
    label: state || "Unknown",
    icon: Circle,
    kind: "muted",
  };
  const Icon = info.icon;
  return (
    <span className={`pill pill-${info.kind}`}>
      <Icon size={12} strokeWidth={2.6} aria-hidden="true" />
      {info.label}
      {children}
    </span>
  );
}

export function BurstMeter({ used = 0, total = 6, active = false, compact }) {
  const cells = Array.from({ length: Math.max(1, total) }, (_, i) =>
    i < used - (active ? 1 : 0) ? "used" : i < used ? "live" : "free",
  );
  return (
    <div
      className={`burst-meter ${compact ? "compact" : ""}`}
      role="meter"
      aria-label="Hub requests used in this discussion"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={used}
      aria-valuetext={`${used} of ${total} requests`}
    >
      {!compact && (
        <div className="burst-label">
          <span>Burst</span>
          <strong>
            {used} / {total} requests
          </strong>
        </div>
      )}
      <div className="burst-cells" aria-hidden="true">
        {cells.map((c, i) => (
          <span key={i} className={c} />
        ))}
      </div>
    </div>
  );
}

// Small accessible popover menu: Escape or an outside click closes it and
// focus returns to the trigger.
export function Menu({ label, onClose, children, anchor, className = "" }) {
  const menu = useRef(null);
  const [place, setPlace] = useState(null);
  // Fixed to the viewport so scrolling lists never clip it.
  useLayoutEffect(() => {
    const trigger = anchor?.current?.getBoundingClientRect();
    const box = menu.current?.getBoundingClientRect();
    if (!trigger || !box) return;
    const gap = 4;
    const below = trigger.bottom + gap + box.height <= innerHeight - 8;
    setPlace({
      top: below
        ? trigger.bottom + gap
        : Math.max(8, trigger.top - gap - box.height),
      left: Math.min(
        Math.max(8, trigger.right - box.width),
        innerWidth - box.width - 8,
      ),
    });
  }, []);
  useEffect(() => {
    const items = () => [
      ...(menu.current?.querySelectorAll('[role="menuitem"]:not(:disabled)') ||
        []),
    ];
    function key(event) {
      const list = items();
      const i = list.indexOf(document.activeElement);
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        anchor?.current?.focus();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        list[(i + 1) % list.length]?.focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        list[(i - 1 + list.length) % list.length]?.focus();
      } else if (event.key === "Tab") onClose();
    }
    function outside(event) {
      if (
        !menu.current?.contains(event.target) &&
        !anchor?.current?.contains(event.target)
      )
        onClose();
    }
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", outside);
    };
  }, []);
  useEffect(() => {
    if (place)
      menu.current?.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
  }, [place]);
  return (
    <div
      ref={menu}
      role="menu"
      aria-label={label}
      className={`menu ${className}`}
      style={
        place
          ? {
              position: "fixed",
              top: place.top,
              left: place.left,
              right: "auto",
            }
          : { position: "fixed", visibility: "hidden" }
      }
    >
      {children}
    </div>
  );
}

export function MenuItem({ onSelect, danger, children, disabled }) {
  return (
    <button
      type="button"
      role="menuitem"
      className={danger ? "danger" : ""}
      disabled={disabled}
      onClick={onSelect}
    >
      {children}
    </button>
  );
}

export function when(value) {
  if (!value) return "";
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString())
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (now - date < 6 * 86400000)
    return date.toLocaleDateString([], { weekday: "short" });
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

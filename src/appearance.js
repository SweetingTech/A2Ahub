// Per-browser appearance and reading-comfort settings. Stored locally so each
// person (and device) keeps their own theme without changing anyone else's.
export const THEMES = [
  { id: "ember", name: "Ember", note: "Default light", dark: false },
  { id: "midnight", name: "Midnight", note: "Dark", dark: true },
  { id: "graphite", name: "Graphite", note: "Cool blue", dark: false },
  { id: "evergreen", name: "Evergreen", note: "Soft green", dark: false },
  {
    id: "hivis",
    name: "High visibility",
    note: "Low vision",
    dark: false,
    badge: "Low vision",
  },
  { id: "hcdark", name: "High contrast dark", note: "Low vision", dark: true },
];
export const TEXT_SIZES = [100, 115, 130, 150, 175];
export const FONTS = [
  { id: "standard", name: "Standard" },
  { id: "hyperlegible", name: "Hyperlegible" },
  { id: "system", name: "System" },
];
export const DENSITIES = [
  { id: "compact", name: "Compact" },
  { id: "comfortable", name: "Comfortable" },
  { id: "roomy", name: "Roomy" },
];
export const DEFAULT_APPEARANCE = {
  theme: "ember",
  followSystem: false,
  textSize: 100,
  font: "standard",
  density: "comfortable",
  statusLabels: true,
  thickFocus: false,
  reduceMotion: false,
};
// One-click starting point for low vision; every value stays adjustable.
export const LOW_VISION_PRESET = {
  theme: "hivis",
  followSystem: false,
  textSize: 130,
  font: "hyperlegible",
  density: "roomy",
  statusLabels: true,
  thickFocus: true,
  reduceMotion: true,
};
const KEY = "a2ahub-appearance";

export function loadAppearance() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    return sanitize({ ...DEFAULT_APPEARANCE, ...(saved || {}) });
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}
function sanitize(a) {
  return {
    theme: THEMES.some((t) => t.id === a.theme) ? a.theme : "ember",
    followSystem: a.followSystem === true,
    textSize: TEXT_SIZES.includes(a.textSize) ? a.textSize : 100,
    font: FONTS.some((f) => f.id === a.font) ? a.font : "standard",
    density: DENSITIES.some((d) => d.id === a.density)
      ? a.density
      : "comfortable",
    statusLabels: a.statusLabels !== false,
    thickFocus: a.thickFocus === true,
    reduceMotion: a.reduceMotion === true,
  };
}
export function saveAppearance(a) {
  try {
    localStorage.setItem(KEY, JSON.stringify(sanitize(a)));
  } catch {
    /* Storage can be unavailable in private browsing. */
  }
}
// With "follow system", light themes pair with Midnight and the high-visibility
// theme pairs with high contrast dark; the chosen theme is used otherwise.
export function resolveTheme(a, prefersDark) {
  if (!a.followSystem) return a.theme;
  const lowVision = ["hivis", "hcdark"].includes(a.theme);
  if (prefersDark) return lowVision ? "hcdark" : "midnight";
  if (a.theme === "midnight") return "ember";
  if (a.theme === "hcdark") return "hivis";
  return a.theme;
}
export function applyAppearance(a, root = document.documentElement) {
  const prefersDark =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = resolveTheme(a, prefersDark);
  root.dataset.theme = theme;
  root.dataset.font = a.font;
  root.dataset.density = a.density;
  root.dataset.focus =
    a.thickFocus || ["hivis", "hcdark"].includes(theme) ? "thick" : "normal";
  root.dataset.motion = a.reduceMotion ? "reduce" : "normal";
  root.dataset.statusLabels = a.statusLabels ? "on" : "off";
  root.style.setProperty("--text-scale", String(a.textSize / 100));
  root.style.colorScheme = THEMES.find((t) => t.id === theme)?.dark
    ? "dark"
    : "light";
}

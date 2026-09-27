import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAppearance,
  DEFAULT_APPEARANCE,
  LOW_VISION_PRESET,
  loadAppearance,
  resolveTheme,
} from "../src/appearance.js";

test("follow-system pairs themes with an accessible counterpart", () => {
  const follow = (theme) => ({
    ...DEFAULT_APPEARANCE,
    theme,
    followSystem: true,
  });
  assert.equal(resolveTheme(follow("ember"), true), "midnight");
  assert.equal(resolveTheme(follow("graphite"), false), "graphite");
  assert.equal(resolveTheme(follow("midnight"), false), "ember");
  // Low-vision choices never fall back to a low-contrast theme.
  assert.equal(resolveTheme(follow("hivis"), true), "hcdark");
  assert.equal(resolveTheme(follow("hcdark"), false), "hivis");
  assert.equal(
    resolveTheme({ ...DEFAULT_APPEARANCE, theme: "evergreen" }, true),
    "evergreen",
  );
});

test("applying appearance sets theme, scale and forced thick focus for low vision", () => {
  const root = {
    dataset: {},
    style: {
      setProperty(k, v) {
        this[k] = v;
      },
    },
  };
  globalThis.matchMedia = () => ({ matches: false });
  applyAppearance(LOW_VISION_PRESET, root);
  assert.equal(root.dataset.theme, "hivis");
  assert.equal(root.dataset.font, "hyperlegible");
  assert.equal(root.dataset.focus, "thick");
  assert.equal(root.dataset.motion, "reduce");
  assert.equal(root.style["--text-scale"], "1.3");
  applyAppearance({ ...DEFAULT_APPEARANCE, theme: "hcdark" }, root);
  assert.equal(
    root.dataset.focus,
    "thick",
    "high contrast always gets a thick focus ring",
  );
  assert.equal(root.style.colorScheme, "dark");
});

test("wide-screen layout is applied and invalid values fall back to full width", () => {
  const root = {
    dataset: {},
    style: {
      setProperty(k, v) {
        this[k] = v;
      },
    },
  };
  globalThis.matchMedia = () => ({ matches: false });
  applyAppearance({ ...DEFAULT_APPEARANCE, layout: "2560" }, root);
  assert.equal(root.dataset.layout, "2560");
  assert.equal(DEFAULT_APPEARANCE.layout, "full");
  const stored = new Map([
    ["a2ahub-appearance", JSON.stringify({ layout: "8k-wall" })],
  ]);
  globalThis.localStorage = { getItem: (k) => stored.get(k) ?? null };
  assert.equal(loadAppearance().layout, "full");
  stored.set("a2ahub-appearance", JSON.stringify({ layout: "1920" }));
  assert.equal(loadAppearance().layout, "1920");
});

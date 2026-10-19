import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { countLines, HARD_CEILING, scan } from "../scripts/check-structure.mjs";

const lines = (n, newline = true) =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") +
  (newline ? "\n" : "");

function fixture(files) {
  fs.mkdirSync("work", { recursive: true });
  const root = fs.mkdtempSync(path.resolve("work/structure-"));
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return root;
}

const names = (entries) => entries.map((e) => e.file).sort();

test("physical line counting treats a trailing newline as a terminator", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("a"), 1);
  assert.equal(countLines("a\n"), 1);
  assert.equal(countLines("a\n\n"), 2);
  assert.equal(countLines("a\r\nb\r\n"), 2);
  assert.equal(countLines(lines(500)), 500);
  assert.equal(countLines(lines(500, false)), 500);
  assert.equal(
    countLines("// comment\n\n\n"),
    3,
    "comments and blank lines count",
  );
});

test("501-line source, stylesheet and Markdown files fail; 500 lines passes", () => {
  const root = fixture({
    "src/over.js": lines(501),
    "src/over.css": lines(501, false),
    "docs/over.md": lines(501),
    "docs/over.mdx": lines(501),
    "src/edge.js": lines(HARD_CEILING),
    "src/edge.css": lines(HARD_CEILING, false),
    "docs/edge.md": lines(HARD_CEILING),
  });
  try {
    const result = scan(root);
    assert.deepEqual(names(result.violations), [
      "docs/over.md",
      "docs/over.mdx",
      "src/over.css",
      "src/over.js",
    ]);
    assert.ok(result.violations.every((v) => v.lines === 501));
    assert.deepEqual(names(result.warnings), [
      "docs/edge.md",
      "src/edge.css",
      "src/edge.js",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("nested handwritten files are checked; only documented generated paths are excluded", () => {
  const root = fixture({
    "src/deep/a/b/nested.jsx": lines(501),
    "test/fixtures/deep/fixture.mjs": lines(501),
    "docs/guides/nested/guide.md": lines(501),
    "node_modules/pkg/index.js": lines(900),
    "dist/assets/app.css": lines(900),
    "data/workspace.json": lines(900),
    "work/scratch.js": lines(900),
    "package-lock.json": lines(900),
    "design/image.png": lines(900),
  });
  try {
    const result = scan(root);
    assert.deepEqual(names(result.violations), [
      "docs/guides/nested/guide.md",
      "src/deep/a/b/nested.jsx",
      "test/fixtures/deep/fixture.mjs",
    ]);
    assert.ok(
      !result.checked.some((e) =>
        /node_modules|dist|data|work|lock|png/.test(e.file),
      ),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an excluded directory name nested in source is still checked", () => {
  const root = fixture({
    "src/data/table.js": lines(501),
    "src/dist/notes.md": lines(501),
  });
  try {
    assert.deepEqual(names(scan(root).violations), [
      "src/data/table.js",
      "src/dist/notes.md",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI exits non-zero and names the file and line count", () => {
  const root = fixture({ "src/style.css": lines(501) });
  try {
    const run = spawnSync(
      process.execPath,
      [path.resolve("scripts/check-structure.mjs")],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    assert.equal(run.status, 1);
    assert.match(run.stderr, /src\/style\.css: 501 lines/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

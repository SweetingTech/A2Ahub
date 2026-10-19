#!/usr/bin/env node
// check-structure: enforce file-size limits on handwritten files.
// Target 300 physical lines, hard ceiling 500. Comments and blank lines count;
// a final trailing newline terminates the last line rather than adding one.
import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const TARGET = 300;
export const HARD_CEILING = 500;

// Every handwritten text format present in (or plausible for) this project.
export const CHECKED_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".css",
  ".scss",
  ".md",
  ".mdx",
  ".html",
  ".json",
  ".yml",
  ".yaml",
  ".toml",
  ".ps1",
  ".sh",
]);

// Generated, vendored, or runtime artifacts only. Each entry is documented.
export const EXCLUDED_DIRECTORIES = new Map([
  ["node_modules", "installed dependencies"],
  ["dist", "Vite build output"],
  [".git", "version-control metadata"],
  ["work", "disposable test and runtime scratch data"],
  ["data", "local runtime workspace data and credentials"],
  [".bolt", "Bolt platform configuration"],
  [".v3", "Bolt platform scratch directory"],
]);
export const EXCLUDED_FILES = new Map([
  ["package-lock.json", "npm-generated lockfile"],
]);

export function countLines(text) {
  if (text === "") return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

function walk(dir, root, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const top = relative(root, full).split(sep)[0];
      if (EXCLUDED_DIRECTORIES.has(entry.name) && top === entry.name) continue;
      if (entry.name === "node_modules") continue;
      walk(full, root, files);
    } else if (entry.isFile()) files.push(full);
  }
  return files;
}

export function scan(root) {
  const checked = [];
  const warnings = [];
  const violations = [];
  for (const file of walk(root, root, [])) {
    if (!CHECKED_EXTENSIONS.has(extname(file).toLowerCase())) continue;
    if (EXCLUDED_FILES.has(basename(file))) continue;
    const lines = countLines(readFileSync(file, "utf8"));
    const entry = { file: relative(root, file).split(sep).join("/"), lines };
    checked.push(entry);
    if (lines > HARD_CEILING) violations.push(entry);
    else if (lines > TARGET) warnings.push(entry);
  }
  const byLines = (a, b) => b.lines - a.lines || a.file.localeCompare(b.file);
  return {
    checked: checked.sort(byLines),
    warnings: warnings.sort(byLines),
    violations: violations.sort(byLines),
  };
}

function main() {
  const { checked, warnings, violations } = scan(process.cwd());
  if (warnings.length) {
    console.warn(`Files above the ${TARGET}-line target (should be split):`);
    for (const w of warnings) console.warn(`  ${w.file}: ${w.lines} lines`);
    console.warn("");
  }
  if (violations.length) {
    console.error(
      `Files above the ${HARD_CEILING}-line hard ceiling (must be split):`,
    );
    for (const v of violations) console.error(`  ${v.file}: ${v.lines} lines`);
    console.error(`${violations.length} file(s) above hard ceiling.`);
    process.exit(1);
  }
  console.log(
    `Structure check passed: ${checked.length} files checked, ${warnings.length} above target, 0 above ceiling.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();

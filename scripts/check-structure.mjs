#!/usr/bin/env node
// check-structure — enforce file-size limits across the project.
// Target: 300 lines. Hard ceiling: 500 lines. Fails the build on violation.
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";

const TARGET = 300;
const HARD_CEILING = 500;
const ROOT = process.cwd();

const EXCLUDE = new Set([
  "node_modules",
  "dist",
  ".git",
  "work",
  "data",
]);

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    if (EXCLUDE.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) files.push(...walk(full));
    else if (stat.isFile()) files.push(full);
  }
  return files;
}

function countLines(file) {
  return readFileSync(file, "utf8").split("\n").length;
}

const violations = [];
const warnings = [];

for (const file of walk(ROOT)) {
  const ext = extname(file);
  if (![".js", ".mjs", ".jsx", ".ts", ".mts", ".tsx"].includes(ext)) continue;
  const lines = countLines(file);
  const rel = file.slice(ROOT.length + 1);
  if (lines > HARD_CEILING)
    violations.push({ file: rel, lines, limit: HARD_CEILING, level: "CEILING" });
  else if (lines > TARGET)
    warnings.push({ file: rel, lines, limit: TARGET, level: "target" });
}

if (warnings.length) {
  console.warn("Files exceeding 300-line target (should be split):");
  for (const w of warnings.sort((a, b) => b.lines - a.lines))
    console.warn(`  ${w.file}: ${w.lines} lines (target ${w.limit})`);
  console.warn(`${warnings.length} file(s) above target.\n`);
}

if (violations.length) {
  console.error("Files exceeding 500-line hard ceiling (must be split):");
  for (const v of violations.sort((a, b) => b.lines - a.lines))
    console.error(`  ${v.file}: ${v.lines} lines (ceiling ${v.limit})`);
  console.error(`${violations.length} file(s) above hard ceiling.`);
  process.exit(1);
}

console.log(
  `Structure check passed: ${warnings.length} above target, 0 above ceiling.`,
);

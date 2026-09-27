import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const LIMIT = 500;

// Owner-visible record of administrative actions. Entries carry names and
// titles only: never message text, credentials, passwords or token values.
export class Audit {
  constructor(dataDir, { now = () => Date.now() } = {}) {
    this.now = now;
    this.file = path.join(dataDir, "audit.json");
    try {
      const entries = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.entries = Array.isArray(entries) ? entries.slice(-LIMIT) : [];
    } catch {
      this.entries = [];
    }
  }
  record(action, { actor = "owner", ...detail } = {}) {
    const entry = {
      id: randomUUID(),
      at: new Date(this.now()).toISOString(),
      actor,
      action,
      ...detail,
    };
    this.entries.push(entry);
    if (this.entries.length > LIMIT)
      this.entries.splice(0, this.entries.length - LIMIT);
    fs.writeFileSync(this.file + ".tmp", JSON.stringify(this.entries, null, 2));
    fs.renameSync(this.file + ".tmp", this.file);
    return entry;
  }
  list(limit = 100) {
    const n = Math.max(1, Math.min(LIMIT, Number(limit) || 100));
    return this.entries.slice(-n).reverse();
  }
}

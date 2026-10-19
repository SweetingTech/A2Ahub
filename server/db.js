import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// DB init, save, load/seed. Exports the shape index.js and route modules rely on.
const FOLDER_COLORS = [
  "teal",
  "purple",
  "orange",
  "blue",
  "green",
  "pink",
  "gray",
];

export function createRoom() {
  return {
    id: randomUUID(),
    title: "Shared workspace",
    messages: [],
    contexts: {},
    agentIds: [],
    memberSince: {},
    agentChat: true,
    replyLimit: 6,
    paused: false,
    folderId: null,
    pinned: false,
    archived: false,
    createdAt: new Date().toISOString(),
  };
}

export function loadDB(file) {
  let db;
  if (fs.existsSync(file)) {
    db = JSON.parse(fs.readFileSync(file, "utf8"));
  } else {
    db = {
      agents: [
        {
          id: randomUUID(),
          url: "http://127.0.0.1:9900/",
          name: "LilDSweetz",
          status: "unchecked",
        },
      ],
      rooms: [createRoom()],
    };
  }
  for (const a of db.agents) a.status = "unchecked";
  db.profile ??= { displayName: process.env.USERNAME || "You" };
  // Folders and archive state are additive; existing rooms start unfiled and active.
  db.folders = Array.isArray(db.folders) ? db.folders : [];
  migrateRooms(db);
  for (const r of db.rooms)
    for (const m of r.messages)
      if (["working", "submitted"].includes(m.state)) {
        m.state = "interrupted";
        m.text += "\n[Server restarted. Remote task may still be running.]";
      }
  return db;
}

// Normalize existing rooms so they gain explicit membership, contexts, and
// membership-timestamp fields without exposing old transcripts.
export function migrateRooms(db) {
  for (const r of db.rooms) {
    if (!db.folders.some((f) => f.id === r.folderId)) r.folderId = null;
    r.pinned = r.pinned === true;
    r.archived = r.archived === true;
    r.agentIds ??= [];
    r.agentChat ??= false;
    r.replyLimit ??= 6;
    r.paused ??= false;
    r.contexts ??= {};
    r.memberSince ??= {};
  }
}

// Write-to-temp, fsync, rename, then fsync the directory so a crash leaves
// either the previous or the new file, never a truncated one.
export function writeDurable(target, data) {
  const tmp = `${target}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
  try {
    const dir = fs.openSync(path.dirname(target), "r");
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

export function saveDB(file, db) {
  writeDurable(file, JSON.stringify(db, null, 2));
}

export { FOLDER_COLORS };

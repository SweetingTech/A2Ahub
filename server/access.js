import fs from "node:fs";
import path from "node:path";
import {
  randomBytes,
  randomUUID,
  createHash,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { spawnSync } from "node:child_process";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const fail = (status, message) => Object.assign(new Error(message), { status });
export const MANAGER_SCOPES = ["read", "chat", "admin"];

export function privateDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    const result = spawnSync("whoami", ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const sid = result.stdout?.match(/S-1-5-[\d-]+/)?.[0];
    if (!sid)
      throw new Error(
        "Cannot identify Windows user for private credential storage.",
      );
    const acl = spawnSync(
      "icacls",
      [dir, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`],
      { windowsHide: true, stdio: "ignore" },
    );
    if (acl.status !== 0)
      throw new Error("Cannot secure credential directory.");
  } else fs.chmodSync(dir, 0o700);
}

export class Access {
  constructor(dir, { now = () => Date.now() } = {}) {
    this.now = now;
    this.sessions = new Map();
    this.attempts = new Map();
    this.dir = path.join(dir, "owner");
    privateDirectory(this.dir);
    this.file = path.join(this.dir, "access.json");
    this.passwordFile = path.join(this.dir, "admin-password.txt");
    if (fs.existsSync(this.file))
      this.db = JSON.parse(fs.readFileSync(this.file, "utf8"));
    else {
      const password = process.env.A2AHUB_OWNER_PASSWORD || secret();
      const salt = secret();
      this.db = {
        owner: { salt, digest: scryptSync(password, salt, 32).toString("hex") },
        requests: [],
        accounts: [],
      };
      if (!process.env.A2AHUB_OWNER_PASSWORD)
        fs.writeFileSync(this.passwordFile, password + "\n", { mode: 0o600 });
      this.save();
    }
  }
  save() {
    fs.writeFileSync(this.file + ".tmp", JSON.stringify(this.db, null, 2), {
      mode: 0o600,
    });
    fs.renameSync(this.file + ".tmp", this.file);
  }
  limit(key, max, windowMs) {
    const now = this.now();
    for (const [id, entry] of this.attempts)
      if (entry.until <= now) this.attempts.delete(id);
    const entry = this.attempts.get(key) || { count: 0, until: now + windowMs };
    this.attempts.set(key, entry);
    if (++entry.count > max)
      throw fail(429, "Too many attempts. Try again later.");
  }
  login(password, ip) {
    this.limit(`login:${ip}`, 10, 60000);
    if (
      typeof password !== "string" ||
      password.length > 256 ||
      !timingSafeEqual(
        scryptSync(password, this.db.owner.salt, 32),
        Buffer.from(this.db.owner.digest, "hex"),
      )
    )
      throw fail(401, "Incorrect password.");
    const token = secret();
    this.sessions.set(hash(token), this.now() + 12 * 3600000);
    return token;
  }
  owner(req) {
    const cookie = this.sessionCookie(req);
    return !!cookie && (this.sessions.get(hash(cookie)) || 0) > this.now();
  }
  sessionCookie(req) {
    return req.headers.cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("a2ahub_owner="))
      ?.slice(13);
  }
  logout(req) {
    const cookie = this.sessionCookie(req);
    if (cookie) this.sessions.delete(hash(cookie));
  }
  sessionCount() {
    const now = this.now();
    for (const [id, until] of this.sessions)
      if (until <= now) this.sessions.delete(id);
    return this.sessions.size;
  }
  // Keeps the caller's session (if any) and ends every other owner session.
  revokeOtherSessions(req) {
    const keep = this.sessionCookie(req);
    const kept = keep && hash(keep);
    let ended = 0;
    for (const id of [...this.sessions.keys()])
      if (id !== kept) {
        this.sessions.delete(id);
        ended++;
      }
    return ended;
  }
  changePassword(current, next, req) {
    this.limit(`password:${req.socket.remoteAddress}`, 5, 60000);
    if (
      typeof current !== "string" ||
      current.length > 256 ||
      !timingSafeEqual(
        scryptSync(current, this.db.owner.salt, 32),
        Buffer.from(this.db.owner.digest, "hex"),
      )
    )
      throw fail(401, "Current password is incorrect.");
    if (typeof next !== "string" || next.length < 12 || next.length > 256)
      throw fail(400, "New password must be 12–256 characters.");
    const salt = secret();
    this.db.owner = {
      salt,
      digest: scryptSync(next, salt, 32).toString("hex"),
      changedAt: this.now(),
    };
    this.save();
    // The generated first-run password is no longer valid; do not leave it behind.
    fs.rmSync(this.passwordFile, { force: true });
    this.revokeOtherSessions(req);
  }
  // Manager tokens let the owner's own CLI and scripts use the loopback owner
  // API. They are hashed like agent credentials but live in a separate list,
  // so agent A2A authentication can never accept one and vice versa.
  createManagerToken(name, scopes) {
    if (typeof name !== "string" || !name.trim() || name.length > 60)
      throw fail(400, "Token name must be 1–60 characters.");
    if (
      !Array.isArray(scopes) ||
      !scopes.length ||
      scopes.some((s) => !MANAGER_SCOPES.includes(s)) ||
      new Set(scopes).size !== scopes.length
    )
      throw fail(400, "Choose scopes from read, chat and admin.");
    this.db.managerTokens ??= [];
    if (this.db.managerTokens.filter((t) => !t.revoked).length >= 20)
      throw fail(429, "Revoke an unused manager token first.");
    const token = "a2m_" + secret();
    const record = {
      id: randomUUID(),
      name: name.trim(),
      scopes: MANAGER_SCOPES.filter((s) => scopes.includes(s)),
      tokenHash: hash(token),
      hint: token.slice(-4),
      createdAt: this.now(),
      lastUsedAt: null,
      revoked: false,
    };
    this.db.managerTokens.push(record);
    this.save();
    const { tokenHash, ...visible } = record;
    return { ...visible, token };
  }
  listManagerTokens() {
    return (this.db.managerTokens || [])
      .filter((t) => !t.revoked)
      .map(({ tokenHash, ...t }) => t);
  }
  revokeManagerToken(id) {
    const record = (this.db.managerTokens || []).find(
      (t) => t.id === id && !t.revoked,
    );
    if (!record) throw fail(404, "Manager token not found.");
    record.revoked = true;
    this.save();
    return record;
  }
  manager(req, { touch = true } = {}) {
    const token = /^Bearer (a2m_\S+)$/.exec(
      req.headers.authorization || "",
    )?.[1];
    if (!token || token.length > 256) return null;
    const digest = hash(token);
    const record = (this.db.managerTokens || []).find(
      (t) => !t.revoked && t.tokenHash === digest,
    );
    if (record && touch && this.now() - (record.lastUsedAt || 0) > 60000) {
      record.lastUsedAt = this.now();
      this.save();
    }
    return record || null;
  }
  request(name, origin, ip) {
    this.limit(`device:${ip}`, 30, 600000);
    if (typeof name !== "string" || !name.trim() || name.length > 80)
      throw fail(400, "Agent name must be 1–80 characters.");
    this.db.requests = this.db.requests.filter((r) => r.expiresAt > this.now());
    if (this.db.requests.length >= 100)
      throw fail(429, "Too many pending requests.");
    const deviceCode = secret(),
      id = randomUUID();
    const request = {
      id,
      name: name.trim(),
      userCode: randomBytes(4).toString("hex").toUpperCase(),
      deviceHash: hash(deviceCode),
      state: "pending",
      expiresAt: this.now() + 600000,
      lastPoll: 0,
    };
    this.db.requests.push(request);
    this.save();
    return {
      device_code: deviceCode,
      user_code: request.userCode,
      verification_uri: `${origin}/access?request=${id}`,
      expires_in: 600,
      interval: 5,
    };
  }
  decide(id, room, approved, userCode) {
    const r = this.db.requests.find((r) => r.id === id);
    if (!r || r.expiresAt <= this.now() || r.state !== "pending")
      throw fail(409, "Request is expired or already handled.");
    // Callers without a screen to compare (the CLI) must echo the code.
    if (
      userCode !== undefined &&
      (typeof userCode !== "string" ||
        userCode.replace(/[\s-]/g, "").toUpperCase() !== r.userCode)
    )
      throw fail(400, "Verification code does not match this request.");
    Object.assign(r, {
      state: approved ? "approved" : "denied",
      roomId: room?.id,
      startIndex: room?.messages.length,
    });
    this.save();
  }
  poll(code, { rooms, canJoinRoom } = {}) {
    if (typeof code !== "string" || code.length > 256)
      throw fail(400, "Invalid device code.");
    const r = this.db.requests.find((r) => r.deviceHash === hash(code));
    if (!r || r.expiresAt <= this.now()) throw fail(410, "expired_token");
    if (r.lastPoll && this.now() - r.lastPoll < 5000)
      throw fail(429, "slow_down");
    r.lastPoll = this.now();
    if (r.state === "pending") throw fail(428, "authorization_pending");
    if (r.state !== "approved")
      throw fail(
        403,
        r.state === "denied" ? "access_denied" : "already_claimed",
      );
    const token = "hub_" + secret();
    const account = {
      id: randomUUID(),
      name: r.name,
      roomId: r.roomId,
      startIndex: r.startIndex,
      bindings: r.roomId ? { [r.roomId]: r.startIndex } : {},
      pendingRoomMembership: !!r.roomId,
      tokenHash: hash(token),
      createdAt: this.now(),
      expiresAt: this.now() + 30 * 86400000,
      revoked: false,
    };
    this.db.accounts.push(account);
    r.state = "claimed";
    if (rooms) this.migrateRooms(rooms, { canJoinRoom });
    this.save();
    return {
      access_token: token,
      token_type: "Bearer",
      expires_in: 30 * 86400,
      account_id: account.id,
      context_id: account.roomId || "",
    };
  }
  authenticate(header) {
    const token = /^Bearer (\S+)$/.exec(header || "")?.[1];
    const account =
      token && this.db.accounts.find((a) => a.tokenHash === hash(token));
    if (!account || account.revoked || account.expiresAt <= this.now())
      throw fail(401, "Invalid, expired, or revoked credential.");
    return account;
  }
  active(account) {
    return !!account && !account.revoked && account.expiresAt > this.now();
  }
  canAccess(accountId, roomId) {
    const account = this.db.accounts.find((a) => a.id === accountId);
    return (
      this.active(account) &&
      typeof roomId === "string" &&
      !!account.bindings &&
      Object.hasOwn(account.bindings, roomId) &&
      Number.isInteger(account.bindings[roomId]) &&
      account.bindings[roomId] >= 0
    );
  }
  migrateRooms(rooms, { canJoinRoom = () => true } = {}) {
    let changed = false;
    for (const account of this.db.accounts) {
      const legacy = !Object.hasOwn(account, "bindings");
      if (legacy) {
        const initial = rooms.find((r) => r.id === account.roomId);
        account.bindings = initial
          ? {
              [initial.id]:
                Number.isInteger(account.startIndex) && account.startIndex >= 0
                  ? account.startIndex
                  : initial.messages.length,
            }
          : {};
        changed = true;
      }
      // Only migrate an old approval or materialize an explicitly chosen
      // initial room. Ordinary restarts must not re-add removed memberships.
      if ((legacy || account.pendingRoomMembership) && this.active(account)) {
        if (account.roomId && !rooms.some((r) => r.id === account.roomId)) {
          delete account.bindings[account.roomId];
          delete account.roomId;
          delete account.startIndex;
          changed = true;
        }
        for (const r of rooms) {
          if (!this.canAccess(account.id, r.id)) continue;
          r.agentIds ??= [];
          r.memberSince ??= {};
          if (!r.agentIds.includes(account.id)) {
            // The owner may approve before the agent collects its token. Check
            // the room again now: an optional join must not overfill or change
            // an active chat, nor be retried silently after a later restart.
            if (r.agentIds.length >= 6 || !canJoinRoom(r)) {
              delete account.bindings[r.id];
              if (account.roomId === r.id) {
                delete account.roomId;
                delete account.startIndex;
              }
              changed = true;
              continue;
            }
            r.agentIds.push(account.id);
          }
          r.replyLimit = Math.min(
            6,
            Math.max(
              r.agentIds.length,
              Number.isInteger(r.replyLimit) ? r.replyLimit : 6,
            ),
          );
          r.memberSince[account.id] = account.bindings[r.id];
        }
      }
      if (account.pendingRoomMembership) {
        delete account.pendingRoomMembership;
        changed = true;
      }
    }
    if (changed) this.save();
    return changed;
  }
  setRoomMembers(room, accountIds) {
    if (
      !Array.isArray(accountIds) ||
      new Set(accountIds).size !== accountIds.length
    )
      throw fail(400, "Choose distinct approved agents.");
    const selected = new Set(accountIds);
    for (const id of selected) {
      if (!this.active(this.db.accounts.find((a) => a.id === id)))
        throw fail(400, "Approved agent is unavailable or access has expired.");
    }
    for (const account of this.db.accounts) {
      account.bindings ??= {};
      if (selected.has(account.id)) {
        if (!Object.hasOwn(account.bindings, room.id))
          account.bindings[room.id] = room.messages.length;
      } else delete account.bindings[room.id];
    }
    this.save();
  }
  rooms(account, rooms) {
    return rooms
      .filter(
        (r) =>
          this.canAccess(account.id, r.id) && r.agentIds?.includes(account.id),
      )
      .map((r) => ({
        id: r.id,
        title: r.title,
        paused: !!r.paused,
        archived: !!r.archived,
        start_cursor: account.bindings[r.id],
      }));
  }
  revoke(id) {
    const account = this.db.accounts.find((a) => a.id === id);
    if (!account) throw fail(404, "Connection not found.");
    account.revoked = true;
    this.save();
  }
  list() {
    return {
      requests: this.db.requests
        .filter((r) => r.state === "pending" && r.expiresAt > this.now())
        .map(({ id, name, userCode, expiresAt }) => ({
          id,
          name,
          userCode,
          expiresAt,
        })),
      accounts: this.db.accounts.map(({ tokenHash, ...a }) => a),
    };
  }
}

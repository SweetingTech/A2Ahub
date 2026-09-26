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
  decide(id, room, approved) {
    const r = this.db.requests.find((r) => r.id === id);
    if (!r || r.expiresAt <= this.now() || r.state !== "pending")
      throw fail(409, "Request is expired or already handled.");
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

import { randomUUID } from "node:crypto";

const terminal = new Set([
  "completed",
  "failed",
  "rejected",
  "canceled",
  "input-required",
]);
const id = (value) =>
  typeof value === "string" && /^[\w:-]{1,160}$/.test(value);

// The existing GroupChat scheduler owns budgets and conversation policy. This
// broker only transports one scheduled call to an approved agent's connector.
// Jobs are deliberately memory-only: a restart must never replay model work.
export class DispatchBroker {
  constructor({
    isAuthorized,
    onChange = () => {},
    now = Date.now,
    presenceMs = 45000,
    pollMs = 20000,
    cancelMs = 5000,
  } = {}) {
    Object.assign(this, {
      isAuthorized,
      onChange,
      now,
      presenceMs,
      pollMs,
      cancelMs,
    });
    this.peers = new Map();
    this.jobs = new Map();
    this.waiters = new Map();
    this.closed = false;
    this.timer = setInterval(() => this.sweep(), Math.min(presenceMs, 5000));
    this.timer.unref();
  }

  status(accountId) {
    const peer = this.peers.get(accountId);
    return !peer
      ? "approved"
      : this.now() - peer.seen < this.presenceMs
        ? "connected"
        : "offline";
  }

  lastSeen(accountId) {
    const seen = this.peers.get(accountId)?.seen;
    return seen === undefined ? null : new Date(seen).toISOString();
  }

  wake(accountId) {
    this.waiters.get(accountId)?.resolve();
  }

  stop(job, reason) {
    if (!["queued", "claimed"].includes(job.state)) return;
    const unclaimed = job.state === "queued";
    job.state = "canceled";
    job.finished = this.now();
    job.cancelConfirmed = unclaimed;
    job.reject(new Error(reason));
    job.cleanup();
    this.wake(job.accountId);
  }

  invalidate(accountId, roomId) {
    for (const job of this.jobs.values()) {
      if (job.accountId === accountId && (!roomId || job.roomId === roomId))
        this.stop(
          job,
          "Agent access to this conversation ended. Remote work may continue.",
        );
    }
    this.wake(accountId);
  }

  sweep() {
    let changed = false;
    for (const [accountId, peer] of this.peers) {
      if (this.status(accountId) === "offline" && !peer.offlineReported) {
        peer.offlineReported = true;
        changed = true;
      }
    }
    for (const [key, job] of this.jobs) {
      if (["queued", "claimed"].includes(job.state)) {
        if (!this.isAuthorized(job.accountId, job.roomId))
          this.stop(job, "Agent access ended.");
        else if (this.status(job.accountId) !== "connected")
          this.stop(
            job,
            "Agent connector disconnected. Send a new message after reconnecting; remote work may continue.",
          );
      } else if (this.now() - job.finished > 300000) this.jobs.delete(key);
    }
    if (changed) this.onChange();
  }

  send(agent, prompt, context, signal, update = () => {}, { roomId } = {}) {
    const accountId = agent.inboundAccountId || agent.id;
    if (this.closed || signal?.aborted)
      return Promise.reject(new Error("Stopped"));
    if (!this.isAuthorized(accountId, roomId))
      return Promise.reject(
        new Error("Agent is not authorized for this conversation."),
      );
    if (this.status(accountId) !== "connected")
      return Promise.reject(
        new Error(
          "Agent connector is offline. Start its connector, then send a new message.",
        ),
      );
    if (typeof prompt !== "string" || prompt.length > 150000)
      return Promise.reject(new Error("Dispatch prompt is too large."));
    const dispatchId = randomUUID();
    // The scheduler explicitly retains contexts for ongoing membership. When
    // it clears one (for example on removal), never revive the old session.
    const contextId = context?.contextId || `hub-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const abort = () =>
        this.stop(
          job,
          "Stopped; waiting for remote cancellation confirmation.",
        );
      const job = {
        dispatchId,
        accountId,
        roomId,
        prompt,
        context: { ...context, contextId },
        state: "queued",
        resolve,
        reject,
        update,
        cleanup: () => signal?.removeEventListener("abort", abort),
      };
      this.jobs.set(dispatchId, job);
      signal?.addEventListener("abort", abort, { once: true });
      update({ text: "", state: "submitted", taskId: dispatchId, contextId });
      this.wake(accountId);
    });
  }

  async cancel(agent, dispatchId) {
    const job = this.jobs.get(dispatchId);
    if (!job || job.accountId !== (agent.inboundAccountId || agent.id))
      return false;
    this.stop(job, "Stopped; remote cancellation requested.");
    if (
      job.cancelConfirmed !== undefined &&
      (!job.leaseId || job.cancelAcknowledged)
    )
      return job.cancelConfirmed;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        job.cancelWaiters.delete(done);
        resolve(false);
      }, this.cancelMs);
      const done = (confirmed) => {
        clearTimeout(timer);
        resolve(confirmed);
      };
      job.cancelWaiters ??= new Set();
      job.cancelWaiters.add(done);
    });
  }

  async next(account, command = {}) {
    if (this.closed) throw new Error("Hub is shutting down.");
    const accountId = account.id,
      connectorId = command.connectorId;
    if (!id(connectorId)) throw new Error("A valid connectorId is required.");
    if (this.waiters.has(accountId))
      throw new Error("Another poll is already active for this agent.");
    const prior = this.peers.get(accountId);
    if (
      prior &&
      prior.connectorId !== connectorId &&
      this.status(accountId) === "connected"
    )
      throw new Error("Another connector already owns this agent connection.");
    const wasConnected = this.status(accountId) === "connected";
    this.peers.set(accountId, {
      connectorId,
      seen: this.now(),
      offlineReported: false,
    });
    if (!wasConnected) this.onChange();
    const take = () => {
      this.sweep();
      const owned = [...this.jobs.values()].filter(
        (job) => job.accountId === accountId,
      );
      const cancellations = owned
        .filter(
          (job) =>
            job.state === "canceled" &&
            job.connectorId === connectorId &&
            !job.cancelAcknowledged,
        )
        .map(({ dispatchId, leaseId }) => ({ dispatchId, leaseId }));
      if (cancellations.length) return { dispatch: null, cancellations };
      // A claimed job is never re-delivered, even when its original HTTP reply
      // was lost. The owner can inspect the uncertain outcome and send anew.
      if (
        command.available === false ||
        owned.some((job) => job.state === "claimed")
      )
        return null;
      const job = owned.find(
        (job) =>
          job.state === "queued" &&
          (!command.roomId || command.roomId === job.roomId) &&
          this.isAuthorized(accountId, job.roomId),
      );
      if (!job) return null;
      Object.assign(job, {
        state: "claimed",
        connectorId,
        leaseId: randomUUID(),
      });
      return {
        dispatch: {
          dispatchId: job.dispatchId,
          leaseId: job.leaseId,
          roomId: job.roomId,
          prompt: job.prompt,
          context: job.context,
        },
        cancellations: [],
      };
    };
    let result = take();
    if (!result && command.waitMs !== 0) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, this.pollMs);
        this.waiters.set(accountId, {
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        });
      });
      this.waiters.delete(accountId);
      if (this.closed) throw new Error("Hub is shutting down.");
      result = take();
    }
    this.peers.get(accountId).seen = this.now();
    return {
      ...(result || { dispatch: null, cancellations: [] }),
      pollAfterMs: 250,
    };
  }

  report(account, command = {}) {
    const job = this.jobs.get(command.dispatchId);
    if (
      !job ||
      job.accountId !== account.id ||
      job.connectorId !== command.connectorId ||
      job.leaseId !== command.leaseId
    )
      throw new Error("Unknown dispatch or invalid claim.");
    const authorized = this.isAuthorized(account.id, job.roomId);
    if (!authorized) this.stop(job, "Agent access ended.");
    if (command.kind === "canceled" && job.state === "canceled") {
      job.cancelAcknowledged = true;
      job.cancelConfirmed = command.canceled === true;
      for (const done of job.cancelWaiters || []) done(job.cancelConfirmed);
      job.cancelWaiters?.clear();
      return { accepted: true, canceled: job.cancelConfirmed };
    }
    if (!authorized || job.state === "canceled")
      return { accepted: false, canceled: true };
    if (job.state !== "claimed") return { accepted: false, duplicate: true };
    const input = command.result || {};
    if (typeof input.text !== "string" || input.text.length > 1000000)
      throw new Error("Invalid dispatch result text.");
    const result = {
      text: input.text,
      state: String(input.state || "working"),
      contextId:
        typeof input.contextId === "string"
          ? input.contextId.slice(0, 300)
          : job.context.contextId,
      ...(typeof input.taskId === "string"
        ? { taskId: input.taskId.slice(0, 300) }
        : {}),
    };
    if (command.kind === "progress") {
      job.update({
        ...result,
        state: result.state === "submitted" ? "submitted" : "working",
        taskId: job.dispatchId,
      });
      return { accepted: true };
    }
    if (command.kind !== "complete" && command.kind !== "error")
      throw new Error("Unknown dispatch report kind.");
    if (command.kind === "complete" && !terminal.has(result.state))
      throw new Error("A terminal result is required.");
    job.state = "done";
    job.finished = this.now();
    job.cleanup();
    if (command.kind === "error")
      job.reject(new Error(result.text || "Agent connector failed."));
    else job.resolve(result);
    this.wake(account.id);
    return { accepted: true };
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const job of this.jobs.values())
      this.stop(job, "Hub stopped. Interrupted work will not be replayed.");
    for (const waiter of this.waiters.values()) waiter.resolve();
  }
}

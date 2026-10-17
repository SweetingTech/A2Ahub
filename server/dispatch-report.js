import { digestContent } from "./events.js";

const terminal = new Set([
  "completed",
  "failed",
  "rejected",
  "canceled",
  "input-required",
]);

// Handle a dispatch report from a connector: progress, completion, error,
// or cancellation acknowledgment. Extracted from DispatchBroker to keep
// the broker class under the file-size target.
export function report(broker, account, command = {}) {
  const job = broker.jobs.get(command.dispatchId);
  if (!job) {
    if (broker.journal && command.kind === "complete") {
      const prior = broker.journal.getCompletion(command.dispatchId);
      if (prior) {
        const dig = digestContent(command.result?.text || "");
        if (prior.contentDigest === dig)
          return { accepted: true, duplicate: true, receipt: prior };
        return { accepted: false, conflict: true, receipt: prior };
      }
    }
    throw new Error("Unknown dispatch or invalid claim.");
  }
  if (
    job.accountId !== account.id ||
    job.connectorId !== command.connectorId ||
    job.leaseId !== command.leaseId
  )
    throw new Error("Unknown dispatch or invalid claim.");
  const authorized = broker.isAuthorized(account.id, job.roomId);
  if (!authorized) broker.stop(job, "Agent access ended.");
  // Cancellation acknowledgments are always accepted, even after a
  // generation-sealing Stop-all, so the connector can clear its queue
  // and receive new work from the new generation.
  if (command.kind === "canceled" && job.state === "canceled") {
    const generation = broker.getGeneration(job.roomId);
    const sealed =
      generation && job.generationId && job.generationId !== generation;
    job.cancelAcknowledged = true;
    job.cancelConfirmed = command.canceled === true;
    for (const done of job.cancelWaiters || []) done(job.cancelConfirmed);
    job.cancelWaiters?.clear();
    broker.journalEvent({
      type: "dispatch.canceled",
      roomId: job.roomId,
      dispatchId: job.dispatchId,
      senderId: account.id,
      audience: [account.id],
      payload: { confirmed: job.cancelConfirmed, sealed: sealed === true },
    });
    return { accepted: true, canceled: job.cancelConfirmed };
  }
  // A sealed run (global Stop) rejects late completion reports.
  const generation = broker.getGeneration(job.roomId);
  if (generation && job.generationId && job.generationId !== generation) {
    return { accepted: false, sealed: true };
  }
  if (!authorized || job.state === "canceled")
    return { accepted: false, canceled: true };
  // Check for a prior receipt before rejecting on job state.
  if (broker.journal && command.kind === "complete") {
    const prior = broker.journal.getCompletion(command.dispatchId);
    if (prior) {
      const dig = digestContent(command.result?.text || "");
      if (prior.contentDigest === dig)
        return { accepted: true, duplicate: true, receipt: prior };
      return { accepted: false, conflict: true, receipt: prior };
    }
  }
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
    broker.journalEvent({
      type: "dispatch.progress",
      roomId: job.roomId,
      dispatchId: job.dispatchId,
      senderId: account.id,
      audience: [account.id],
      payload: { state: result.state },
    });
    return { accepted: true };
  }
  if (command.kind !== "complete" && command.kind !== "error")
    throw new Error("Unknown dispatch report kind.");
  if (command.kind === "complete" && !terminal.has(result.state))
    throw new Error("A terminal result is required.");
  const receiptResult = recordCompletion(broker, job, result, command.kind);
  if (receiptResult.duplicate)
    return { accepted: true, duplicate: true, receipt: receiptResult.receipt };
  if (receiptResult.conflict)
    return { accepted: false, conflict: true, receipt: receiptResult.receipt };
  job.state = "done";
  job.finished = broker.now();
  job.cleanup();
  broker.journalEvent({
    type: command.kind === "error" ? "dispatch.error" : "dispatch.completed",
    roomId: job.roomId,
    dispatchId: job.dispatchId,
    senderId: account.id,
    audience: [account.id],
    payload: { state: result.state, contextId: result.contextId },
  });
  if (command.kind === "error")
    job.reject(new Error(result.text || "Agent connector failed."));
  else job.resolve(result);
  broker.wake(account.id);
  return { accepted: true, receipt: receiptResult.receipt };
}

export function recordCompletion(broker, job, result, kind) {
  if (kind !== "complete")
    return { accepted: true, duplicate: false, conflict: false, receipt: null };
  if (broker.journal) {
    return broker.journal.recordCompletion({
      dispatchId: job.dispatchId,
      text: result.text,
      state: result.state,
      contextId: result.contextId,
      taskId: result.taskId,
    });
  }
  if (!job.receipts) job.receipts = new Map();
  const dig = digestContent(result.text);
  const existing = job.receipts.get("completion");
  if (existing) {
    if (existing.contentDigest === dig)
      return {
        accepted: true,
        receipt: existing,
        duplicate: true,
        conflict: false,
      };
    return {
      accepted: false,
      receipt: existing,
      duplicate: false,
      conflict: true,
    };
  }
  const receipt = {
    dispatchId: job.dispatchId,
    contentDigest: dig,
    text: result.text,
    state: result.state,
    contextId: result.contextId,
    taskId: result.taskId || null,
    acceptedAt: new Date(broker.now()).toISOString(),
  };
  job.receipts.set("completion", receipt);
  return { accepted: true, receipt, duplicate: false, conflict: false };
}

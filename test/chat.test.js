import test from "node:test";
import assert from "node:assert/strict";
import { GroupChat } from "../server/chat.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
function setup({ timeoutMs = 180000, ignoreAbort = false } = {}) {
  const calls = [],
    cancellations = [];
  const agents = ["Alpha", "Beta", "Gamma"].map((name) => ({
    id: name,
    name,
    status: "connected",
  }));
  const room = {
    id: "room",
    messages: [],
    contexts: {},
    agentIds: ["Alpha", "Beta"],
    agentChat: true,
    replyLimit: 6,
    paused: false,
  };
  const chat = new GroupChat({
    publish: () => {},
    redact: (s) => s,
    timeoutMs,
    cancel: async (a, id) => {
      cancellations.push([a.id, id]);
      return true;
    },
    send: (agent, text, context, signal, update) =>
      new Promise((resolve, reject) => {
        const taskId = String(calls.length + 1);
        const call = {
          agent,
          text,
          context,
          signal,
          update,
          resolve,
          reject,
          taskId,
        };
        calls.push(call);
        update({ text: "", state: "working", taskId });
        if (!ignoreAbort)
          signal.addEventListener("abort", () => reject(new Error("Aborted")), {
            once: true,
          });
      }),
  });
  const reply = async (
    call,
    text = `${call.agent.name} says hello`,
    state = "completed",
  ) => {
    call.resolve({
      text,
      state,
      contextId: call.agent.id + "-context",
      taskId: call.taskId,
    });
    await tick();
  };
  return { chat, calls, cancellations, room, agents, reply };
}

test("re-added members cannot Continue old topics or receive peer backlog from prior membership", async () => {
  const h = setup();
  h.room.messages.push(
    {
      id: "old-human",
      role: "user",
      text: "Old topic",
      recipientIds: ["Alpha"],
    },
    {
      id: "old-peer",
      role: "agent",
      agentId: "Beta",
      text: "PRIVATE INTERVAL",
      shared: true,
      state: "completed",
      recipientIds: ["Alpha"],
    },
  );
  h.room.memberSince = { Alpha: 2 };
  assert.throws(() => h.chat.start(h.room, [h.agents[0]], null), /new message/);
  h.chat.start(h.room, [h.agents[0]], "New membership topic");
  assert.ok(!h.calls[0].text.includes("PRIVATE INTERVAL"));
  assert.ok(h.calls[0].text.includes("New membership topic"));
  await h.reply(h.calls[0]);
});

test("human messages use owner profile and preserve an explicit room title", async () => {
  const h = setup();
  h.chat.ownerName = () => "DJSweetz";
  h.room.title = "My team";
  h.room.customTitle = true;
  h.chat.start(h.room, [h.agents[0]], "Hello everyone");
  assert.equal(h.room.messages[0].name, "DJSweetz");
  assert.equal(h.room.title, "My team");
  await h.reply(h.calls[0]);
});

test("manual inbound posts use only the latest human allowance and never wake their author", async () => {
  const h = setup();
  const run = h.chat.start(h.room, h.agents.slice(0, 2), "Discuss this");
  await h.reply(h.calls[0], "");
  await h.reply(h.calls[1], "");
  assert.equal(run.state, "completed");
  for (let i = 0; i < 8; i++) {
    h.chat.relayPost(h.room, {
      id: `manual-${i}`,
      agentId: "Beta",
      role: "agent",
      shared: true,
      recipientIds: ["Alpha", "Beta"],
      text: "A follow-up",
      name: "Beta",
    });
    if (h.calls.at(-1).agent.id === "Alpha") await h.reply(h.calls.at(-1), "");
  }
  assert.equal(h.calls.length, 6);
  assert.ok(h.calls.slice(2).every((c) => c.agent.id === "Alpha"));
  assert.equal(run.used, 6);
});

test("manual posts cannot start a conversation or resume a paused one", async () => {
  const h = setup();
  const message = {
    id: "manual",
    agentId: "Beta",
    role: "agent",
    shared: true,
    recipientIds: ["Alpha"],
    text: "Hi",
  };
  h.chat.relayPost(h.room, message);
  assert.equal(h.calls.length, 0);
  h.chat.start(h.room, h.agents.slice(0, 2), "Topic");
  await h.chat.stop(h.room);
  h.chat.relayPost(h.room, message);
  assert.equal(h.calls.length, 2);
});

test("Stop seals a settled allowance so Resume and a late post cannot restart it", async () => {
  const h = setup();
  const run = h.chat.start(h.room, h.agents.slice(0, 2), "Topic");
  await h.reply(h.calls[0], "");
  await h.reply(h.calls[1], "");
  assert.equal(run.state, "completed");
  assert.equal(run.used, 2);
  await h.chat.stop(h.room);
  h.room.paused = false;
  h.chat.relayPost(h.room, {
    id: "late-manual",
    agentId: "Beta",
    role: "agent",
    shared: true,
    recipientIds: ["Alpha"],
    text: "Late reply",
  });
  await tick();
  assert.equal(h.calls.length, 2);
  assert.equal(run.allowPeers, false);
  h.chat.start(h.room, h.agents.slice(0, 2), "New explicit topic");
  assert.equal(h.calls.length, 4);
  await h.chat.stop(h.room);
});

test("members start concurrently; fast replies reach peers without waiting for the slowest", async () => {
  const h = setup();
  const run = h.chat.start(h.room, h.agents, "Round table this");
  assert.deepEqual(
    h.calls.map((c) => c.agent.id),
    ["Alpha", "Beta", "Gamma"],
  );
  await h.reply(h.calls[1], "Beta's idea");
  await h.reply(h.calls[0], "Alpha's idea");
  assert.equal(h.calls.length, 5);
  assert.equal(h.calls[2].signal.aborted, false);
  assert.match(h.calls[3].text, /Beta's idea/);
  assert.match(h.calls[4].text, /Alpha's idea/);
  assert.equal(
    h.room.messages.filter((m) => m.state === "completed").length,
    2,
  );
  await h.chat.stop(h.room);
  assert.equal(run.state, "stopped");
});

test("six-request cap is reserved before dispatch; concurrent completions cannot overrun it", async () => {
  const h = setup();
  const run = h.chat.start(h.room, h.agents.slice(0, 2), "Discuss");
  for (let i = 0; i < 6; i++) {
    assert.ok(h.calls[i]);
    await h.reply(h.calls[i]);
  }
  assert.equal(h.calls.length, 6);
  assert.equal(run.state, "completed");
  assert.equal(run.turn, 6);
  assert.equal(h.chat.active().length, 0);
});

test("a human interjection drops queued peer chatter and preserves per-agent context order", async () => {
  const h = setup();
  const old = h.chat.start(h.room, h.agents.slice(0, 2), "Original topic");
  await h.reply(h.calls[0], "Queued peer idea");
  const next = h.chat.start(h.room, h.agents.slice(0, 2), "New direction");
  assert.equal(h.calls.length, 3); // Alpha moves ahead while Beta is still busy.
  assert.match(h.calls[2].text, /New direction/);
  assert.equal(h.calls[2].context.contextId, "Alpha-context");
  await h.reply(h.calls[1]);
  assert.equal(h.calls.length, 4);
  assert.match(h.calls[3].text, /New direction/);
  assert.match(h.calls[3].text, /Queued peer idea/); // Delivered as context with the human interjection, not its own call.
  assert.equal(old.state, "completed");
  assert.equal(next.state, "running");
  await h.chat.stop(h.room);
});

test("Stop aborts every worker and clears queued human and peer messages; pause is latched", async () => {
  const h = setup();
  h.chat.start(h.room, h.agents.slice(0, 2), "First");
  h.chat.start(h.room, h.agents.slice(0, 2), "Queued human message");
  await h.chat.stop(h.room);
  await tick();
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every((c) => c.signal.aborted));
  assert.equal(h.cancellations.length, 2);
  assert.ok(h.room.paused);
  assert.equal(h.chat.active().length, 0);
  assert.throws(
    () => h.chat.start(h.room, h.agents.slice(0, 2), "No"),
    /paused/,
  );
  assert.ok(
    h.room.messages
      .filter((m) => m.role === "agent")
      .every((m) => m.state === "stopped"),
  );
});

test("late results and streaming events after Stop cannot revive replies or contexts", async () => {
  const h = setup({ ignoreAbort: true });
  h.chat.start(h.room, h.agents.slice(0, 2), "Stop me");
  await h.chat.stop(h.room);
  h.calls[0].update({ text: "Late stream", taskId: "late" });
  await h.reply(h.calls[0], "Late final");
  await h.reply(h.calls[1], "Late final");
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.room.contexts, {});
  assert.ok(h.room.messages.every((m) => !m.text.includes("Late")));
});

test("Continue advances the existing topic, unpauses, and starts a new bounded allowance", async () => {
  const h = setup();
  h.room.replyLimit = 2;
  h.chat.start(h.room, h.agents.slice(0, 2), "Topic to explore");
  await h.reply(h.calls[0], "Idea A");
  await h.reply(h.calls[1], "Idea B");
  await h.chat.stop(h.room);
  const next = h.chat.start(h.room, h.agents.slice(0, 2), null);
  assert.equal(h.room.paused, false);
  assert.equal(h.calls.length, 4);
  assert.match(h.calls[2].text, /human clicked Continue/);
  assert.match(h.calls[2].text, /Idea B/);
  assert.match(h.calls[3].text, /Idea A/);
  assert.equal(h.room.messages.filter((m) => m.role === "user").length, 1);
  assert.equal(next.maxTurns, 2);
  await h.chat.stop(h.room);
});

test("Continue cannot disclose history to newly added members", async () => {
  const h = setup();
  h.room.replyLimit = 2;
  h.chat.start(h.room, h.agents.slice(0, 2), "Private to Alpha and Beta");
  await h.reply(h.calls[0]);
  await h.reply(h.calls[1]);
  assert.throws(
    () => h.chat.start(h.room, h.agents, null),
    /introduce the topic/,
  );
  assert.equal(h.calls.length, 2);
});

test("offline or failed agents do not block healthy members; input-required is not auto-continued", async () => {
  const h = setup();
  h.agents[0].status = "offline";
  const run = h.chat.start(h.room, h.agents, "Talk");
  assert.deepEqual(
    h.calls.map((c) => c.agent.id),
    ["Beta", "Gamma"],
  );
  await h.reply(h.calls[0], "Need human input", "input-required");
  await h.reply(h.calls[1]);
  assert.equal(h.calls.length, 2);
  assert.equal(run.state, "completed-with-errors");
  assert.equal(h.room.contexts.Beta.taskId, h.calls[0].taskId);
  assert.match(
    h.room.messages.find((m) => m.agentId === "Alpha").text,
    /unavailable/,
  );
});

test("timeout cancels only that agent and does not stop healthy peers", async () => {
  const h = setup({ timeoutMs: 30 });
  h.room.agentChat = false;
  const run = h.chat.start(h.room, h.agents.slice(0, 2), "Talk");
  await h.reply(h.calls[1], "Fast answer");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(run.state, "completed-with-errors");
  assert.equal(h.cancellations.length, 1);
  assert.equal(
    h.room.messages.find((m) => m.agentId === "Beta").state,
    "completed",
  );
  assert.equal(
    h.room.messages.find((m) => m.agentId === "Alpha").state,
    "timed-out",
  );
});

test("another room cannot start while a discussion is active", async () => {
  const h = setup();
  h.chat.start(h.room, h.agents.slice(0, 2), "Here");
  assert.throws(
    () => h.chat.start({ ...h.room, id: "other" }, h.agents, "Elsewhere"),
    /another conversation/,
  );
  await h.chat.stop(h.room);
});

test("peer replies that finish at the cap reach the next human message", async () => {
  const h = setup();
  h.room.replyLimit = 2;
  h.chat.start(h.room, h.agents.slice(0, 2), "Initial");
  await h.reply(h.calls[0], "Late idea A");
  await h.reply(h.calls[1], "Late idea B");
  h.chat.start(h.room, h.agents.slice(0, 2), "Discuss those ideas");
  assert.match(h.calls[2].text, /Late idea B/);
  assert.match(h.calls[3].text, /Late idea A/);
  await h.chat.stop(h.room);
});

test("Continue cannot answer an input-required task on the human's behalf", async () => {
  const h = setup();
  h.room.replyLimit = 2;
  h.chat.start(h.room, h.agents.slice(0, 2), "Need a decision");
  await h.reply(h.calls[0], "Which option?", "input-required");
  await h.reply(h.calls[1]);
  assert.throws(
    () => h.chat.start(h.room, h.agents.slice(0, 2), null),
    /needs your input/,
  );
  const next = h.chat.start(h.room, h.agents.slice(0, 2), "Use option A");
  assert.equal(h.calls[2].context.taskId, h.calls[0].taskId);
  assert.equal(next.state, "running");
  await h.chat.stop(h.room);
});

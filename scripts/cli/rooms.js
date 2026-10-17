// Room/conversation commands for the a2ahub CLI.
// Exports registerRooms(ctx) which returns an object of command handlers.
// The shared context provides: api, post, print, table, when, pick, findRoom,
// flags, json, emit, watch, printMessage, settled, fail.

export function registerRooms(ctx) {
  const { api, post, print, table, when, pick, findRoom, flags, json, fail } =
    ctx;

  function printMessage(m) {
    const time = new Date(m.createdAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    const state =
      m.role === "user" || m.state === "completed" ? "" : ` [${m.state}]`;
    console.log(`\n${time}  ${m.name}${state}`);
    if (m.text) console.log(m.text.replace(/^/gm, "  "));
  }

  const settled = (m) =>
    m.role === "user" || !["working", "submitted"].includes(m.state);

  // With --json, watching prints one JSON object per line (NDJSON).
  const emit = (event, human) =>
    json ? console.log(JSON.stringify(event)) : human();

  async function watch(room, runId, from) {
    const origin = ctx.hubOrigin();
    const controller = new AbortController();
    process.once("SIGINT", () => {
      controller.abort();
      console.error(
        `\nDetached. Agents keep running — stop them with: a2ahub stop "${room.title}"`,
      );
      process.exit(130);
    });
    const res = await fetch(`${origin}/api/v1/events`, {
      headers: {
        Authorization: `Bearer ${ctx.token()}`,
        Accept: "text/event-stream",
      },
      signal: controller.signal,
    });
    if (!res.ok) fail(`Cannot follow events (${res.status}).`);
    const printed = new Set(),
      working = new Set();
    let baseline = null,
      lastStatus = "";
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const event = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (event.startsWith("event: auth-expired")) {
          await res.body.cancel().catch(() => {});
          fail("The manager token was revoked.");
        }
        const data = event
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => l.slice(6))
          .join("");
        if (!data) continue;
        const state = JSON.parse(data);
        const current = state.rooms.find((r) => r.id === room.id);
        if (!current) fail("The conversation was deleted.");
        // A new burst starts at the index the server reported; otherwise
        // show only what arrives from now on.
        if (baseline === null) {
          baseline = Number.isInteger(from) ? from : current.messages.length;
          current.messages.slice(0, baseline).forEach((m) => printed.add(m.id));
        }
        for (const m of current.messages) {
          if (printed.has(m.id)) continue;
          if (settled(m)) {
            printed.add(m.id);
            const { id, name, role, state, text, createdAt } = m;
            emit(
              { type: "message", id, name, role, state, text, createdAt },
              () => printMessage(m),
            );
          } else if (!working.has(m.id)) {
            working.add(m.id);
            emit({ type: "working", id: m.id, name: m.name }, () =>
              console.log(`\n… ${m.name} is working`),
            );
          }
        }
        const runs = state.runs.filter((r) => r.roomId === room.id);
        const run = runId ? runs.find((r) => r.id === runId) : runs.at(-1);
        if (run) {
          const status = `${run.state} · ${run.turn}/${run.maxTurns} requests`;
          if (status !== lastStatus) {
            lastStatus = status;
            const { id, state, turn, maxTurns } = run;
            emit({ type: "status", runId: id, state, turn, maxTurns }, () =>
              console.log(`\n— ${status}`),
            );
          }
        }
        if (runId && run && !["running", "stopping"].includes(run.state)) {
          // Leaving the loop cancels the stream cleanly; aborting here would
          // surface as an error after a successful run.
          return;
        }
      }
    }
  }

  async function rooms() {
    const [rooms, state] = await Promise.all([api("/rooms"), api("/state")]);
    const folders = Object.fromEntries(state.folders.map((f) => [f.id, f.name]));
    const shown = rooms.filter((r) => !!r.archived === !!flags.archived);
    return print(shown, (list) =>
      table(
        list.map((r) => ({
          title: r.title,
          folder: folders[r.folderId] || "—",
          members: r.agentIds.length,
          state: r.active ? "active" : r.paused ? "paused" : "idle",
          last: when(r.lastMessageAt),
          id: r.id.slice(0, 8),
        })),
        [
          ["title", "CONVERSATION"],
          ["folder", "FOLDER"],
          ["members", "AGENTS"],
          ["state", "STATE"],
          ["last", "LAST"],
          ["id", "ID"],
        ],
      ),
    );
  }

  async function show(sub) {
    const room = await findRoom(sub);
    const full = await api(`/rooms/${room.id}`);
    const last = Number(flags.last) || 10;
    return print(full.messages.slice(-last), (messages) => {
      console.log(`${full.title}${full.archived ? " (archived)" : ""}`);
      messages.forEach(printMessage);
    });
  }

  async function create(sub, rest) {
    const state = await api("/state");
    const body = {};
    if (flags.folder)
      body.folderId = pick(state.folders, flags.folder, "folder", [
        "id",
        "name",
      ]).id;
    const room = await api("/rooms", body);
    if (sub)
      await api(
        `/rooms/${room.id}`,
        { title: [sub, ...rest].join(" ") },
        "PATCH",
      );
    return print({ id: room.id }, () =>
      console.log(
        `✓ Created ${sub ? [sub, ...rest].join(" ") : room.title} (${room.id})`,
      ),
    );
  }

  async function say(sub, rest) {
    const room = await findRoom(sub);
    const text = rest.join(" ");
    if (!text) fail('Usage: a2ahub say ROOM "message"');
    const run = await post(`/rooms/${room.id}/messages`, { text });
    if (json && flags.watch)
      emit({ type: "started", ...run, roomId: room.id }, () => {});
    else
      print(run, () =>
        console.log(
          `→ Sent to ${room.title}. Burst ${run.id.slice(0, 8)} started.`,
        ),
      );
    if (flags.watch) await watch(room, run.id, run.from);
  }

  async function cont(sub) {
    const room = await findRoom(sub);
    const run = await post(`/rooms/${room.id}/continue`);
    if (json && flags.watch)
      emit({ type: "started", ...run, roomId: room.id }, () => {});
    else print(run, () => console.log(`→ Continuing ${room.title}.`));
    if (flags.watch) await watch(room, run.id, run.from);
  }

  async function watchRoom(sub) {
    return watch(await findRoom(sub));
  }

  async function stop(sub) {
    if (flags.all || sub === "--all") {
      const result = await post("/admin/stop-all");
      return print(result, (r) =>
        console.log(`✓ Stopped ${r.stopped.length} active conversation(s).`),
      );
    }
    const room = await findRoom(sub);
    await post(`/rooms/${room.id}/stop`);
    return print({ ok: true }, () =>
      console.log(
        `✓ Stopped ${room.title}. Remote cancellation was attempted; already-started work may continue.`,
      ),
    );
  }

  async function lifecycle(command, sub) {
    const room = await findRoom(sub);
    const route = {
      resume: "resume",
      archive: "archive",
      restore: "unarchive",
    }[command];
    await post(`/rooms/${room.id}/${route}`);
    return print({ ok: true }, () => console.log(`✓ ${command} ${room.title}`));
  }

  async function move(sub, rest) {
    const room = await findRoom(sub);
    const state = await api("/state");
    const target = rest.join(" ");
    const folderId =
      !target || target === "none"
        ? null
        : pick(state.folders, target, "folder", ["id", "name"]).id;
    await api(`/rooms/${room.id}`, { folderId }, "PATCH");
    return print({ ok: true }, () =>
      console.log(
        `✓ Moved ${room.title} to ${folderId ? target : "no folder"}.`,
      ),
    );
  }

  async function folders() {
    return print((await api("/state")).folders, (folders) =>
      table(folders, [
        ["name", "FOLDER"],
        ["color", "COLOR"],
        ["id", "ID"],
      ]),
    );
  }

  async function folder(sub, rest) {
    const name = rest.join(" ");
    if (sub === "create") {
      const folder = await api("/folders", {
        name,
        color: flags.color || "gray",
      });
      return print(folder, () => console.log(`✓ Created folder ${folder.name}`));
    }
    if (sub === "delete") {
      const folder = pick((await api("/state")).folders, name, "folder", [
        "id",
        "name",
      ]);
      await api(`/folders/${folder.id}`, undefined, "DELETE");
      return print({ ok: true }, () =>
        console.log(
          `✓ Deleted folder ${folder.name}; its conversations are unfiled.`,
        ),
      );
    }
    fail("Usage: a2ahub folder create NAME | folder delete NAME");
  }

  async function events(positional) {
    const room = await findRoom(flags.room || positional[0]);
    const cursor = Number(flags.cursor || 0);
    const result = await api(`/rooms/${room.id}/events?cursor=${cursor}`);
    return print(result, (r) => {
      console.log(`Conversation: ${room.title} (${room.id})`);
      if (r.resyncRequired)
        console.log(
          `⚠ Cursor expired — oldest retained seq is ${r.oldestSeq}. Re-read from 0.`,
        );
      if (!r.events.length) return console.log("(no events after cursor)");
      for (const e of r.events) {
        const time = e.createdAt
          ? new Date(e.createdAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })
          : "?";
        const who = e.senderName || e.senderId || "system";
        console.log(`  [${e.seq}] ${time} ${e.type} ${who}`);
      }
      console.log(`\nNext cursor: ${r.nextCursor}`);
    });
  }

  return {
    rooms,
    show,
    create,
    say,
    continue: cont,
    watch: watchRoom,
    stop,
    lifecycle,
    move,
    folders,
    folder,
    events,
    // Exposed for say/continue/watch composition and tests.
    _watch: watch,
    _printMessage: printMessage,
    _emit: emit,
  };
}

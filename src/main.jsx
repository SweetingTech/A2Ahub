import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Share2,
  Plus,
  MessageCircle,
  Folder,
  Square,
  Send,
  ChevronRight,
  X,
  RefreshCw,
  Trash2,
  Menu,
  Check,
  AlertCircle,
} from "lucide-react";
import "./style.css";
async function api(url, body, method = "POST") {
  const r = await fetch("/api" + url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || "Request failed");
  return d;
}
function App() {
  const [data, setData] = useState(null),
    [roomId, setRoomId] = useState(""),
    [text, setText] = useState(""),
    [modal, setModal] = useState(false),
    [url, setUrl] = useState(""),
    [tokenEnv, setTokenEnv] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [inspected, setInspected] = useState(""),
    [mobile, setMobile] = useState(false),
    [online, setOnline] = useState(true),
    [inspectOpen, setInspectOpen] = useState(false);
  const bottom = useRef(null),
    composer = useRef(null),
    initialized = useRef(false);
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onmessage = (e) => {
      const d = JSON.parse(e.data);
      setData(d);
      setOnline(true);
      if (!initialized.current) {
        initialized.current = true;
        setRoomId(d.rooms[0]?.id);
        setInspected(d.agents[0]?.id || "");
      }
    };
    es.onerror = () => setOnline(false);
    return () => es.close();
  }, []);
  const room = data?.rooms.find((r) => r.id === roomId) || data?.rooms[0],
    agent = data?.agents.find((a) => a.id === inspected) || data?.agents[0];
  const active = data?.runs.find((r) =>
      ["running", "stopping"].includes(r.state),
    ),
    run = [...(data?.runs || [])].reverse().find((r) => r.roomId === room?.id);
  const selected = room?.agentIds || [],
    relay = room?.agentChat ?? true,
    limit = room?.replyLimit || 6,
    roomRuns = (data?.runs || []).filter(
      (r) => r.roomId === room?.id && ["running", "stopping"].includes(r.state),
    ),
    roomActive = roomRuns.length > 0,
    otherRoomActive = active && active.roomId !== room?.id,
    talkingIds = [...new Set(roomRuns.flatMap((r) => r.activeAgentIds))],
    queuedIds = [...new Set(roomRuns.flatMap((r) => r.queuedAgentIds))];
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [room?.messages.length, room?.messages.at(-1)?.text]);
  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement;
    document.querySelector("#endpoint")?.focus();
    const trap = (e) => {
      if (e.key !== "Tab") return;
      const nodes = [
        ...document.querySelectorAll(
          ".modal button:not(:disabled),.modal input",
        ),
      ];
      const first = nodes[0],
        last = nodes.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => {
      document.removeEventListener("keydown", trap);
      previous?.focus();
    };
  }, [modal]);
  async function action(fn) {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function settings(change) {
    return api(`/rooms/${room.id}`, change, "PATCH");
  }
  function choose(id) {
    const agentIds = selected.includes(id)
      ? selected.filter((x) => x !== id)
      : [...selected, id];
    action(() =>
      settings({ agentIds, replyLimit: Math.max(limit, agentIds.length) }),
    );
  }
  async function submit(e) {
    e.preventDefault();
    await action(async () => {
      await api("/runs", {
        roomId: room.id,
        text,
      });
      setText("");
    });
  }
  const addAgent = (e) => {
    e.preventDefault();
    action(async () => {
      const a = await api("/agents", { url, tokenEnv });
      if (!roomActive && selected.length < 6)
        await settings({
          agentIds: [...selected, a.id],
          replyLimit: Math.max(limit, selected.length + 1),
        });
      setInspected(a.id);
      setModal(false);
      setUrl("");
      setTokenEnv("");
    });
  };
  if (!data)
    return (
      <div className="loading">
        <Share2 />
        Connecting to your local workspace…
        {!online && <p>Server unavailable. Start A2Ahub with npm start.</p>}
      </div>
    );
  return (
    <div className="app">
      <aside className={`sidebar ${mobile ? "open" : ""}`}>
        <div className="brand">
          <Share2 size={42} />
          <div>
            <strong>A2Ahub</strong>
            <p>Your agents. One conversation.</p>
          </div>
          <button
            className="mobile-close icon"
            aria-label="Close menu"
            onClick={() => setMobile(false)}
          >
            <X />
          </button>
        </div>
        <button
          className="primary new"
          onClick={() =>
            action(async () => {
              const r = await api("/rooms");
              setRoomId(r.id);
              setMobile(false);
            })
          }
        >
          <Plus size={18} />
          New conversation
        </button>
        <nav aria-label="Conversations">
          {data.rooms.map((r) => (
            <button
              key={r.id}
              className={`room ${r.id === room?.id ? "selected" : ""}`}
              onClick={() => {
                setRoomId(r.id);
                setMobile(false);
              }}
            >
              <MessageCircle size={19} />
              <span>{r.title}</span>
            </button>
          ))}
        </nav>
        <h3>Agents</h3>
        <div className="agents">
          {data.agents.map((a) => (
            <button
              className="agent-row"
              key={a.id}
              onClick={() => {
                setInspected(a.id);
                setInspectOpen(true);
                setMobile(false);
              }}
            >
              <i className={`dot ${a.status}`} />
              <span>{a.name}</span>
              <ChevronRight size={16} />
            </button>
          ))}
        </div>
        <button
          className="outline connect"
          onClick={() => {
            setModal(true);
            setError("");
          }}
        >
          <Plus size={18} />
          Connect agent
        </button>
        <div className="local">
          <Folder size={18} />
          Local workspace
          <span className={`tiny-dot ${online ? "connected" : ""}`} />
        </div>
      </aside>
      <main>
        <header>
          <button
            className="mobile-menu icon"
            aria-label="Open menu"
            onClick={() => setMobile(true)}
          >
            <Menu />
          </button>
          <div>
            <h1>{room?.title}</h1>
            <p>
              {selected.length} agent{selected.length === 1 ? "" : "s"} in this
              chat · {room?.paused ? "paused" : "group conversation"}
            </p>
          </div>
          <div className="discussion-controls">
            <button
              className="outline"
              disabled={
                busy ||
                !online ||
                !!active ||
                !relay ||
                !selected.length ||
                !room?.messages.some((m) => m.role === "user")
              }
              onClick={() => action(() => api(`/rooms/${room.id}/continue`))}
            >
              Continue
            </button>
            <button
              className="outline stop"
              disabled={
                !online ||
                (room?.paused && !roomActive) ||
                roomRuns.some((r) => r.state === "stopping")
              }
              onClick={() => action(() => api(`/rooms/${room.id}/stop`))}
            >
              <Square size={14} fill="currentColor" />
              {roomRuns.some((r) => r.state === "stopping")
                ? "Stopping…"
                : "Stop agents"}
            </button>
          </div>
        </header>
        {!online && (
          <div className="banner" role="alert">
            Connection to A2Ahub lost. Reconnecting…
          </div>
        )}
        {error && !modal && (
          <div className="banner" role="alert">
            <AlertCircle size={18} />
            {error}
            <button
              className="icon"
              aria-label="Dismiss error"
              onClick={() => setError("")}
            >
              <X size={16} />
            </button>
          </div>
        )}
        <section className="chat" aria-label="Messages" aria-live="polite">
          {!room?.messages.length ? (
            <div className="empty">
              <Share2 size={92} strokeWidth={1.7} />
              <h2>Bring your agents to the table.</h2>
              <p>
                Add agents to this chat and start talking.
                <br />
                They reply together. You can jump in anytime.
              </p>
              <div className="suggestions">
                {["Introduce yourself", "What can you help with?"].map((t) => (
                  <button
                    className="outline"
                    key={t}
                    onClick={() => {
                      setText(t);
                      composer.current.focus();
                    }}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="messages">
              {room.messages.map((m) => (
                <article className={`message ${m.role}`} key={m.id}>
                  <div className="avatar">
                    {m.role === "user" ? "Y" : <Share2 size={18} />}
                  </div>
                  <div className="message-body">
                    <div className="message-heading">
                      <strong>{m.name}</strong>
                      <span>
                        {new Date(m.createdAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                      {m.recipients && (
                        <small>to {m.recipients.join(", ")}</small>
                      )}
                    </div>
                    <div className="message-text">
                      {m.text || (
                        <span className="thinking">Waiting for {m.name}…</span>
                      )}
                    </div>
                    <small className={`message-state ${m.state}`}>
                      {m.state === "working" || m.state === "submitted" ? (
                        <>
                          <span className="pulse" /> {m.state}
                        </>
                      ) : (
                        m.state
                      )}
                    </small>
                  </div>
                </article>
              ))}
              <div ref={bottom} />
            </div>
          )}
        </section>
        <div className="compose-wrap">
          {room?.paused ? (
            <div className="run-status paused" role="status">
              {run?.stopNote || "Agents paused."} Continue the discussion, or
              resume to send a new message.
              <button
                className="text-button"
                disabled={busy || roomActive}
                onClick={() => action(() => api(`/rooms/${room.id}/resume`))}
              >
                Resume agents
              </button>
            </div>
          ) : roomActive ? (
            <div className="run-status" role="status">
              <span className="pulse" />
              {talkingIds
                .map((id) => data.agents.find((a) => a.id === id)?.name)
                .join(", ")}{" "}
              replying
              {queuedIds.length > 0 &&
                ` · ${queuedIds.length} waiting for their current reply`}
              · You can keep talking
            </div>
          ) : run ? (
            <div className="run-status" role="status">
              <Check size={14} />
              {run.state === "completed-with-errors"
                ? "Discussion finished with delivery issues"
                : run.state === "stopped"
                  ? "Discussion stopped"
                  : "Discussion finished"}
              {` · ${run.turn}/${run.maxTurns} replies started. `}
              {relay && "Continue for another stretch."}
            </div>
          ) : null}
          {otherRoomActive && (
            <div className="run-status">
              Agents are active in another conversation. Stop them there to
              start here.
            </div>
          )}
          <form className="composer" onSubmit={submit}>
            <div className="recipients">
              <span>In this chat:</span>
              {data.agents.length ? (
                data.agents.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    aria-pressed={selected.includes(a.id)}
                    className={`recipient ${selected.includes(a.id) ? "chosen" : ""}`}
                    disabled={
                      busy ||
                      roomActive ||
                      (!selected.includes(a.id) && selected.length >= 6)
                    }
                    onClick={() => choose(a.id)}
                  >
                    <i className={`dot ${a.status}`} />
                    {a.name}
                    {selected.includes(a.id) && <Check size={13} />}
                  </button>
                ))
              ) : (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setModal(true)}
                >
                  Connect your first agent
                </button>
              )}
            </div>
            <textarea
              ref={composer}
              aria-label="Message"
              placeholder="Write a message…"
              value={text}
              maxLength={12000}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  if (
                    !busy &&
                    online &&
                    !otherRoomActive &&
                    !room?.paused &&
                    text.trim() &&
                    selected.length
                  )
                    e.currentTarget.form.requestSubmit();
                }
              }}
            />
            <div className="composer-footer">
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={relay}
                  disabled={busy || roomActive}
                  onChange={(e) =>
                    action(() => settings({ agentChat: e.target.checked }))
                  }
                />
                <span className="switch" />
                Agents reply to each other
              </label>
              <label className="turns">
                Replies{" "}
                <input
                  aria-label="Reply allowance"
                  type="number"
                  min={Math.max(1, selected.length)}
                  max="6"
                  value={limit}
                  disabled={!relay || busy || roomActive}
                  onChange={(e) =>
                    action(() =>
                      settings({ replyLimit: Number(e.target.value) }),
                    )
                  }
                />
              </label>
              <button
                className="primary send"
                disabled={
                  busy ||
                  !!otherRoomActive ||
                  !!room?.paused ||
                  !online ||
                  !text.trim() ||
                  !selected.length
                }
              >
                <Send size={18} />
                Send message
              </button>
            </div>
          </form>
          <p className="footnote">
            Each message or Continue allows up to{" "}
            {relay ? limit : selected.length} replies. Stop agents pauses this
            chat.
          </p>
        </div>
      </main>
      <aside className={`details ${inspectOpen ? "inspect-open" : ""}`}>
        <button
          className="icon details-close"
          aria-label="Close connection details"
          onClick={() => setInspectOpen(false)}
        >
          <X />
        </button>
        <h2>Conversation controls</h2>
        <div className="mode">
          <MessageCircle size={23} />
          <div>
            <strong>Group chat</strong>
            <p>
              {relay
                ? `Members hear your messages and each other. Up to ${limit} replies per message or Continue, arriving independently.`
                : "Members reply independently to you. Their replies do not trigger other agents."}
            </p>
            <p>
              Stop agents pauses every member. Continue advances the topic;
              Resume agents lets you send a new message.
            </p>
          </div>
        </div>
        <div className="connection">
          <h2>Connection</h2>
          {agent ? (
            <>
              <div className="connection-name">
                <i className={`dot ${agent.status}`} />
                <strong>{agent.name}</strong>
              </div>
              <dl>
                <dt>Endpoint</dt>
                <dd className="endpoint">{agent.url}</dd>
                <dt>Status</dt>
                <dd className={agent.status}>{agent.status}</dd>
                <dt>A2A</dt>
                <dd>{agent.version || "Not checked"}</dd>
                <dt>Replies</dt>
                <dd>{agent.streaming ? "Streaming" : "Request / response"}</dd>
              </dl>
              {agent.error && <p className="warning">{agent.error}</p>}
              <div className="connection-actions">
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => action(() => api(`/agents/${agent.id}/check`))}
                >
                  <RefreshCw size={14} />
                  Check connection
                </button>
                <button
                  className="icon"
                  aria-label={`Remove ${agent.name}`}
                  disabled={busy || !!active}
                  onClick={() =>
                    action(async () => {
                      await api(`/agents/${agent.id}`, null, "DELETE");
                    })
                  }
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </>
          ) : (
            <p>No agents connected yet.</p>
          )}
        </div>
        <p className="adapter-note">
          Agents need an A2A endpoint.
          <br />
          Other tools need an adapter.
        </p>
        <details>
          <summary>How this workspace works</summary>
          <p>
            History and membership are saved on this computer. Only this chat’s
            members receive new messages. Adding an agent does not share old
            history.
          </p>
          <p>
            The reply allowance caps Hub requests, not an agent’s internal tool
            calls or spending. Stop attempts remote cancellation; work already
            started may continue.
          </p>
          <p>
            This Codex task is not an A2A server. Hermes cannot spontaneously
            message it.
          </p>
        </details>
      </aside>
      {modal && (
        <div
          className="modal-backdrop"
          onKeyDown={(e) => {
            if (e.key === "Escape") setModal(false);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
            className="modal"
          >
            <div className="modal-heading">
              <h2 id="modal-title">Connect an agent</h2>
              <button
                className="icon"
                aria-label="Close dialog"
                onClick={() => setModal(false)}
              >
                <X />
              </button>
            </div>
            <p>Discover an agent from its A2A endpoint.</p>
            <form onSubmit={addAgent}>
              <label htmlFor="endpoint">Agent endpoint</label>
              <input
                id="endpoint"
                type="url"
                required
                placeholder="http://127.0.0.1:9900/"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
              <label htmlFor="credential">
                Credential environment variable <small>(optional)</small>
              </label>
              <input
                id="credential"
                placeholder="A2AHUB_TOKEN_MY_AGENT"
                value={tokenEnv}
                onChange={(e) => setTokenEnv(e.target.value)}
              />
              <p className="hint">
                For bearer authentication, set this variable on the server
                before starting A2Ahub. Enter the variable name here, never the
                secret.
              </p>
              {error && (
                <p className="banner" role="alert">
                  {error}
                </p>
              )}
              <button className="primary" disabled={busy}>
                {busy ? "Discovering…" : "Discover & connect"}
                <ChevronRight size={16} />
              </button>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);

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
    [selected, setSelected] = useState([]),
    [text, setText] = useState(""),
    [relay, setRelay] = useState(false),
    [limit, setLimit] = useState(2),
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
        setSelected(d.agents.length ? [d.agents[0].id] : []);
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
  function choose(id) {
    setSelected((s) =>
      s.includes(id) ? s.filter((x) => x !== id) : [...s, id],
    );
  }
  async function submit(e) {
    e.preventDefault();
    await action(async () => {
      await api("/runs", {
        roomId: room.id,
        agentIds: selected,
        text,
        relay,
        maxTurns: limit,
      });
      setText("");
    });
  }
  const addAgent = (e) => {
    e.preventDefault();
    action(async () => {
      const a = await api("/agents", { url, tokenEnv });
      setSelected((s) => [...s, a.id]);
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
            <p>A shared space to think together</p>
          </div>
          <button
            className="outline stop"
            disabled={!active || active.state === "stopping"}
            onClick={() => action(() => api(`/runs/${active.id}/stop`))}
          >
            <Square size={14} fill="currentColor" />
            {active?.state === "stopping" ? "Stopping…" : "Stop"}
          </button>
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
                Choose a recipient and start a conversation.
                <br />
                You stay in control of every turn.
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
          {run && (
            <div className="run-status" role="status">
              {run.state === "running" ? (
                <>
                  <span className="pulse" />
                  Reply {run.turn} of {run.maxTurns} ·{" "}
                  {data.agents.find((a) => a.id === run.agentId)?.name}
                </>
              ) : (
                <>
                  <Check size={14} />
                  {run.state} · {run.turn} of {run.maxTurns} replies
                  {run.stopNote && ` · ${run.stopNote}`}
                </>
              )}
            </div>
          )}
          <form className="composer" onSubmit={submit}>
            <div className="recipients">
              <span>To:</span>
              {data.agents.length ? (
                data.agents.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    aria-pressed={selected.includes(a.id)}
                    className={`recipient ${selected.includes(a.id) ? "chosen" : ""}`}
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
                  if (!busy && !active && text.trim() && selected.length)
                    e.currentTarget.form.requestSubmit();
                }
              }}
            />
            <div className="composer-footer">
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={relay}
                  onChange={(e) => setRelay(e.target.checked)}
                />
                <span className="switch" />
                Agent conversation
              </label>
              <label className="turns">
                Max turns{" "}
                <input
                  aria-label="Max turns"
                  type="number"
                  min="2"
                  max="6"
                  value={limit}
                  disabled={!relay}
                  onChange={(e) => setLimit(Number(e.target.value))}
                />
              </label>
              <button
                className="primary send"
                disabled={
                  busy ||
                  !!active ||
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
            Manual by default. Agent conversations always have a turn limit.
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
            <strong>{relay ? "Agent conversation" : "Direct message"}</strong>
            <p>
              {relay
                ? `${limit} total replies, rotating through selected agents. Each reply goes to the next agent.`
                : "Only selected agents receive your message."}
            </p>
            {relay && selected.length < 2 && (
              <p className="warning">Select at least two agents.</p>
            )}
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
                      setSelected((s) => s.filter((x) => x !== agent.id));
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
            History is saved on this computer. Agents receive your addressed
            message and their own conversation context.
          </p>
          <p>
            The turn limit caps Hub requests, not an agent’s internal tool calls
            or spending. Stop attempts remote cancellation; work already started
            may continue.
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

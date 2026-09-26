import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Share2,
  Plus,
  MessageCircle,
  Square,
  Send,
  ChevronRight,
  X,
  RefreshCw,
  Trash2,
  Menu,
  Check,
  AlertCircle,
  Pencil,
} from "lucide-react";
import "./style.css";
import { OwnerGate, AccessPage } from "./access.jsx";
import {
  AGENT_DRAG_TYPE,
  AgentDirectory,
  AgentPicker,
  beginAgentPointerDrag,
  connectionStatus,
  Dialog,
  Navigation,
  pages,
  SettingsPage,
  statusText,
} from "./workspace.jsx";

function readStored(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function storeLocal(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Storage can be unavailable in private browsing. */
  }
}
async function api(url, body, method = "POST") {
  const r = await fetch("/api" + url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const d = await r.json();
  if (r.status === 401) window.dispatchEvent(new Event("a2ahub-auth-required"));
  if (!r.ok) throw new Error(d.error || "Request failed");
  return d;
}
function App() {
  const [data, setData] = useState(null),
    [roomId, setRoomId] = useState(() => readStored("a2ahub-room", "")),
    [drafts, setDrafts] = useState(() => readStored("a2ahub-drafts", {})),
    [path, setPath] = useState(location.pathname),
    [modal, setModal] = useState(false),
    [picker, setPicker] = useState(false),
    [rename, setRename] = useState(false),
    [roomTitle, setRoomTitle] = useState(""),
    [dropping, setDropping] = useState(false),
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
    pageHeading = useRef(null),
    menuButton = useRef(null),
    inspector = useRef(null),
    checkingAuth = useRef(false),
    acceptDrop = useRef(null);
  useEffect(() => {
    const dropped = (event) => acceptDrop.current?.(event.detail);
    window.addEventListener("a2ahub-agent-drop", dropped);
    return () => window.removeEventListener("a2ahub-agent-drop", dropped);
  }, []);
  function navigate(next) {
    history.pushState({}, "", next);
    setPath(next);
    setMobile(false);
    setInspectOpen(false);
    setPicker(false);
    setModal(false);
    setRename(false);
    setError("");
  }
  useEffect(() => {
    const change = () => {
      setPath(location.pathname);
      setMobile(false);
      setInspectOpen(false);
      setPicker(false);
      setModal(false);
      setRename(false);
    };
    window.addEventListener("popstate", change);
    return () => window.removeEventListener("popstate", change);
  }, []);
  useEffect(() => storeLocal("a2ahub-room", roomId), [roomId]);
  useEffect(() => storeLocal("a2ahub-drafts", drafts), [drafts]);
  useEffect(() => {
    pageHeading.current?.focus();
  }, [path]);
  useEffect(() => {
    if (!mobile && !inspectOpen) return;
    const previous = document.activeElement;
    if (inspectOpen) inspector.current?.focus();
    else document.querySelector(".sidebar .mobile-close")?.focus();
    const escape = (event) => {
      if (event.key !== "Escape" || modal || picker) return;
      setMobile(false);
      setInspectOpen(false);
    };
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("keydown", escape);
      if (mobile) menuButton.current?.focus();
      else if (previous?.isConnected) previous.focus();
    };
  }, [mobile, inspectOpen, modal, picker]);
  useEffect(() => {
    let cancelled = false;
    let receivedStream = false;
    api("/state", null, "GET")
      .then((d) => {
        if (!cancelled && !receivedStream) setData(d);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e.message);
          setOnline(false);
        }
      });
    const es = new EventSource("/api/events");
    es.addEventListener("auth-expired", () =>
      window.dispatchEvent(new Event("a2ahub-auth-required")),
    );
    es.onmessage = (e) => {
      try {
        receivedStream = true;
        setData(JSON.parse(e.data));
        setOnline(true);
      } catch {
        setError(
          "The workspace update could not be read. Refresh the page to reconnect.",
        );
      }
    };
    es.onerror = async () => {
      setOnline(false);
      if (checkingAuth.current) return;
      checkingAuth.current = true;
      try {
        const session = await fetch("/auth/session").then((r) => r.json());
        if (!cancelled && !session.authenticated)
          window.dispatchEvent(new Event("a2ahub-auth-required"));
      } catch {
        /* EventSource will retry a server outage. */
      } finally {
        checkingAuth.current = false;
      }
    };
    return () => {
      cancelled = true;
      es.close();
    };
  }, []);
  const participants =
    data?.participants ||
    data?.agents?.map((a) => ({ ...a, kind: "endpoint" })) ||
    [];
  const room = data?.rooms.find((r) => r.id === roomId) || data?.rooms[0],
    agent = participants.find((a) => a.id === inspected) || participants[0];
  const text = drafts[room?.id] || "";
  const setText = (value) => {
    if (room) setDrafts((old) => ({ ...old, [room.id]: value }));
  };
  const ownerName = data?.profile?.displayName || "You";
  const pageTitle =
    pages.find((p) => p.path === path)?.title || "Page not found";
  const active = data?.runs.find((r) =>
      ["running", "stopping"].includes(r.state),
    ),
    run = [...(data?.runs || [])].reverse().find((r) => r.roomId === room?.id);
  const selected = room?.agentIds || [],
    members = participants.filter((a) => selected.includes(a.id)),
    relay = room?.agentChat ?? true,
    limit = room?.replyLimit || 6,
    roomRuns = (data?.runs || []).filter(
      (r) => r.roomId === room?.id && ["running", "stopping"].includes(r.state),
    ),
    roomActive = roomRuns.length > 0,
    otherRoomActive = active && active.roomId !== room?.id,
    talkingIds = [...new Set(roomRuns.flatMap((r) => r.activeAgentIds))],
    queuedIds = [...new Set(roomRuns.flatMap((r) => r.queuedAgentIds))];
  const waitingConversations = members.filter(
    (a) =>
      a.receiver?.kind === "session" && connectionStatus(a) === "unchecked",
  );
  const offlineConversations = members.filter(
    (a) =>
      a.receiver?.kind === "session" &&
      !["connected", "unchecked"].includes(connectionStatus(a)),
  );
  const offlineConnectors = members.filter(
    (a) =>
      a.kind === "inbound" &&
      a.receiver?.kind !== "session" &&
      a.status !== "connected",
  );
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [room?.messages.length, room?.messages.at(-1)?.text]);
  async function action(fn) {
    setError("");
    setBusy(true);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  function settings(change) {
    return api(`/rooms/${room.id}`, change, "PATCH");
  }
  function choose(id, include = !selected.includes(id)) {
    if (!room || busy || roomActive || !participants.some((a) => a.id === id))
      return;
    if (include && (selected.includes(id) || selected.length >= 6)) return;
    const agentIds = include
      ? [...selected, id]
      : selected.filter((x) => x !== id);
    return action(async () => {
      await settings({
        agentIds,
        replyLimit: Math.max(limit, agentIds.length),
      });
      setData(await api("/state", null, "GET"));
    });
  }
  acceptDrop.current = (detail) => {
    if (path === "/" && detail?.roomId === room?.id)
      choose(detail.agentId, true);
  };
  async function submit(e) {
    e.preventDefault();
    await action(async () => {
      await api("/runs", {
        roomId: room.id,
        text,
      });
      setDrafts((old) =>
        old[room.id] === text ? { ...old, [room.id]: "" } : old,
      );
    });
  }
  const addAgent = (e) => {
    e.preventDefault();
    action(async () => {
      const a = await api("/agents", { url, tokenEnv });
      setInspected(a.id);
      setData(await api("/state", null, "GET"));
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
    <div className={`app ${path === "/" ? "" : "managed-page"}`}>
      <aside
        id="workspace-sidebar"
        className={`sidebar ${mobile ? "open" : ""}`}
      >
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
        <Navigation path={path} navigate={navigate} />
        <button
          className="primary new"
          onClick={() =>
            action(async () => {
              const r = await api("/rooms");
              setRoomId(r.id);
              navigate("/");
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
                navigate("/");
              }}
            >
              <MessageCircle size={19} />
              <span>{r.title}</span>
            </button>
          ))}
        </nav>
        <h3>Agent directory</h3>
        <div className="agents">
          {participants.map((a) => (
            <button
              className="agent-row"
              key={a.id}
              draggable={false}
              data-agent-draggable="true"
              onPointerDown={(e) => beginAgentPointerDrag(e, a)}
              onDragStart={(e) => e.preventDefault()}
              title={`${a.name} · ${statusText(a)}. Drag into In this chat to add.`}
              onClick={() => {
                setInspected(a.id);
                setInspectOpen(true);
                setMobile(false);
              }}
            >
              <i className={`dot ${connectionStatus(a)}`} />
              <span>{a.name}</span>
              <ChevronRight size={16} />
            </button>
          ))}
          {!participants.length && (
            <p className="sidebar-empty">Approved agents will appear here.</p>
          )}
        </div>
        <button
          className="outline connect"
          onClick={() => {
            navigate("/agents");
          }}
        >
          <Plus size={18} />
          Browse agents
        </button>
        <div className="local">
          <div className="owner-avatar">
            {ownerName.slice(0, 1).toUpperCase()}
          </div>
          <div>
            <strong>{ownerName}</strong>
            <small>Workspace owner</small>
          </div>
          <span className={`tiny-dot ${online ? "connected" : ""}`} />
        </div>
      </aside>
      <main>
        <header>
          <button
            className="mobile-menu icon"
            ref={menuButton}
            aria-label="Open menu"
            aria-expanded={mobile}
            aria-controls="workspace-sidebar"
            onClick={() => setMobile(true)}
          >
            <Menu />
          </button>
          <div>
            <h1 ref={pageHeading} tabIndex={-1}>
              {path === "/" ? room?.title || "Conversations" : pageTitle}
            </h1>
            <p>
              {path === "/"
                ? `${selected.length} agent${selected.length === 1 ? "" : "s"} in this chat · ${room?.paused ? "paused" : "group conversation"}`
                : "Your local A2A workspace"}
            </p>
          </div>
          {path === "/" && room && (
            <button
              className="icon rename-conversation"
              aria-label="Rename conversation"
              title="Rename conversation"
              disabled={busy || roomActive || !online}
              onClick={() => {
                setRoomTitle(room.title);
                setError("");
                setRename(true);
              }}
            >
              <Pencil size={17} />
            </button>
          )}
          <button
            className="owner-pill"
            onClick={() => navigate("/settings")}
            title="Your owner profile"
          >
            <span className="owner-avatar">
              {ownerName.slice(0, 1).toUpperCase()}
            </span>
            <span>{ownerName}</span>
          </button>
          {path === "/" && room && (
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
          )}
        </header>
        {!online && (
          <div className="banner" role="alert">
            Connection to A2Ahub lost. Reconnecting…
          </div>
        )}
        {error && !modal && !picker && !rename && (
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
        {path === "/agents" && (
          <AgentDirectory
            participants={participants}
            selected={selected}
            roomTitle={room?.title}
            roomId={room?.id}
            agentConnectionUrl={
              data.agentConnectionUrl || data.agentOrigin || location.origin
            }
            setupAgentName={agent?.kind === "inbound" ? agent.name : undefined}
            busy={busy || !online}
            locked={roomActive}
            onChoose={choose}
            onConnect={() => {
              setError("");
              setModal(true);
            }}
            onInspect={(id) => {
              setInspected(id);
              setInspectOpen(true);
            }}
            onAccess={() => navigate("/access")}
            onConversation={() => navigate("/")}
          />
        )}
        {path === "/access" && (
          <AccessPage
            agentOrigin={data.agentOrigin}
            onAgents={() => navigate("/agents")}
          />
        )}
        {path === "/settings" && (
          <SettingsPage
            profile={data.profile}
            busy={busy || !online}
            onSave={(displayName) =>
              action(async () => {
                await api("/profile", { displayName }, "PATCH");
                setData(await api("/state", null, "GET"));
              })
            }
            onLogout={() =>
              action(async () => {
                const r = await fetch("/auth/logout", { method: "POST" });
                if (!r.ok)
                  throw new Error("Sign-out failed. Please try again.");
                window.dispatchEvent(new Event("a2ahub-auth-required"));
              })
            }
          />
        )}
        {!pages.some((p) => p.path === path) && (
          <section className="page-content page-empty">
            <h2>This page isn’t here</h2>
            <p>Your conversations and agents are still available.</p>
            <button className="primary" onClick={() => navigate("/")}>
              Go to conversations
            </button>
          </section>
        )}
        {path === "/" && (
          <>
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
                    {["Introduce yourself", "What can you help with?"].map(
                      (t) => (
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
                      ),
                    )}
                  </div>
                </div>
              ) : (
                <div className="messages">
                  {room.messages.map((m) => (
                    <article className={`message ${m.role}`} key={m.id}>
                      <div className="avatar">
                        {m.role === "user" ? (
                          (m.name || ownerName).slice(0, 1).toUpperCase()
                        ) : (
                          <Share2 size={18} />
                        )}
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
                            <span className="thinking">
                              Waiting for {m.name}…
                            </span>
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
              {waitingConversations.length > 0 && (
                <p className="connector-hint" role="status">
                  Waiting for{" "}
                  {waitingConversations.map((a) => a.name).join(", ")} to
                  confirm their open conversation.
                </p>
              )}
              {offlineConversations.length > 0 && (
                <p className="connector-hint" role="status">
                  {offlineConversations.map((a) => a.name).join(", ")} have an
                  offline conversation. Open it and connect again.{" "}
                  <button
                    className="text-button"
                    onClick={() => navigate("/agents")}
                  >
                    Conversation setup
                  </button>
                </p>
              )}
              {offlineConnectors.length > 0 && (
                <p className="connector-hint" role="status">
                  {offlineConnectors.map((a) => a.name).join(", ")} can read and
                  post, but their connector is offline.{" "}
                  <button
                    className="text-button"
                    onClick={() => navigate("/access")}
                  >
                    Agent setup
                  </button>
                </p>
              )}
              {room?.paused ? (
                <div className="run-status paused" role="status">
                  {run?.stopNote || "Agents paused."} Continue the discussion,
                  or resume to send a new message.
                  <button
                    className="text-button"
                    disabled={busy || roomActive}
                    onClick={() =>
                      action(() => api(`/rooms/${room.id}/resume`))
                    }
                  >
                    Resume agents
                  </button>
                </div>
              ) : roomActive ? (
                <div className="run-status" role="status">
                  <span className="pulse" />
                  {talkingIds
                    .map((id) => participants.find((a) => a.id === id)?.name)
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
              <form
                className={`composer ${dropping ? "drag-over" : ""}`}
                data-agent-dropzone={
                  !busy && !roomActive && online && selected.length < 6
                    ? "enabled"
                    : "disabled"
                }
                data-room-id={room?.id}
                onSubmit={submit}
                onDragOver={(e) => {
                  if (
                    !busy &&
                    !roomActive &&
                    e.dataTransfer.types.includes(AGENT_DRAG_TYPE)
                  ) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "copy";
                    setDropping(true);
                  }
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget))
                    setDropping(false);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  setDropping(false);
                  choose(e.dataTransfer.getData(AGENT_DRAG_TYPE), true);
                }}
              >
                <div className="recipients" aria-label="Conversation members">
                  <span>In this chat:</span>
                  {members.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      aria-label={`Remove ${a.name} from this chat`}
                      title={`Remove ${a.name} from this conversation only`}
                      className="recipient chosen"
                      disabled={busy || roomActive || !online}
                      onClick={() => choose(a.id, false)}
                    >
                      <i className={`dot ${connectionStatus(a)}`} />
                      {a.name}
                      <X size={13} />
                    </button>
                  ))}
                  <button
                    type="button"
                    className="add-member"
                    aria-label="Add agents to this chat"
                    title="Choose agents from your directory"
                    disabled={!room || !online}
                    onClick={() => {
                      setError("");
                      setPicker(true);
                    }}
                  >
                    <Plus size={17} />
                    {!members.length && <span>Add agents</span>}
                  </button>
                  {dropping && (
                    <span className="drop-hint">Drop to add to this chat</span>
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
                {relay ? limit : selected.length} replies. Stop agents pauses
                this chat.
              </p>
            </div>
          </>
        )}
      </main>
      <aside
        ref={inspector}
        tabIndex={-1}
        aria-label="Agent details"
        className={`details ${inspectOpen ? "inspect-open" : ""}`}
      >
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
                <i className={`dot ${connectionStatus(agent)}`} />
                <strong>{agent.name}</strong>
              </div>
              <dl>
                <dt>Connection</dt>
                <dd className="endpoint">
                  {agent.kind === "inbound" ? "Approved A2A agent" : agent.url}
                </dd>
                <dt>Status</dt>
                <dd className={connectionStatus(agent)}>{statusText(agent)}</dd>
                {agent.receiver?.kind === "session" && (
                  <>
                    <dt>Conversation ID</dt>
                    <dd className="endpoint">{agent.receiver.sessionId}</dd>
                    <dt>Hub conversation</dt>
                    <dd>
                      {data.rooms.find((r) => r.id === agent.receiver.roomId)
                        ?.title || "Unavailable conversation"}
                    </dd>
                    <dt>Last receipt</dt>
                    <dd>
                      {agent.receiver.lastReceiptAt
                        ? new Date(
                            agent.receiver.lastReceiptAt,
                          ).toLocaleString()
                        : "Waiting for confirmation"}
                    </dd>
                  </>
                )}
                <dt>A2A</dt>
                <dd>
                  {agent.kind === "inbound"
                    ? "1.0"
                    : agent.version || "Not checked"}
                </dd>
                <dt>Replies</dt>
                <dd>
                  {agent.kind === "inbound"
                    ? agent.receiver?.kind === "session"
                      ? "Attached conversation"
                      : "Approved connector"
                    : agent.streaming
                      ? "Streaming"
                      : "Request / response"}
                </dd>
              </dl>
              {agent.error && <p className="warning">{agent.error}</p>}
              <div className="connection-actions">
                {agent.kind === "inbound" ? (
                  <>
                    <button
                      className="text-button"
                      onClick={() => {
                        setInspectOpen(false);
                        navigate("/agents");
                      }}
                    >
                      Connect an open conversation
                    </button>
                    <button
                      className="text-button"
                      onClick={() => navigate("/access")}
                    >
                      Manage access
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() =>
                        action(() => api(`/agents/${agent.id}/check`))
                      }
                    >
                      <RefreshCw size={14} />
                      Check connection
                    </button>
                    <button
                      className="icon"
                      aria-label={`Delete ${agent.name} from directory`}
                      disabled={busy || !!active}
                      onClick={() =>
                        action(async () => {
                          await api(`/agents/${agent.id}`, null, "DELETE");
                        })
                      }
                    >
                      <Trash2 size={15} />
                    </button>
                  </>
                )}
              </div>
            </>
          ) : (
            <p>No agents connected yet.</p>
          )}
        </div>
        <p className="adapter-note">
          Approved agents are reusable across chats. Add or remove room members
          with the plus button; manage credentials on Access.
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
            Automatic replies require a running endpoint or connector for the
            enrolled agent’s harness.
          </p>
        </details>
      </aside>
      {picker && (
        <AgentPicker
          participants={participants}
          selected={selected}
          roomTitle={room?.title}
          busy={busy || !online}
          locked={roomActive}
          error={error}
          onChoose={choose}
          onClose={() => setPicker(false)}
          onAccess={() => {
            setPicker(false);
            navigate("/access");
          }}
        />
      )}
      {rename && (
        <Dialog
          title="Rename conversation"
          onClose={() => setRename(false)}
          initialFocus="#conversation-title"
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              action(async () => {
                await settings({ title: roomTitle.trim() });
                setData(await api("/state", null, "GET"));
                setRename(false);
              });
            }}
          >
            <label htmlFor="conversation-title">Conversation name</label>
            <input
              id="conversation-title"
              value={roomTitle}
              maxLength={100}
              required
              onChange={(event) => setRoomTitle(event.target.value)}
            />
            {error && (
              <p className="banner" role="alert">
                {error}
              </p>
            )}
            <button className="primary" disabled={busy || !roomTitle.trim()}>
              {busy ? "Saving…" : "Save name"}
            </button>
          </form>
        </Dialog>
      )}
      {modal && (
        <Dialog
          title="Connect an endpoint"
          onClose={() => setModal(false)}
          initialFocus="#endpoint"
        >
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
              For bearer authentication, set this variable on the server before
              starting A2Ahub. Enter the variable name here, never the secret.
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
        </Dialog>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")).render(
  <OwnerGate>
    <App />
  </OwnerGate>,
);

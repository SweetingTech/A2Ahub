import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Plus,
  MessageCircle,
  Square,
  Send,
  ChevronRight,
  X,
  RefreshCw,
  Trash2,
  Menu as MenuIcon,
  Check,
  AlertCircle,
  Pencil,
  Palette,
  Play,
  PanelRight,
  Archive,
  Minus,
} from "lucide-react";
import "@fontsource-variable/instrument-sans/wght.css";
import "@fontsource-variable/bricolage-grotesque/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "@fontsource/atkinson-hyperlegible/latin-400.css";
import "@fontsource/atkinson-hyperlegible/latin-700.css";
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
  statusText,
} from "./workspace.jsx";
import { api, readStored, storeLocal } from "./api.js";
import {
  applyAppearance,
  loadAppearance,
  saveAppearance,
} from "./appearance.js";
import { Avatar, BurstMeter, StatePill, when } from "./ui.jsx";
import { ConversationList } from "./conversations.jsx";
import { FolderDialog, LibraryPage } from "./library.jsx";
import { AdminPage } from "./admin.jsx";
import { SettingsPage } from "./settings.jsx";

// Apply saved appearance before the first paint to avoid a flash of the
// default theme for people who rely on high contrast or large text.
applyAppearance(loadAppearance());

const BrandMark = ({ size = 22 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <circle cx="18" cy="5" r="2.6" />
    <circle cx="6" cy="12" r="2.6" />
    <circle cx="18" cy="19" r="2.6" />
    <path d="M8.3 10.7l7.4-4.3M8.3 13.3l7.4 4.3" />
  </svg>
);

function App() {
  const [data, setData] = useState(null),
    [roomId, setRoomId] = useState(() => readStored("a2ahub-room", "")),
    [drafts, setDrafts] = useState(() => readStored("a2ahub-drafts", {})),
    [path, setPath] = useState(location.pathname),
    [search, setSearch] = useState(location.search),
    [modal, setModal] = useState(false),
    [picker, setPicker] = useState(false),
    [renameRoom, setRenameRoom] = useState(null),
    [roomTitle, setRoomTitle] = useState(""),
    [folderDialog, setFolderDialog] = useState(false),
    [dropping, setDropping] = useState(false),
    [url, setUrl] = useState(""),
    [tokenEnv, setTokenEnv] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [inspected, setInspected] = useState(""),
    [mobile, setMobile] = useState(false),
    [online, setOnline] = useState(true),
    [inspectOpen, setInspectOpen] = useState(false),
    [detailsTab, setDetailsTab] = useState(() =>
      readStored("a2ahub-details-tab", "room"),
    ),
    [appearance, setAppearanceState] = useState(loadAppearance);
  const bottom = useRef(null),
    composer = useRef(null),
    pageHeading = useRef(null),
    menuButton = useRef(null),
    inspector = useRef(null),
    searchBox = useRef(null),
    checkingAuth = useRef(false),
    acceptDrop = useRef(null);
  const query = new URLSearchParams(search);
  function setAppearance(next) {
    setAppearanceState(next);
    saveAppearance(next);
    applyAppearance(next);
  }
  useEffect(() => {
    if (!appearance.followSystem || typeof matchMedia !== "function") return;
    const media = matchMedia("(prefers-color-scheme: dark)");
    const change = () => applyAppearance(appearance);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, [appearance]);
  useEffect(() => {
    const dropped = (event) => acceptDrop.current?.(event.detail);
    window.addEventListener("a2ahub-agent-drop", dropped);
    return () => window.removeEventListener("a2ahub-agent-drop", dropped);
  }, []);
  function navigate(next) {
    history.pushState({}, "", next);
    const target = new URL(next, location.origin);
    setPath(target.pathname);
    setSearch(target.search);
    setMobile(false);
    setInspectOpen(false);
    setPicker(false);
    setModal(false);
    setRenameRoom(null);
    setError("");
  }
  useEffect(() => {
    const change = () => {
      setPath(location.pathname);
      setSearch(location.search);
      setMobile(false);
      setInspectOpen(false);
      setPicker(false);
      setModal(false);
      setRenameRoom(null);
    };
    window.addEventListener("popstate", change);
    return () => window.removeEventListener("popstate", change);
  }, []);
  useEffect(() => storeLocal("a2ahub-room", roomId), [roomId]);
  useEffect(() => storeLocal("a2ahub-drafts", drafts), [drafts]);
  useEffect(() => storeLocal("a2ahub-details-tab", detailsTab), [detailsTab]);
  useEffect(() => {
    pageHeading.current?.focus();
  }, [path]);
  // Ctrl/Cmd+K jumps to conversation search from anywhere.
  useEffect(() => {
    function shortcut(event) {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k")
        return;
      if (modal || picker || renameRoom || folderDialog) return;
      event.preventDefault();
      if (location.pathname !== "/") navigate("/");
      if (window.matchMedia?.("(max-width: 700px)").matches) setMobile(true);
      requestAnimationFrame(() => searchBox.current?.focus());
    }
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, [modal, picker, renameRoom, folderDialog]);
  useEffect(() => {
    if (!mobile && !inspectOpen) return;
    const previous = document.activeElement;
    if (inspectOpen) inspector.current?.focus();
    else document.querySelector(".sidebar .mobile-close")?.focus();
    const escape = (event) => {
      if (event.key !== "Escape" || modal || picker) return;
      if (document.querySelector(".menu")) return;
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
  const rooms = data?.rooms || [],
    folders = data?.folders || [],
    runs = data?.runs || [];
  const room =
      rooms.find((r) => r.id === roomId) || rooms.find((r) => !r.archived),
    agent = participants.find((a) => a.id === inspected) || participants[0];
  const archived = !!room?.archived;
  const text = drafts[room?.id] || "";
  const setText = (value) => {
    if (room) setDrafts((old) => ({ ...old, [room.id]: value }));
  };
  const ownerName = data?.profile?.displayName || "You";
  const pageTitle =
    pages.find((p) => p.path === path)?.title || "Page not found";
  const active = runs.find((r) => ["running", "stopping"].includes(r.state)),
    run = [...runs].reverse().find((r) => r.roomId === room?.id);
  const selected = room?.agentIds || [],
    members = participants.filter((a) => selected.includes(a.id)),
    relay = room?.agentChat ?? true,
    limit = room?.replyLimit || 6,
    roomRuns = runs.filter(
      (r) => r.roomId === room?.id && ["running", "stopping"].includes(r.state),
    ),
    roomActive = roomRuns.length > 0,
    otherRoomActive = active && active.roomId !== room?.id,
    talkingIds = [...new Set(roomRuns.flatMap((r) => r.activeAgentIds))],
    queuedIds = [...new Set(roomRuns.flatMap((r) => r.queuedAgentIds))];
  const meterRun = roomRuns.at(-1) || run;
  const nameOf = (id) => participants.find((a) => a.id === id)?.name || "Agent";
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
    bottom.current?.scrollIntoView({
      behavior: appearance.reduceMotion ? "auto" : "smooth",
    });
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
  function settings(change, target = room) {
    return api(`/rooms/${target.id}`, change, "PATCH");
  }
  function choose(id, include = !selected.includes(id)) {
    if (
      !room ||
      archived ||
      busy ||
      roomActive ||
      !participants.some((a) => a.id === id)
    )
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
  const openRoom = (id) => {
    setRoomId(id);
    navigate("/");
  };
  const newConversation = () =>
    action(async () => {
      const r = await api("/rooms");
      setRoomId(r.id);
      navigate("/");
      requestAnimationFrame(() => composer.current?.focus());
    });
  const canSend =
    !busy &&
    online &&
    !otherRoomActive &&
    !room?.paused &&
    !archived &&
    text.trim() &&
    selected.length;
  if (!data)
    return (
      <div className="loading">
        <span className="brand-mark large">
          <BrandMark size={34} />
        </span>
        Connecting to your local workspace…
        {!online && <p>Server unavailable. Start A2Ahub with npm start.</p>}
      </div>
    );
  const badges = {
    "/access": data.pendingRequests || 0,
  };
  const chatPage = path === "/";
  return (
    <div className={`app ${chatPage ? "chat-page" : "managed-page"}`}>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="rail" aria-label="Workspace navigation">
        <button
          className="brand-mark"
          aria-label="A2Ahub conversations"
          onClick={() => navigate("/")}
        >
          <BrandMark />
        </button>
        <Navigation
          path={path}
          navigate={navigate}
          badges={badges}
          className="rail-nav"
        />
        <div className="rail-spacer" />
        <button
          className="rail-button"
          aria-label="Appearance and reading settings"
          title="Appearance & reading"
          onClick={() => navigate("/settings?tab=appearance")}
        >
          <Palette size={20} />
        </button>
        <button
          className="rail-avatar"
          aria-label={`Owner profile: ${ownerName}`}
          title="Your profile"
          onClick={() => navigate("/settings")}
        >
          {ownerName.slice(0, 1).toUpperCase()}
        </button>
      </aside>
      <aside
        id="workspace-sidebar"
        className={`sidebar ${mobile ? "open" : ""}`}
        aria-label="Conversations and agents"
      >
        <div className="sidebar-head">
          <span className="wordmark">A2Ahub</span>
          <button
            className="primary icon-primary"
            aria-label="New conversation"
            title="New conversation"
            disabled={busy || !online}
            onClick={newConversation}
          >
            <Plus size={18} />
          </button>
          <button
            className="mobile-close icon"
            aria-label="Close menu"
            onClick={() => setMobile(false)}
          >
            <X />
          </button>
        </div>
        <ConversationList
          rooms={rooms}
          folders={folders}
          runs={runs}
          selectedId={chatPage ? room?.id : undefined}
          busy={busy || !online}
          searchRef={searchBox}
          onSelect={openRoom}
          onRename={(r) => {
            setRoomTitle(r.title);
            setError("");
            setRenameRoom(r);
          }}
          onPin={(r) => action(() => settings({ pinned: !r.pinned }, r))}
          onArchive={(r) => action(() => api(`/rooms/${r.id}/archive`))}
          onMove={(r, folderId) => action(() => settings({ folderId }, r))}
          onNewFolder={() => {
            setError("");
            setFolderDialog(true);
          }}
          onLibrary={() =>
            navigate(
              rooms.some((r) => r.archived)
                ? "/library?view=archived"
                : "/library",
            )
          }
        />
        <div className="section-heading">
          <h2>Agent directory</h2>
          <span className="section-note">
            {
              participants.filter((a) => connectionStatus(a) === "connected")
                .length
            }{" "}
            of {participants.length} online
          </span>
        </div>
        <div className="agents">
          {participants.map((a) => (
            <button
              className="agent-row"
              key={a.id}
              draggable={false}
              data-agent-draggable="true"
              onPointerDown={(e) => beginAgentPointerDrag(e, a)}
              onDragStart={(e) => e.preventDefault()}
              title={`${a.name} · ${statusText(a)}. Drag into the chat to add.`}
              onClick={() => {
                setInspected(a.id);
                setDetailsTab("agent");
                setInspectOpen(true);
                setMobile(false);
              }}
            >
              <Avatar name={a.name} size="sm" />
              <span className="agent-name">{a.name}</span>
              <span className={`status-word ${connectionStatus(a)}`}>
                <i className={`dot ${connectionStatus(a)}`} />
                <span className="status-text">
                  {connectionStatus(a) === "connected"
                    ? "online"
                    : connectionStatus(a) === "unchecked"
                      ? "waiting"
                      : "offline"}
                </span>
              </span>
            </button>
          ))}
          {!participants.length && (
            <p className="sidebar-empty">Approved agents will appear here.</p>
          )}
        </div>
        <button
          className="text-button browse"
          onClick={() => navigate("/agents")}
        >
          <Plus size={16} />
          Browse agents
        </button>
        <div className="hub-status">
          <span className={`tiny-dot ${online ? "connected" : "offline"}`} />
          <span>{online ? "Hub online · loopback" : "Reconnecting…"}</span>
          <code>{location.port ? `:${location.port}` : ""}</code>
        </div>
      </aside>
      <main id="main-content">
        <header className="page-header">
          <button
            className="mobile-menu icon"
            ref={menuButton}
            aria-label="Open conversations"
            aria-expanded={mobile}
            aria-controls="workspace-sidebar"
            onClick={() => setMobile(true)}
          >
            <MenuIcon />
          </button>
          <div className="title-block">
            <div className="title-line">
              <h1 ref={pageHeading} tabIndex={-1}>
                {chatPage ? room?.title || "Conversations" : pageTitle}
              </h1>
              {chatPage && room && (
                <button
                  className="icon rename-conversation"
                  aria-label="Rename conversation"
                  title="Rename conversation"
                  disabled={busy || roomActive || !online}
                  onClick={() => {
                    setRoomTitle(room.title);
                    setError("");
                    setRenameRoom(room);
                  }}
                >
                  <Pencil size={16} />
                </button>
              )}
            </div>
            <p>
              {chatPage && room
                ? archived
                  ? "Archived · read-only"
                  : `${selected.length} agent${selected.length === 1 ? "" : "s"} · ${room.paused ? "paused" : relay ? "agents reply to each other" : "replies to you only"}`
                : "Your local A2A workspace"}
            </p>
          </div>
          {chatPage && room && !archived && (
            <div className="discussion-controls">
              {meterRun && (
                <BurstMeter
                  used={meterRun.turn}
                  total={meterRun.maxTurns}
                  active={roomActive}
                />
              )}
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
                title="Advance the discussion for another bounded stretch"
                onClick={() => action(() => api(`/rooms/${room.id}/continue`))}
              >
                <Play size={14} fill="currentColor" />
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
                <Square size={13} fill="currentColor" />
                {roomRuns.some((r) => r.state === "stopping")
                  ? "Stopping…"
                  : "Stop agents"}
              </button>
              <button
                className="icon details-toggle"
                aria-label="Conversation details"
                aria-controls="details-panel"
                aria-expanded={inspectOpen}
                onClick={() => setInspectOpen(true)}
              >
                <PanelRight size={19} />
              </button>
            </div>
          )}
        </header>
        {!online && (
          <div className="banner" role="alert">
            Connection to A2Ahub lost. Reconnecting…
          </div>
        )}
        {error && !modal && !picker && !renameRoom && !folderDialog && (
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
            roomTitle={archived ? undefined : room?.title}
            roomId={archived ? undefined : room?.id}
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
              setDetailsTab("agent");
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
        {path === "/library" && (
          <LibraryPage
            key={search}
            rooms={rooms}
            folders={folders}
            runs={runs}
            busy={busy || !online}
            error={error}
            initialView={query.get("view") || "all"}
            act={action}
            api={api}
            onOpen={openRoom}
          />
        )}
        {path === "/admin" && (
          <AdminPage
            api={api}
            refreshKey={`${runs.length}-${runs.filter((r) => r.state === "running").length}-${data.pendingRequests}`}
            navigate={navigate}
            openRoom={openRoom}
          />
        )}
        {path === "/settings" && (
          <SettingsPage
            profile={data.profile}
            busy={busy || !online}
            tab={query.get("tab") || "profile"}
            setTab={(tab) => {
              history.replaceState({}, "", `/settings?tab=${tab}`);
              setSearch(`?tab=${tab}`);
            }}
            appearance={appearance}
            setAppearance={setAppearance}
            api={api}
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
        {chatPage && !room && (
          <section className="page-content page-empty">
            <span className="brand-mark large">
              <BrandMark size={34} />
            </span>
            <h2>No open conversations</h2>
            <p>Start a new one, or restore one from the archive.</p>
            <div className="page-actions center">
              <button className="primary" onClick={newConversation}>
                <Plus size={16} /> New conversation
              </button>
              <button
                className="outline"
                onClick={() => navigate("/library?view=archived")}
              >
                <Archive size={16} /> Open archive
              </button>
            </div>
          </section>
        )}
        {chatPage && room && (
          <>
            <section className="chat" aria-label="Messages" aria-live="polite">
              {!room.messages.length ? (
                <div className="empty">
                  <span className="brand-mark large">
                    <BrandMark size={40} />
                  </span>
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
                          disabled={archived}
                          onClick={() => {
                            setText(t);
                            composer.current?.focus();
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
                  {room.messages.map((m) => {
                    const working = ["working", "submitted"].includes(m.state);
                    if (m.role === "system")
                      return (
                        <p className="message system" key={m.id}>
                          {m.text}
                        </p>
                      );
                    return (
                      <article className={`message ${m.role}`} key={m.id}>
                        {m.role !== "user" && <Avatar name={m.name} />}
                        <div className="message-body">
                          <div className="message-heading">
                            <strong>{m.name}</strong>
                            <time dateTime={m.createdAt}>
                              {new Date(m.createdAt).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </time>
                            {m.recipients && (
                              <small>to {m.recipients.join(", ")}</small>
                            )}
                            {m.role !== "user" && <StatePill state={m.state} />}
                          </div>
                          <div
                            className={`bubble ${m.role === "user" ? "user-bubble" : "agent-bubble"} ${working ? "working" : ""}`}
                          >
                            {m.text || (
                              <span className="thinking">
                                Waiting for {m.name}…
                              </span>
                            )}
                          </div>
                        </div>
                      </article>
                    );
                  })}
                  <div ref={bottom} />
                </div>
              )}
            </section>
            <div className="compose-wrap">
              {archived ? (
                <div className="run-status archived-note" role="status">
                  <Archive size={16} />
                  This conversation is archived and read-only. Agents receive
                  nothing until you restore it.
                  <button
                    className="outline small"
                    disabled={busy}
                    onClick={() =>
                      action(() => api(`/rooms/${room.id}/unarchive`))
                    }
                  >
                    Restore
                  </button>
                </div>
              ) : (
                <>
                  {waitingConversations.length > 0 && (
                    <p className="connector-hint" role="status">
                      Waiting for{" "}
                      {waitingConversations.map((a) => a.name).join(", ")} to
                      confirm their open conversation.
                    </p>
                  )}
                  {offlineConversations.length > 0 && (
                    <p className="connector-hint" role="status">
                      {offlineConversations.map((a) => a.name).join(", ")} have
                      an offline conversation. Open it and connect again.{" "}
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
                      {offlineConnectors.map((a) => a.name).join(", ")} can read
                      and post, but their connector is offline.{" "}
                      <button
                        className="text-button"
                        onClick={() => navigate("/access")}
                      >
                        Agent setup
                      </button>
                    </p>
                  )}
                  {room.paused ? (
                    <div className="run-status paused" role="status">
                      {run?.stopNote || "Agents paused."} Continue the
                      discussion, or resume to send a new message.
                      <button
                        className="outline small"
                        disabled={busy || roomActive}
                        onClick={() =>
                          action(() => api(`/rooms/${room.id}/resume`))
                        }
                      >
                        Resume agents
                      </button>
                    </div>
                  ) : roomActive ? (
                    <div className="run-status live" role="status">
                      <span className="pulse" />
                      <span>
                        <strong>{talkingIds.map(nameOf).join(", ")}</strong>{" "}
                        replying
                        {queuedIds.length > 0 &&
                          ` · ${queuedIds.map(nameOf).join(", ")} waiting for their current reply`}
                        {" · "}You can keep talking
                      </span>
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
                      Agents are active in another conversation. Stop them there
                      to start here.
                    </div>
                  )}
                </>
              )}
              <form
                className={`composer ${dropping ? "drag-over" : ""}`}
                data-agent-dropzone={
                  !busy &&
                  !roomActive &&
                  !archived &&
                  online &&
                  selected.length < 6
                    ? "enabled"
                    : "disabled"
                }
                data-room-id={room.id}
                onSubmit={submit}
                onDragOver={(e) => {
                  if (
                    !busy &&
                    !roomActive &&
                    !archived &&
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
                  <span className="recipients-label">In this chat</span>
                  {members.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      aria-label={`Remove ${a.name} from this chat`}
                      title={`Remove ${a.name} from this conversation only`}
                      className="recipient chosen"
                      disabled={busy || roomActive || archived || !online}
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
                    disabled={!online || archived}
                    onClick={() => {
                      setError("");
                      setPicker(true);
                    }}
                  >
                    <Plus size={16} />
                    {!members.length && <span>Add agents</span>}
                  </button>
                  {dropping && (
                    <span className="drop-hint">Drop to add to this chat</span>
                  )}
                </div>
                <textarea
                  ref={composer}
                  aria-label="Message"
                  placeholder={
                    archived
                      ? "Restore this conversation to send messages"
                      : "Write a message… (Ctrl+Enter to send)"
                  }
                  value={text}
                  maxLength={12000}
                  disabled={archived}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      if (canSend) e.currentTarget.form.requestSubmit();
                    }
                  }}
                />
                <div className="composer-footer">
                  <label className="toggle-label">
                    <input
                      type="checkbox"
                      checked={relay}
                      disabled={busy || roomActive || archived}
                      onChange={(e) =>
                        action(() => settings({ agentChat: e.target.checked }))
                      }
                    />
                    <span className="switch" />
                    Agents reply to each other
                  </label>
                  <div
                    className="turns"
                    role="group"
                    aria-labelledby="reply-allowance-label"
                  >
                    <span id="reply-allowance-label">Replies</span>
                    <div className="stepper">
                      <button
                        type="button"
                        aria-label="Fewer replies"
                        disabled={
                          !relay ||
                          busy ||
                          roomActive ||
                          archived ||
                          limit <= Math.max(1, selected.length)
                        }
                        onClick={() =>
                          action(() => settings({ replyLimit: limit - 1 }))
                        }
                      >
                        <Minus size={14} />
                      </button>
                      <output aria-label="Reply allowance" aria-live="polite">
                        {relay ? limit : selected.length}
                      </output>
                      <button
                        type="button"
                        aria-label="More replies"
                        disabled={
                          !relay || busy || roomActive || archived || limit >= 6
                        }
                        onClick={() =>
                          action(() => settings({ replyLimit: limit + 1 }))
                        }
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                    <small>max 6</small>
                  </div>
                  <button className="primary send" disabled={!canSend}>
                    <Send size={17} />
                    Send message
                  </button>
                </div>
              </form>
              <p className="footnote">
                Each message or Continue allows up to{" "}
                {relay ? limit : selected.length} replies. Stop agents pauses
                this chat and attempts remote cancellation.
              </p>
            </div>
          </>
        )}
      </main>
      <aside
        ref={inspector}
        id="details-panel"
        tabIndex={-1}
        aria-label="Details"
        className={`details ${inspectOpen ? "inspect-open" : ""}`}
      >
        <button
          className="icon details-close"
          aria-label="Close details"
          onClick={() => setInspectOpen(false)}
        >
          <X />
        </button>
        <div className="tabs details-tabs" role="tablist" aria-label="Details">
          {[
            ["room", "Room"],
            ["activity", "Activity"],
            ["agent", "Agent"],
          ].map(([id, label]) => (
            <button
              key={id}
              role="tab"
              id={`details-tab-${id}`}
              aria-selected={detailsTab === id}
              aria-controls="details-tabpanel"
              onClick={() => setDetailsTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          id="details-tabpanel"
          aria-labelledby={`details-tab-${detailsTab}`}
          className="details-panel"
        >
          {detailsTab === "room" && (
            <>
              <h2>Conversation controls</h2>
              <div className="mode">
                <MessageCircle size={22} />
                <div>
                  <strong>Group chat</strong>
                  <p>
                    {relay
                      ? `Members hear your messages and each other. Up to ${limit} replies per message or Continue, arriving independently.`
                      : "Members reply independently to you. Their replies do not trigger other agents."}
                  </p>
                  <p>
                    Stop agents pauses every member. Continue advances the
                    topic; Resume agents lets you send a new message.
                  </p>
                </div>
              </div>
              {room && (
                <dl className="room-facts">
                  <dt>Folder</dt>
                  <dd>
                    {folders.find((f) => f.id === room.folderId)?.name ||
                      "No folder"}
                  </dd>
                  {room.createdAt && (
                    <>
                      <dt>Created</dt>
                      <dd>{when(room.createdAt)}</dd>
                    </>
                  )}
                  <dt>Messages</dt>
                  <dd>{room.messages.length}</dd>
                </dl>
              )}
              <p className="adapter-note">
                Approved agents are reusable across chats. Add or remove room
                members with the plus button; manage credentials on Access.
              </p>
              <details>
                <summary>How this workspace works</summary>
                <p>
                  History and membership are saved on this computer. Only this
                  chat’s members receive new messages. Adding an agent does not
                  share old history.
                </p>
                <p>
                  The reply allowance caps Hub requests, not an agent’s internal
                  tool calls or spending. Stop attempts remote cancellation;
                  work already started may continue.
                </p>
                <p>
                  Automatic replies require a running endpoint or connector for
                  the enrolled agent’s harness.
                </p>
              </details>
            </>
          )}
          {detailsTab === "activity" && (
            <>
              <h2>{roomActive ? "Current discussion" : "Last discussion"}</h2>
              {meterRun ? (
                <>
                  <BurstMeter
                    used={meterRun.turn}
                    total={meterRun.maxTurns}
                    active={roomActive}
                  />
                  <p className="muted">
                    Requests run concurrently; each agent’s context stays in
                    order.
                  </p>
                  <ul className="activity-list">
                    {talkingIds.map((id) => (
                      <li key={`t-${id}`}>
                        <Avatar name={nameOf(id)} size="sm" />
                        <span>{nameOf(id)}</span>
                        <StatePill state="working" />
                      </li>
                    ))}
                    {queuedIds.map((id) => (
                      <li key={`q-${id}`}>
                        <Avatar name={nameOf(id)} size="sm" />
                        <span>{nameOf(id)}</span>
                        <span className="pill pill-muted">Next up</span>
                      </li>
                    ))}
                    {!roomActive && (
                      <li>
                        <span>
                          {meterRun.state === "stopped"
                            ? "Stopped"
                            : "Finished"}{" "}
                          after {meterRun.turn} of {meterRun.maxTurns} requests
                        </span>
                      </li>
                    )}
                  </ul>
                  {meterRun.stopNote && (
                    <p className="muted">{meterRun.stopNote}</p>
                  )}
                </>
              ) : (
                <p className="muted">
                  No discussion yet. Send a message to start a bounded burst of
                  up to six Hub requests.
                </p>
              )}
            </>
          )}
          {detailsTab === "agent" && (
            <div className="connection">
              <h2>Connection</h2>
              {agent ? (
                <>
                  <div className="connection-name">
                    <Avatar name={agent.name} />
                    <div>
                      <strong>{agent.name}</strong>
                      <span
                        className={`status-line ${connectionStatus(agent)}`}
                      >
                        <i className={`dot ${connectionStatus(agent)}`} />
                        {statusText(agent)}
                      </span>
                    </div>
                  </div>
                  <dl>
                    <dt>Connection</dt>
                    <dd className="endpoint">
                      {agent.kind === "inbound"
                        ? "Approved A2A agent"
                        : agent.url}
                    </dd>
                    <dt>Status</dt>
                    <dd className={connectionStatus(agent)}>
                      {statusText(agent)}
                    </dd>
                    {agent.receiver?.kind === "session" && (
                      <>
                        <dt>Conversation ID</dt>
                        <dd className="endpoint">{agent.receiver.sessionId}</dd>
                        <dt>Hub conversation</dt>
                        <dd>
                          {rooms.find((r) => r.id === agent.receiver.roomId)
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
                          className="outline small"
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
          )}
        </div>
      </aside>
      <Navigation
        path={path}
        navigate={navigate}
        badges={badges}
        className="tabbar"
        only={["/", "/agents", "/access", "/admin", "/settings"]}
      />
      {picker && room && (
        <AgentPicker
          participants={participants}
          selected={selected}
          roomTitle={room.title}
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
      {folderDialog && (
        <FolderDialog
          busy={busy}
          error={error}
          onClose={() => setFolderDialog(false)}
          onSave={(fields) =>
            action(async () => {
              await api("/folders", fields);
              setFolderDialog(false);
            })
          }
        />
      )}
      {renameRoom && (
        <Dialog
          title="Rename conversation"
          onClose={() => setRenameRoom(null)}
          initialFocus="#conversation-title"
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              action(async () => {
                await settings({ title: roomTitle.trim() }, renameRoom);
                setData(await api("/state", null, "GET"));
                setRenameRoom(null);
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

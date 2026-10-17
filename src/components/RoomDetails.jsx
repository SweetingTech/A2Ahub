import { Plus, X } from "lucide-react";
import {
  beginAgentPointerDrag,
  connectionStatus,
  statusText,
} from "../workspace.jsx";
import { ConversationList } from "../conversations.jsx";
import { Avatar } from "../ui.jsx";

// RoomDetails — the left sidebar: conversation list, agent directory, and
// the hub-status footer. State is owned by the host; this renders from props
// and calls back through the supplied handlers.
export function RoomDetails({
  mobile,
  busy,
  online,
  rooms,
  folders,
  runs,
  chatPage,
  room,
  participants,
  setMobile,
  setRoomTitle,
  setError,
  setRenameRoom,
  setFolderDialog,
  openRoom,
  action,
  settings,
  api,
  navigate,
  searchBox,
  setInspected,
  setDetailsTab,
  setInspectOpen,
  newConversation,
}) {
  return (
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
  );
}

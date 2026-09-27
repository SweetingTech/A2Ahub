import React, { useRef, useState } from "react";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  MoreHorizontal,
  Pin,
  Search,
} from "lucide-react";
import { Menu, MenuItem, when } from "./ui.jsx";
import { readStored, storeLocal } from "./api.js";

export const ROOM_DRAG_TYPE = "application/x-a2ahub-room";

export function roomState(room, runs) {
  if (
    runs.some(
      (r) => r.roomId === room.id && ["running", "stopping"].includes(r.state),
    )
  )
    return "live";
  if (room.archived) return "archived";
  return room.paused ? "paused" : "idle";
}
const stateWord = { live: "live", paused: "paused", idle: "", archived: "" };

function preview(room) {
  const m = room.messages.at(-1);
  if (!m) return "No messages yet";
  return `${m.role === "user" ? "You" : m.name}: ${m.text || "…"}`;
}

function RoomRow({
  room,
  state,
  selected,
  folders,
  onSelect,
  onRename,
  onPin,
  onArchive,
  onMove,
  disabled,
}) {
  const [open, setOpen] = useState(false);
  const more = useRef(null);
  return (
    <div
      className={`room-row ${selected ? "selected" : ""}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(ROOM_DRAG_TYPE, room.id);
      }}
    >
      <button
        className="room"
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(room.id)}
      >
        <span className={`room-dot ${state}`} aria-hidden="true" />
        <span className="room-text">
          <span className="room-title-line">
            <strong>{room.title}</strong>
            {room.pinned && (
              <Pin size={12} className="room-pin" aria-label="Pinned" />
            )}
            <span className={`room-meta ${state}`}>
              {stateWord[state] ||
                when(room.messages.at(-1)?.createdAt || room.createdAt)}
            </span>
          </span>
          {selected && <span className="room-preview">{preview(room)}</span>}
        </span>
      </button>
      <button
        ref={more}
        className="icon room-more"
        aria-label={`More actions for ${room.title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <Menu
          label={`${room.title} actions`}
          anchor={more}
          onClose={() => setOpen(false)}
        >
          <MenuItem
            disabled={disabled}
            onSelect={() => {
              setOpen(false);
              onRename(room);
            }}
          >
            Rename…
          </MenuItem>
          <MenuItem
            onSelect={() => {
              setOpen(false);
              onPin(room);
            }}
          >
            {room.pinned ? "Unpin" : "Pin to top"}
          </MenuItem>
          <div className="menu-label">Move to folder</div>
          {folders.map((f) => (
            <MenuItem
              key={f.id}
              disabled={room.folderId === f.id}
              onSelect={() => {
                setOpen(false);
                onMove(room, f.id);
              }}
            >
              <span className={`folder-swatch ${f.color}`} aria-hidden="true" />
              {f.name}
              {room.folderId === f.id && " ✓"}
            </MenuItem>
          ))}
          <MenuItem
            disabled={!room.folderId}
            onSelect={() => {
              setOpen(false);
              onMove(room, null);
            }}
          >
            No folder
          </MenuItem>
          <div className="menu-separator" role="separator" />
          <MenuItem
            disabled={state === "live"}
            onSelect={() => {
              setOpen(false);
              onArchive(room);
            }}
          >
            <Archive size={14} /> Archive
          </MenuItem>
        </Menu>
      )}
    </div>
  );
}

export function ConversationList({
  rooms,
  folders,
  runs,
  selectedId,
  busy,
  onSelect,
  onRename,
  onPin,
  onArchive,
  onMove,
  onNewFolder,
  onLibrary,
  searchRef,
}) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(() =>
    readStored("a2ahub-folders-collapsed", {}),
  );
  const [dropTarget, setDropTarget] = useState(null);
  const toggle = (id) =>
    setCollapsed((old) => {
      const next = { ...old, [id]: !old[id] };
      storeLocal("a2ahub-folders-collapsed", next);
      return next;
    });
  const q = query.trim().toLowerCase();
  const live = rooms.filter((r) => !r.archived);
  const visible = live
    .filter((r) => !q || r.title.toLowerCase().includes(q))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned));
  const archivedCount = rooms.length - live.length;
  const row = (r) => (
    <RoomRow
      key={r.id}
      room={r}
      state={roomState(r, runs)}
      selected={r.id === selectedId}
      folders={folders}
      disabled={busy}
      onSelect={onSelect}
      onRename={onRename}
      onPin={onPin}
      onArchive={onArchive}
      onMove={onMove}
    />
  );
  const dropProps = (folderId) => ({
    onDragOver: (e) => {
      if (!e.dataTransfer.types.includes(ROOM_DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDropTarget(folderId ?? "none");
    },
    onDragLeave: () => setDropTarget(null),
    onDrop: (e) => {
      e.preventDefault();
      setDropTarget(null);
      const room = rooms.find(
        (r) => r.id === e.dataTransfer.getData(ROOM_DRAG_TYPE),
      );
      if (room && room.folderId !== folderId) onMove(room, folderId);
    },
  });
  const unfiled = visible.filter((r) => !r.folderId);
  return (
    <div className="conversation-list">
      <label className="sidebar-search">
        <Search size={16} aria-hidden="true" />
        <span className="sr-only">Search conversations</span>
        <input
          ref={searchRef}
          type="search"
          placeholder="Search chats"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <kbd aria-hidden="true">Ctrl K</kbd>
      </label>
      <div className="section-heading">
        <h2>Conversations</h2>
        <button
          className="icon"
          aria-label="New folder"
          title="New folder"
          onClick={onNewFolder}
        >
          <FolderPlus size={16} />
        </button>
      </div>
      <nav aria-label="Conversations" className="room-groups">
        {folders.map((f) => {
          const inside = visible.filter((r) => r.folderId === f.id);
          if (q && !inside.length) return null;
          const isCollapsed = collapsed[f.id] && !q;
          return (
            <div key={f.id} className="folder-group">
              <button
                className={`folder-toggle ${dropTarget === f.id ? "drop" : ""}`}
                aria-expanded={!isCollapsed}
                onClick={() => toggle(f.id)}
                {...dropProps(f.id)}
              >
                {isCollapsed ? (
                  <ChevronRight size={14} />
                ) : (
                  <ChevronDown size={14} />
                )}
                <span
                  className={`folder-swatch ${f.color}`}
                  aria-hidden="true"
                />
                <span className="folder-name">{f.name}</span>
                <span className="folder-count">
                  {dropTarget === f.id ? "Drop to move" : inside.length}
                </span>
              </button>
              {!isCollapsed && (
                <div className="folder-rooms">{inside.map(row)}</div>
              )}
            </div>
          );
        })}
        <div
          className={`unfiled ${dropTarget === "none" ? "drop" : ""}`}
          {...dropProps(null)}
        >
          {folders.length > 0 && unfiled.length > 0 && (
            <div className="unfiled-label">No folder</div>
          )}
          {unfiled.map(row)}
        </div>
        {!visible.length && (
          <p className="sidebar-empty">
            {q ? "No conversations match." : "No conversations yet."}
          </p>
        )}
      </nav>
      <button className="archived-link" onClick={onLibrary}>
        <Archive size={16} aria-hidden="true" />
        <span>{archivedCount ? "Archived" : "Manage conversations"}</span>
        {archivedCount > 0 && <span className="count">{archivedCount}</span>}
      </button>
    </div>
  );
}

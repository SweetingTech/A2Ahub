import {
  PanelRight,
  Pencil,
  Play,
  Square,
  Menu as MenuIcon,
} from "lucide-react";
import { BurstMeter } from "../ui.jsx";

// PageHeader — the top header bar: mobile-menu button, title block with the
// rename affordance, and the discussion controls (Continue / Stop / Details).
export function PageHeader({
  menuButtonRef,
  pageHeadingRef,
  chatPage,
  room,
  pageTitle,
  archived,
  selected,
  relay,
  busy,
  online,
  roomActive,
  active,
  meterRun,
  roomRuns,
  inspectOpen,
  mobile,
  setMobile,
  setRoomTitle,
  setError,
  setRenameRoom,
  setInspectOpen,
  action,
  api,
}) {
  return (
    <header className="page-header">
      <button
        className="mobile-menu icon"
        ref={menuButtonRef}
        aria-label="Open conversations"
        aria-expanded={mobile}
        aria-controls="workspace-sidebar"
        onClick={() => setMobile(true)}
      >
        <MenuIcon />
      </button>
      <div className="title-block">
        <div className="title-line">
          <h1 ref={pageHeadingRef} tabIndex={-1}>
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
  );
}

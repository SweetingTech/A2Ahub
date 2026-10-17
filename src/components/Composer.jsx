import {
  Archive,
  Check,
  Minus,
  Plus,
  Send,
  X,
} from "lucide-react";
import { AGENT_DRAG_TYPE, connectionStatus } from "../workspace.jsx";

// Composer — the compose-wrap region: run-status banners, the recipients
// row, the textarea, and the composer footer (relay toggle, reply stepper,
// send button). All behavior is delegated to props from the host.
export function Composer({
  room,
  archived,
  busy,
  online,
  roomActive,
  otherRoomActive,
  run,
  relay,
  limit,
  selected,
  members,
  text,
  setText,
  canSend,
  dropping,
  setDropping,
  waitingConversations,
  offlineConversations,
  offlineConnectors,
  talkingIds,
  queuedIds,
  nameOf,
  choose,
  settings,
  submit,
  action,
  api,
  navigate,
  setError,
  setPicker,
  composerRef,
}) {
  return (
    <div className="compose-wrap">
      {archived ? (
        <div className="run-status archived-note" role="status">
          <Archive size={16} />
          This conversation is archived and read-only. Agents receive
          nothing until you restore it.
          <button
            className="outline small"
            disabled={busy}
            onClick={() => action(() => api(`/rooms/${room.id}/unarchive`))}
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
                onClick={() => action(() => api(`/rooms/${room.id}/resume`))}
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
          ref={composerRef}
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
        Each message or Continue allows up to {relay ? limit : selected.length}{" "}
        replies. Stop agents pauses this chat and attempts remote
        cancellation.
      </p>
    </div>
  );
}

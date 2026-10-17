import React, { useState } from "react";
import {
  Check,
  GripVertical,
  Plus,
  Search,
  ShieldCheck,
  Users,
} from "lucide-react";
import { Avatar } from "../ui.jsx";
import {
  beginAgentPointerDrag,
  connectionStatus,
  statusText,
} from "../workspace.jsx";
import { ConversationSetup } from "./ConversationSetup.jsx";

export function AgentDirectory({
  participants,
  selected,
  roomTitle,
  roomId,
  agentConnectionUrl,
  setupAgentName,
  busy,
  locked,
  onChoose,
  onConnect,
  onInspect,
  onAccess,
  onConversation,
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const filters = [
    ["all", "All", () => true],
    ["online", "Online", (a) => connectionStatus(a) === "connected"],
    ["offline", "Offline", (a) => connectionStatus(a) !== "connected"],
    ["session", "Open conversations", (a) => a.receiver?.kind === "session"],
  ];
  const matches = filters.find(([id]) => id === filter)[2];
  const visible = participants.filter(
    (a) =>
      matches(a) &&
      `${a.name} ${a.description || ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <section
      className="page-content directory-page"
      aria-label="Agent directory"
    >
      <div className="page-intro">
        <div>
          <h2>Your agent directory</h2>
          <p>
            Approve an agent once, then add it to the conversations you choose.
          </p>
        </div>
        <button className="outline" onClick={onAccess}>
          <ShieldCheck size={17} />
          Approve requests
        </button>
      </div>
      <ConversationSetup
        participants={participants}
        roomId={roomId}
        roomTitle={roomTitle}
        agentConnectionUrl={agentConnectionUrl}
        setupAgentName={setupAgentName}
      />
      <div className="directory-toolbar">
        <label className="search-label" htmlFor="directory-search">
          <Search size={17} />
          <span className="sr-only">Search directory</span>
          <input
            id="directory-search"
            type="search"
            placeholder="Search your agents"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="segmented" role="group" aria-label="Filter agents">
          {filters.map(([id, label, fn]) => (
            <button
              key={id}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {label}{" "}
              <span className="count">{participants.filter(fn).length}</span>
            </button>
          ))}
        </div>
        <button className="outline" onClick={onConnect}>
          <Plus size={17} />
          Connect an endpoint
        </button>
      </div>
      <div className="inline-notice">
        <span>
          Adding to: <strong>{roomTitle || "No conversation selected"}</strong>
        </span>
        <button className="text-button" onClick={onConversation}>
          Open conversation
        </button>
      </div>
      {locked && (
        <p className="warning" role="status">
          Stop the active discussion before changing its members.
        </p>
      )}
      <div className="directory-grid">
        {visible.map((a) => {
          const included = selected.includes(a.id);
          return (
            <article
              key={a.id}
              className="directory-card"
              draggable={false}
              data-agent-draggable="true"
              onPointerDown={(e) => beginAgentPointerDrag(e, a)}
              onDragStart={(e) => e.preventDefault()}
            >
              <div className="directory-card-heading">
                <Avatar name={a.name} size="lg" />
                <div>
                  <h3>{a.name}</h3>
                  <p className={`status-line ${connectionStatus(a)}`}>
                    <i className={`dot ${connectionStatus(a)}`} />
                    {statusText(a)}
                  </p>
                </div>
                <GripVertical
                  size={18}
                  className="drag-grip"
                  aria-hidden="true"
                />
              </div>
              <p className="agent-description">
                {a.description ||
                  (a.kind === "inbound"
                    ? "Approved to join your conversations through A2A."
                    : "An agent registered through its A2A endpoint.")}
              </p>
              {a.kind === "inbound" && connectionStatus(a) !== "connected" && (
                <p className="connector-hint">
                  {a.receiver?.kind === "session"
                    ? "The selected conversation must answer the handshake before it is shown as connected."
                    : "Connect this agent’s open conversation using the setup prompt above, or use its native A2A connector."}
                </p>
              )}
              <div className="directory-card-actions">
                <button
                  className={included ? "outline" : "primary"}
                  disabled={
                    busy ||
                    locked ||
                    !roomTitle ||
                    (!included && selected.length >= 6)
                  }
                  onClick={() => onChoose(a.id, !included)}
                >
                  {included ? (
                    <>
                      <Check size={16} />
                      In this chat · remove
                    </>
                  ) : (
                    <>
                      <Plus size={16} />
                      Add to chat
                    </>
                  )}
                </button>
                <button className="text-button" onClick={() => onInspect(a.id)}>
                  Details
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {!visible.length && (
        <div className="page-empty">
          <Users size={40} />
          <h3>
            {participants.length
              ? "No matching agents"
              : "Bring your first agent in"}
          </h3>
          <p>
            {participants.length
              ? "Try another name."
              : "Agents request access using an approval link. You decide when they join a chat."}
          </p>
          {!participants.length && (
            <button className="primary" onClick={onAccess}>
              Open agent access
            </button>
          )}
        </div>
      )}
    </section>
  );
}

import { useEffect, useState } from "react";
import {
  MessageCircle,
  RefreshCw,
  Trash2,
  X,
  CheckCircle,
  AlertCircle,
  Activity,
} from "lucide-react";
import { connectionStatus, statusText } from "../workspace.jsx";
import { Avatar, BurstMeter, StatePill, when } from "../ui.jsx";
import { api } from "../api.js";

// Inspector — the right-hand details panel with Room / Activity / Agent tabs.
// All state lives in the host; this component only renders from props.
export function Inspector({
  inspectorRef,
  inspectOpen,
  setInspectOpen,
  detailsTab,
  setDetailsTab,
  room,
  folders,
  relay,
  limit,
  roomActive,
  meterRun,
  talkingIds,
  queuedIds,
  nameOf,
  agent,
  rooms,
  busy,
  active,
  action,
  api: apiProp,
  navigate,
}) {
  const [gateway, setGateway] = useState(null);
  useEffect(() => {
    if (detailsTab !== "gateway" || !room) return;
    apiProp(`/rooms/${room.id}/gateway`).then(setGateway).catch(() => setGateway(null));
  }, [detailsTab, room, room?.messages?.length]);
  return (
    <aside
      ref={inspectorRef}
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
          ["gateway", "Gateway"],
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
        {detailsTab === "gateway" && (
          <div className="gateway-inspection">
            <h2>Delivery inspection</h2>
            {gateway ? (
              <>
                <dl className="room-facts">
                  <dt>Latest event seq</dt>
                  <dd>{gateway.latestSeq}</dd>
                  <dt>Delivery events</dt>
                  <dd>{gateway.deliveryCount}</dd>
                  <dt>Active</dt>
                  <dd>{gateway.active ? "Yes" : "No"}</dd>
                </dl>
                {gateway.deliveries.length > 0 && (
                  <>
                    <h3>Recent deliveries</h3>
                    <ul className="activity-list">
                      {gateway.deliveries.slice(-10).reverse().map((d) => (
                        <li key={`${d.dispatchId}-${d.seq}`}>
                          {d.type === "dispatch.completed" ? (
                            <CheckCircle size={16} className="status-ok" />
                          ) : d.type === "dispatch.error" ? (
                            <AlertCircle size={16} className="status-err" />
                          ) : d.type === "dispatch.canceled" ? (
                            <X size={16} className="status-warn" />
                          ) : (
                            <Activity size={16} />
                          )}
                          <span>{d.type.replace("dispatch.", "")}</span>
                          <span className="muted">seq {d.seq}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {gateway.receipts.length > 0 && (
                  <>
                    <h3>Durable receipts</h3>
                    <ul className="activity-list">
                      {gateway.receipts.slice(-10).reverse().map((r) => (
                        <li key={r.dispatchId}>
                          <CheckCircle size={16} className="status-ok" />
                          <span>{r.state}</span>
                          <span className="muted">{when(r.acceptedAt)}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {Object.keys(gateway.cursors).length > 0 && (
                  <>
                    <h3>Recipient cursors</h3>
                    <dl className="room-facts">
                      {Object.entries(gateway.cursors).map(([id, cursor]) => (
                        <><dt>{nameOf(id)}</dt><dd>cursor {cursor}</dd></>
                      ))}
                    </dl>
                  </>
                )}
                <p className="adapter-note">
                  Cursors track delivery progress, not permission to read
                  history. Membership and history boundaries are separate.
                </p>
              </>
            ) : (
              <p className="muted">Loading delivery data…</p>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

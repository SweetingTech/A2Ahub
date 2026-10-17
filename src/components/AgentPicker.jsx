import React, { useState } from "react";
import { Check, Plus, Search } from "lucide-react";
import { Dialog, connectionStatus, statusText } from "../workspace.jsx";

export function AgentPicker({
  participants,
  selected,
  onChoose,
  onClose,
  busy,
  locked,
  error,
  roomTitle,
  onAccess,
}) {
  const [query, setQuery] = useState("");
  const visible = participants.filter((a) =>
    a.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <Dialog
      title="Add agents to this chat"
      onClose={onClose}
      className="agent-picker"
    >
      <p>
        Choose from your agent directory for <strong>{roomTitle}</strong>. New
        members see messages sent after they join.
      </p>
      <label className="search-label" htmlFor="picker-search">
        <Search size={17} />
        <span className="sr-only">Search agents</span>
        <input
          id="picker-search"
          type="search"
          placeholder="Search agents"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {locked && (
        <p className="inline-notice" role="status">
          Stop the active discussion before changing members.
        </p>
      )}
      {error && (
        <p className="banner" role="alert">
          {error}
        </p>
      )}
      <div className="picker-list">
        {visible.map((a) => {
          const included = selected.includes(a.id);
          return (
            <div className="picker-agent" key={a.id}>
              <i className={`dot ${connectionStatus(a)}`} />
              <div>
                <strong>{a.name}</strong>
                <small>{statusText(a)}</small>
              </div>
              <button
                type="button"
                className={included ? "outline" : "primary"}
                aria-label={`${included ? "Remove" : "Add"} ${a.name} ${included ? "from" : "to"} this chat`}
                disabled={busy || locked || (!included && selected.length >= 6)}
                onClick={() => onChoose(a.id, !included)}
              >
                {included ? (
                  <>
                    <Check size={15} />
                    Added · remove
                  </>
                ) : (
                  <>
                    <Plus size={15} />
                    Add
                  </>
                )}
              </button>
            </div>
          );
        })}
        {!visible.length && (
          <p>
            {participants.length
              ? "No agents match your search."
              : "Your directory is empty. Approve an agent to make it available here."}
          </p>
        )}
      </div>
      <div className="picker-footer">
        <span>{selected.length} of 6 places used</span>
        <button type="button" className="text-button" onClick={onAccess}>
          Manage agent access
        </button>
        <button type="button" className="outline" onClick={onClose}>
          Done
        </button>
      </div>
    </Dialog>
  );
}

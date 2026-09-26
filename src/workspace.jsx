import React, { useEffect, useRef, useState } from "react";
import {
  Check,
  GripVertical,
  MessageCircle,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";

export const AGENT_DRAG_TYPE = "application/x-a2ahub-agent";
export const pages = [
  { path: "/", title: "Conversations", icon: MessageCircle },
  { path: "/agents", title: "Agents", icon: Users },
  { path: "/access", title: "Access", icon: ShieldCheck },
  { path: "/settings", title: "Settings", icon: Settings },
];

export function Navigation({ path, navigate }) {
  return (
    <nav className="workspace-nav" aria-label="Workspace">
      {pages.map(({ path: href, title, icon: Icon }) => (
        <a
          key={href}
          href={href}
          aria-current={path === href ? "page" : undefined}
          onClick={(event) => {
            if (
              event.button ||
              event.ctrlKey ||
              event.metaKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            event.preventDefault();
            navigate(href);
          }}
        >
          <Icon size={17} />
          <span>{title}</span>
        </a>
      ))}
    </nav>
  );
}

export function statusText(agent) {
  if (agent.kind === "inbound")
    return agent.status === "connected"
      ? "Connector online"
      : "Approved · connector offline";
  return agent.status === "connected"
    ? "Endpoint online"
    : agent.status === "offline"
      ? "Endpoint offline"
      : "Connection not checked";
}

export function startAgentDrag(event, agent) {
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData(AGENT_DRAG_TYPE, agent.id);
}

// A pointer drag also works in local browser shells that do not start HTML5 dragging.
export function beginAgentPointerDrag(event, agent) {
  if (event.button !== 0 || event.pointerType === "touch") return;
  const control = event.target.closest("button,a,input,select");
  if (control && control !== event.currentTarget) return;
  const startX = event.clientX,
    startY = event.clientY;
  const pointerId = event.pointerId;
  let ghost,
    target,
    dragging = false;
  const findTarget = (x, y) =>
    document.elementFromPoint(x, y)?.closest('[data-agent-dropzone="enabled"]');
  const resetTarget = (next) => {
    if (target === next) return;
    target?.classList.remove("pointer-drag-over");
    target = next;
    target?.classList.add("pointer-drag-over");
  };
  const cleanup = () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    document.removeEventListener("pointercancel", cleanup);
    window.removeEventListener("blur", cleanup);
    ghost?.remove();
    resetTarget(null);
    document.body.classList.remove("agent-dragging");
  };
  const move = (e) => {
    if (e.pointerId !== pointerId) return;
    if (!dragging && Math.hypot(e.clientX - startX, e.clientY - startY) < 8)
      return;
    if (!dragging) {
      dragging = true;
      ghost = document.createElement("div");
      ghost.className = "agent-drag-ghost";
      ghost.textContent = agent.name;
      ghost.setAttribute("aria-hidden", "true");
      document.body.append(ghost);
      document.body.classList.add("agent-dragging");
    }
    e.preventDefault();
    ghost.style.left = `${e.clientX + 12}px`;
    ghost.style.top = `${e.clientY + 12}px`;
    resetTarget(findTarget(e.clientX, e.clientY));
  };
  const up = (e) => {
    if (e.pointerId !== pointerId) return;
    if (dragging) {
      const destination = findTarget(e.clientX, e.clientY);
      if (destination)
        window.dispatchEvent(
          new CustomEvent("a2ahub-agent-drop", {
            detail: { agentId: agent.id, roomId: destination.dataset.roomId },
          }),
        );
      const suppressClick = (click) => {
        click.preventDefault();
        click.stopImmediatePropagation();
      };
      document.addEventListener("click", suppressClick, {
        capture: true,
        once: true,
      });
      setTimeout(
        () => document.removeEventListener("click", suppressClick, true),
        0,
      );
    }
    cleanup();
  };
  document.addEventListener("pointermove", move, { passive: false });
  document.addEventListener("pointerup", up);
  document.addEventListener("pointercancel", cleanup);
  window.addEventListener("blur", cleanup);
}

export function Dialog({
  title,
  onClose,
  children,
  className = "",
  initialFocus,
}) {
  const dialog = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const focusable = () => [
      ...(dialog.current?.querySelectorAll(
        'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]',
      ) || []),
    ];
    (
      dialog.current?.querySelector(initialFocus || "input") ||
      focusable()[0] ||
      dialog.current
    )?.focus();
    function trap(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        close.current();
        return;
      }
      if (event.key !== "Tab") return;
      const nodes = focusable();
      const first = nodes[0],
        last = nodes.at(-1);
      if (!nodes.length) {
        event.preventDefault();
        dialog.current?.focus();
      } else if (!nodes.includes(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", trap);
    return () => {
      document.removeEventListener("keydown", trap);
      if (previous?.isConnected) previous.focus();
    };
  }, [initialFocus]);
  return (
    <div className="modal-backdrop">
      <section
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-dialog-title"
        tabIndex={-1}
        className={`modal ${className}`}
      >
        <div className="modal-heading">
          <h2 id="workspace-dialog-title">{title}</h2>
          <button
            type="button"
            className="icon"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

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
              <i className={`dot ${a.status}`} />
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

export function AgentDirectory({
  participants,
  selected,
  roomTitle,
  busy,
  locked,
  onChoose,
  onConnect,
  onInspect,
  onAccess,
  onConversation,
}) {
  const [query, setQuery] = useState("");
  const visible = participants.filter((a) =>
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
                <div className="avatar">
                  <Users size={18} />
                </div>
                <div>
                  <h3>{a.name}</h3>
                  <p>
                    <i className={`dot ${a.status}`} />
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
              {a.kind === "inbound" && a.status !== "connected" && (
                <p className="connector-hint">
                  Run this agent’s A2A connector to receive automatic replies.{" "}
                  <button className="text-button" onClick={onAccess}>
                    Agent setup
                  </button>
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

export function SettingsPage({ profile, onSave, onLogout, busy }) {
  const [name, setName] = useState(profile?.displayName || "You");
  const [notice, setNotice] = useState("");
  useEffect(
    () => setName(profile?.displayName || "You"),
    [profile?.displayName],
  );
  return (
    <section className="page-content settings-page">
      <div className="settings-card">
        <h2>Your identity</h2>
        <p>This is the name agents see on your new messages.</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setNotice("");
            if (await onSave(name.trim()))
              setNotice("Your display name is saved.");
          }}
        >
          <label htmlFor="display-name">Display name</label>
          <input
            id="display-name"
            value={name}
            maxLength={80}
            required
            onChange={(e) => setName(e.target.value)}
            autoComplete="nickname"
          />
          <button
            className="primary"
            disabled={
              busy || !name.trim() || name.trim() === profile?.displayName
            }
          >
            Save name
          </button>
        </form>
        {notice && (
          <p role="status" className="success-notice">
            {notice}
          </p>
        )}
      </div>
      <div className="settings-card">
        <h2>Owner session</h2>
        <p>
          You’re signed in as the owner of this local workspace. Agent
          credentials are managed separately on Access.
        </p>
        <button className="outline" onClick={onLogout} disabled={busy}>
          Sign out
        </button>
      </div>
    </section>
  );
}

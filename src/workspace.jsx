import React, { useEffect, useRef } from "react";
import {
  Gauge,
  Library,
  MessageCircle,
  Settings,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";

import { ConversationSetup } from "./components/ConversationSetup.jsx";
import { AgentPicker } from "./components/AgentPicker.jsx";
import { AgentDirectory } from "./components/AgentDirectory.jsx";

export const AGENT_DRAG_TYPE = "application/x-a2ahub-agent";
export const harnessNames = {
  codex: "Codex",
  "claude-code": "Claude Code",
  hermes: "Hermes",
};
export const pages = [
  { path: "/", title: "Conversations", short: "Chats", icon: MessageCircle },
  { path: "/library", title: "Library", short: "Library", icon: Library },
  { path: "/agents", title: "Agents", short: "Agents", icon: Users },
  { path: "/access", title: "Access", short: "Access", icon: ShieldCheck },
  { path: "/admin", title: "Hub admin", short: "Admin", icon: Gauge },
  { path: "/settings", title: "Settings", short: "Settings", icon: Settings },
];

export function Navigation({
  path,
  navigate,
  badges = {},
  className = "workspace-nav",
  only,
}) {
  return (
    <nav className={className} aria-label="Workspace">
      {pages
        .filter((p) => !only || only.includes(p.path))
        .map(({ path: href, title, short, icon: Icon }) => (
          <a
            key={href}
            href={href}
            title={title}
            aria-label={
              badges[href]
                ? `${title}, ${badges[href]} need attention`
                : undefined
            }
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
            <Icon size={20} aria-hidden="true" />
            <span className="nav-label">{short}</span>
            {badges[href] > 0 && (
              <span className="nav-badge" aria-hidden="true">
                {badges[href]}
              </span>
            )}
          </a>
        ))}
    </nav>
  );
}

export function statusText(agent) {
  if (agent.receiver?.kind === "session") {
    if (
      agent.receiver.state === "awaiting-confirmation" ||
      !agent.receiver.lastReceiptAt
    )
      return "Waiting for conversation";
    if (agent.status !== "connected") return "Conversation offline";
    if (agent.receiver.state === "queued") return "Message queued";
    if (agent.receiver.state === "working") return "Responding";
    return `Connected to ${harnessNames[agent.receiver.harness] || "agent"} conversation`;
  }
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

export function connectionStatus(agent) {
  // Approval or a running bridge does not prove the selected conversation answered.
  if (
    agent.receiver?.kind === "session" &&
    (agent.receiver.state === "awaiting-confirmation" ||
      !agent.receiver.lastReceiptAt)
  )
    return "unchecked";
  return agent.status;
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

export { ConversationSetup, AgentPicker, AgentDirectory };

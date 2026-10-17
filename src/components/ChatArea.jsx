import { Avatar, StatePill } from "../ui.jsx";

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

// ChatArea — the messages list (or empty state) for the current room.
export function ChatArea({ room, bottom, archived, setText, composer }) {
  return (
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
            {["Introduce yourself", "What can you help with?"].map((t) => (
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
            ))}
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
                      <span className="thinking">Waiting for {m.name}…</span>
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
  );
}

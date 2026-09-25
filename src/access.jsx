import React, { useEffect, useState } from "react";

async function request(url, body, method = "POST") {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

export function OwnerGate({ children }) {
  const [session, setSession] = useState(null),
    [error, setError] = useState(""),
    [password, setPassword] = useState("");
  useEffect(() => {
    request("/auth/session", null, "GET")
      .then(setSession)
      .catch((e) => setError(e.message));
  }, []);
  if (session?.authenticated) return children;
  return (
    <main className="access-page">
      <section className="access-card">
        <h1>A2Ahub owner sign-in</h1>
        <p>Sign in to manage conversations and approve agent access.</p>
        {session && (
          <>
            <p>
              Your initial password is in this private file on your computer:
            </p>
            <code className="path">{session.passwordLocation}</code>
            <p>
              If you supplied A2AHUB_OWNER_PASSWORD at first setup, use that
              password instead.
            </p>
          </>
        )}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await request("/auth/login", { password });
              setPassword("");
              setSession({ authenticated: true });
            } catch (e) {
              setError(e.message);
            }
          }}
        >
          <label htmlFor="owner-password">Owner password</label>
          <input
            id="owner-password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button className="primary" disabled={!session}>
            Sign in
          </button>
        </form>
        {error && <p role="alert">{error}</p>}
        <p>
          Agents use an approval link and their own credential. Do not share
          this password with them.
        </p>
      </section>
    </main>
  );
}

export function AccessPage() {
  const [data, setData] = useState({ requests: [], accounts: [] }),
    [rooms, setRooms] = useState([]),
    [choices, setChoices] = useState({}),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const selectedRequest = new URLSearchParams(location.search).get("request");
  async function refresh() {
    const [access, state] = await Promise.all([
      request("/api/access", null, "GET"),
      request("/api/state", null, "GET"),
    ]);
    setData(access);
    setRooms(state.rooms);
  }
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
    const t = setInterval(
      () => refresh().catch((e) => setError(e.message)),
      5000,
    );
    return () => clearInterval(t);
  }, []);
  async function act(fn, message) {
    try {
      setError("");
      await fn();
      setNotice(message);
      await refresh();
    } catch (e) {
      setError(e.message);
    }
  }
  return (
    <main className="access-page">
      <section className="access-card wide">
        <a href="/">← Conversations</a>
        <h1>Agent access</h1>
        <p>
          Approve agents you recognize. Compare the code with the one the agent
          gave you. Access includes reading and posting new messages in the
          conversation you choose, for 30 days.
        </p>
        <p>To connect, have the agent run this from the A2Ahub folder:</p>
        <code className="path">
          node scripts/a2a-client.mjs auth --name Hermes --url {location.origin}
        </code>
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        <h2>Requests</h2>
        {!data.requests.length && (
          <p>No pending requests. A request link expires after ten minutes.</p>
        )}
        {data.requests.map((r) => (
          <article
            key={r.id}
            className={`access-request ${r.id === selectedRequest ? "selected" : ""}`}
          >
            <h3>{r.name}</h3>
            <p>
              Verification code: <strong>{r.userCode}</strong>
            </p>
            <p>Expires {new Date(r.expiresAt).toLocaleTimeString()}</p>
            <label htmlFor={`room-${r.id}`}>Conversation to share</label>
            <select
              id={`room-${r.id}`}
              value={choices[r.id] || ""}
              onChange={(e) =>
                setChoices({ ...choices, [r.id]: e.target.value })
              }
            >
              <option value="">Choose a conversation</option>
              {rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.title}
                </option>
              ))}
            </select>
            <div className="access-actions">
              <button
                className="primary"
                disabled={!choices[r.id]}
                onClick={() =>
                  act(
                    () =>
                      request(`/api/access/${r.id}/decision`, {
                        approved: true,
                        roomId: choices[r.id],
                      }),
                    `${r.name} approved. The agent can now collect its credential.`,
                  )
                }
              >
                Approve
              </button>
              <button
                className="outline"
                onClick={() =>
                  act(
                    () =>
                      request(`/api/access/${r.id}/decision`, {
                        approved: false,
                      }),
                    "Request denied.",
                  )
                }
              >
                Deny
              </button>
            </div>
          </article>
        ))}
        <h2>Connections</h2>
        {!data.accounts.length && <p>No approved agents yet.</p>}
        {data.accounts.map((a) => (
          <article className="access-request" key={a.id}>
            <h3>{a.name}</h3>
            <p>
              {rooms.find((r) => r.id === a.roomId)?.title ||
                "Conversation unavailable"}{" "}
              ·{" "}
              {a.revoked
                ? "Revoked"
                : a.expiresAt <= Date.now()
                  ? "Expired"
                  : "Approved"}
            </p>
            <p>Expires {new Date(a.expiresAt).toLocaleDateString()}</p>
            {!a.revoked && (
              <button
                className="outline"
                onClick={() =>
                  act(
                    () => request(`/api/access/${a.id}`, null, "DELETE"),
                    "Access revoked.",
                  )
                }
              >
                Revoke {a.name}
              </button>
            )}
          </article>
        ))}
      </section>
    </main>
  );
}

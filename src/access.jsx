import React, { useEffect, useState } from "react";

async function request(url, body, method = "POST") {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json();
  if (res.status === 401 && url.startsWith("/api/"))
    window.dispatchEvent(new Event("a2ahub-auth-required"));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

export function OwnerGate({ children }) {
  const [session, setSession] = useState(null),
    [error, setError] = useState(""),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  async function loadSession() {
    setLoading(true);
    try {
      setSession(await request("/auth/session", null, "GET"));
    } catch (e) {
      setError(
        e.message ||
          "Cannot reach A2Ahub. Check that the local server is running.",
      );
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    loadSession();
    const expired = () => {
      setSession(null);
      setPassword("");
      setError("");
      loadSession();
    };
    window.addEventListener("a2ahub-auth-required", expired);
    return () => window.removeEventListener("a2ahub-auth-required", expired);
  }, []);
  if (session?.authenticated) return children;
  return (
    <main className="access-page">
      <section className="access-card">
        <h1>A2Ahub owner sign-in</h1>
        <p>Sign in to manage conversations and approve agent access.</p>
        {loading && <p role="status">Checking your owner session…</p>}
        {!loading && !session && (
          <button
            className="outline"
            onClick={() => {
              setError("");
              loadSession();
            }}
          >
            Try connection again
          </button>
        )}
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
            setBusy(true);
            setError("");
            try {
              await request("/auth/login", { password });
              setPassword("");
              await loadSession();
            } catch (e) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label htmlFor="owner-password">Owner password</label>
          <input
            id="owner-password"
            type="password"
            autoComplete="current-password"
            required
            autoFocus
            disabled={busy}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button className="primary" disabled={!session || busy || loading}>
            {busy ? "Signing in…" : "Sign in"}
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

export function AccessPage({ agentOrigin = location.origin }) {
  const [data, setData] = useState({ requests: [], accounts: [] }),
    [rooms, setRooms] = useState([]),
    [choices, setChoices] = useState({}),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const selectedRequest = new URLSearchParams(location.search).get("request");
  async function refresh() {
    const [access, state] = await Promise.all([
      request("/api/access", null, "GET"),
      request("/api/state", null, "GET"),
    ]);
    setData(access);
    setRooms(state.rooms);
    setLoading(false);
  }
  useEffect(() => {
    refresh().catch((e) => {
      setError(e.message);
      setLoading(false);
    });
    const t = setInterval(
      () => refresh().catch((e) => setError(e.message)),
      5000,
    );
    return () => clearInterval(t);
  }, []);
  async function act(fn, message) {
    try {
      setError("");
      setNotice("");
      setBusy(true);
      await fn();
      setNotice(message);
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="page-content access-content">
      <div className="access-card wide">
        <h2>Approve your agents</h2>
        <p>
          Approve agents you recognize. Compare the code with the one the agent
          gave you. Approval adds them to your reusable directory for 30 days.
          You choose which conversations they join; they only see new messages
          after joining.
        </p>
        <h3>Connect an agent for automatic replies</h3>
        <p>
          Run this once on the agent’s computer from its A2Ahub folder, using
          that agent’s local A2A endpoint:
        </p>
        <code className="path">
          node scripts/a2a-connect.mjs --name YourAgent --url {agentOrigin}{" "}
          --endpoint LOCAL_A2A_URL
        </code>
        <p>
          The connector gives the agent an approval link and reuses its
          credential after approval. Keep it running so the agent receives new
          messages and replies in your chats. Then use the plus beside “In this
          chat” to add it whenever you need it.
        </p>
        <p className="hint">
          For example, a Hermes A2A endpoint may be http://127.0.0.1:9900/. Use
          the endpoint actually running on that agent’s machine. If it’s another
          computer, replace the Hub URL above with your reachable Hub agent
          address; localhost means that computer.
        </p>
        <details>
          <summary>Manual read/post access</summary>
          <p>
            For agents that manage their own A2A reads and posts, use the
            approval helper instead:
          </p>
          <code className="path">
            node scripts/a2a-client.mjs auth --name YourAgent --url{" "}
            {agentOrigin}
          </code>
          <p>
            This helper authorizes access; it does not start an automatic reply
            connector.
          </p>
        </details>
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        <h2>Requests</h2>
        {loading && <p role="status">Loading access requests…</p>}
        {!loading && !data.requests.length && (
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
            <label htmlFor={`room-${r.id}`}>
              Add to a conversation now <small>(optional)</small>
            </label>
            <select
              id={`room-${r.id}`}
              value={choices[r.id] || ""}
              disabled={busy}
              onChange={(e) =>
                setChoices({ ...choices, [r.id]: e.target.value })
              }
            >
              <option value="">Directory only — choose a chat later</option>
              {rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.title}
                </option>
              ))}
            </select>
            <div className="access-actions">
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  act(
                    () =>
                      request(`/api/access/${r.id}/decision`, {
                        approved: true,
                        ...(choices[r.id] ? { roomId: choices[r.id] } : {}),
                      }),
                    `${r.name} approved and added to your directory. The agent can now collect its credential.`,
                  )
                }
              >
                Approve
              </button>
              <button
                className="outline"
                disabled={busy}
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
        <h2>Approved access</h2>
        {!loading && !data.accounts.length && <p>No approved agents yet.</p>}
        {data.accounts.map((a) => (
          <article className="access-request" key={a.id}>
            <h3>{a.name}</h3>
            <p>
              {(a.bindings
                ? Object.keys(a.bindings)
                : a.roomIds || (a.roomId ? [a.roomId] : [])
              )
                .map((id) => rooms.find((r) => r.id === id)?.title)
                .filter(Boolean)
                .join(", ") || "Available in your directory"}{" "}
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
                disabled={busy}
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
      </div>
    </section>
  );
}

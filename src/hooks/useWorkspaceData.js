import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";

// useWorkspaceData — owns the workspace SSE stream and the initial state
// fetch. Returns `{ data, setData }` and pushes connection problems into the
// supplied `setError` / `setOnline` callbacks so the host component owns the
// error banner and online indicator.
export function useWorkspaceData({ setError, setOnline }) {
  const [data, setData] = useState(null);
  const checkingAuth = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let receivedStream = false;
    api("/state", null, "GET")
      .then((d) => {
        if (!cancelled && !receivedStream) setData(d);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e.message);
          setOnline(false);
        }
      });
    const es = new EventSource("/api/events");
    es.addEventListener("auth-expired", () =>
      window.dispatchEvent(new Event("a2ahub-auth-required")),
    );
    es.onmessage = (e) => {
      try {
        receivedStream = true;
        setData(JSON.parse(e.data));
        setOnline(true);
      } catch {
        setError(
          "The workspace update could not be read. Refresh the page to reconnect.",
        );
      }
    };
    es.onerror = async () => {
      setOnline(false);
      if (checkingAuth.current) return;
      checkingAuth.current = true;
      try {
        const session = await fetch("/auth/session").then((r) => r.json());
        if (!cancelled && !session.authenticated)
          window.dispatchEvent(new Event("a2ahub-auth-required"));
      } catch {
        /* EventSource will retry a server outage. */
      } finally {
        checkingAuth.current = false;
      }
    };
    return () => {
      cancelled = true;
      es.close();
    };
  }, []);

  return { data, setData };
}

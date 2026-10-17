import React, { useState } from "react";
import { Dialog } from "../workspace.jsx";

export function PasswordDialog({ api, onClose, onDone }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mismatch = confirm && next !== confirm;
  return (
    <Dialog
      title="Change owner password"
      onClose={onClose}
      initialFocus="#current-password"
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await api("/admin/password", { current, next });
            onDone();
          } catch (err) {
            setError(err.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label htmlFor="current-password">Current password</label>
        <input
          id="current-password"
          type="password"
          autoComplete="current-password"
          required
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <label htmlFor="new-password">
          New password <small>(12 characters or more)</small>
        </label>
        <input
          id="new-password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={256}
          required
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
        <label htmlFor="confirm-password">Confirm new password</label>
        <input
          id="confirm-password"
          type="password"
          autoComplete="new-password"
          required
          aria-invalid={mismatch ? "true" : undefined}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        {mismatch && <p className="warning">The new passwords don’t match.</p>}
        {error && (
          <p className="banner" role="alert">
            {error}
          </p>
        )}
        <button
          className="primary"
          disabled={busy || next.length < 12 || next !== confirm}
        >
          {busy ? "Saving…" : "Change password"}
        </button>
      </form>
    </Dialog>
  );
}

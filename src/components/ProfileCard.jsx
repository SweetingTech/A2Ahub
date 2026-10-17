import React, { useEffect, useState } from "react";

export function ProfileCard({ profile, onSave, busy }) {
  const [name, setName] = useState(profile?.displayName || "You");
  const [notice, setNotice] = useState("");
  useEffect(
    () => setName(profile?.displayName || "You"),
    [profile?.displayName],
  );
  return (
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
  );
}

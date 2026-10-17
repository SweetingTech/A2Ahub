import React, { useState } from "react";
import { Dialog } from "../workspace.jsx";
import { FOLDER_COLORS } from "../ui.jsx";

export function FolderDialog({ folder, onSave, onClose, busy, error }) {
  const [name, setName] = useState(folder?.name || "");
  const [color, setColor] = useState(folder?.color || "teal");
  return (
    <Dialog
      title={folder ? "Edit folder" : "New folder"}
      onClose={onClose}
      initialFocus="#folder-name"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave({ name: name.trim(), color });
        }}
      >
        <label htmlFor="folder-name">Folder name</label>
        <input
          id="folder-name"
          value={name}
          maxLength={40}
          required
          onChange={(e) => setName(e.target.value)}
        />
        <fieldset className="swatch-picker">
          <legend>Color</legend>
          {FOLDER_COLORS.map((c) => (
            <label key={c} className={`swatch-option ${c}`}>
              <input
                type="radio"
                name="folder-color"
                value={c}
                checked={color === c}
                onChange={() => setColor(c)}
              />
              <span className="sr-only">{c}</span>
            </label>
          ))}
        </fieldset>
        {error && (
          <p className="banner" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy || !name.trim()}>
          {folder ? "Save folder" : "Create folder"}
        </button>
      </form>
    </Dialog>
  );
}

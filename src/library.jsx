import React, { useMemo, useState } from "react";
import {
  Archive,
  FolderPlus,
  MessageCircle,
  Pencil,
  Pin,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { Dialog } from "./workspace.jsx";
import { FOLDER_COLORS, when } from "./ui.jsx";
import { roomState } from "./conversations.jsx";

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

export function LibraryPage({
  rooms,
  folders,
  runs,
  busy,
  error,
  initialView,
  act,
  api,
  onOpen,
}) {
  const [view, setView] = useState(initialView || "all");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState([]);
  const [folderDialog, setFolderDialog] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const archivedView = view === "archived";
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rooms
      .filter((r) => (archivedView ? r.archived : !r.archived))
      .filter((r) =>
        view === "pinned"
          ? r.pinned
          : view.startsWith("folder:")
            ? r.folderId === view.slice(7)
            : true,
      )
      .filter((r) => !q || r.title.toLowerCase().includes(q))
      .sort(
        (a, b) =>
          new Date(b.messages.at(-1)?.createdAt || b.createdAt) -
          new Date(a.messages.at(-1)?.createdAt || a.createdAt),
      );
  }, [rooms, view, query, archivedView]);
  const selected = shown.filter((r) => picked.includes(r.id));
  const folderName = (id) => folders.find((f) => f.id === id)?.name;
  const heading = archivedView
    ? "Archived"
    : view === "pinned"
      ? "Pinned"
      : view.startsWith("folder:")
        ? folderName(view.slice(7)) || "Folder"
        : "All conversations";
  const count = (fn) => rooms.filter((r) => !r.archived && fn(r)).length;
  const bulk = (fn) =>
    act(async () => {
      for (const r of selected) await fn(r);
      setPicked([]);
    });
  const viewButton = (id, label, n, extra) => (
    <button
      className={`library-view ${view === id ? "current" : ""}`}
      aria-current={view === id ? "true" : undefined}
      onClick={() => {
        setView(id);
        setPicked([]);
      }}
    >
      {extra}
      <span className="library-view-name">{label}</span>
      <span className="count">{n}</span>
    </button>
  );
  const currentFolder = view.startsWith("folder:")
    ? folders.find((f) => f.id === view.slice(7))
    : null;
  return (
    <section className="page-content library-page" aria-label="Library">
      <aside className="library-views" aria-label="Library views">
        {viewButton(
          "all",
          "All conversations",
          count(() => true),
          <MessageCircle size={16} />,
        )}
        {viewButton(
          "pinned",
          "Pinned",
          count((r) => r.pinned),
          <Pin size={16} />,
        )}
        <h2 className="library-group">Folders</h2>
        {folders.map((f) =>
          viewButton(
            `folder:${f.id}`,
            f.name,
            count((r) => r.folderId === f.id),
            <span className={`folder-swatch ${f.color}`} aria-hidden="true" />,
          ),
        )}
        <button className="new-folder" onClick={() => setFolderDialog({})}>
          <FolderPlus size={16} /> New folder
        </button>
        <div className="library-spacer" />
        {viewButton(
          "archived",
          "Archived",
          rooms.filter((r) => r.archived).length,
          <Archive size={16} />,
        )}
      </aside>
      <div className="library-main">
        <div className="library-header">
          <h2>{heading}</h2>
          {currentFolder && (
            <>
              <button
                className="icon"
                aria-label={`Edit folder ${currentFolder.name}`}
                onClick={() => setFolderDialog(currentFolder)}
              >
                <Pencil size={16} />
              </button>
              <button
                className="icon"
                aria-label={`Delete folder ${currentFolder.name}`}
                title="Delete folder (its conversations become unfiled)"
                onClick={() =>
                  act(async () => {
                    await api(`/folders/${currentFolder.id}`, null, "DELETE");
                    setView("all");
                  })
                }
              >
                <Trash2 size={16} />
              </button>
            </>
          )}
          <label className="search-label library-search">
            <Search size={16} aria-hidden="true" />
            <span className="sr-only">Search conversations</span>
            <input
              type="search"
              placeholder="Search conversations"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>
        {archivedView && (
          <p className="library-note">
            Archived conversations are out of your sidebar but never deleted.
            They are read-only and paused: agents receive nothing until you
            restore them, and restoring does not resume agents.
          </p>
        )}
        {error && (
          <p className="banner" role="alert">
            {error}
          </p>
        )}
        {selected.length > 0 && (
          <div
            className="bulk-bar"
            role="toolbar"
            aria-label="Selection actions"
          >
            <strong>{selected.length} selected</strong>
            {!archivedView && (
              <>
                <label className="bulk-move">
                  <span className="sr-only">Move to folder</span>
                  <select
                    value=""
                    disabled={busy}
                    onChange={(e) => {
                      const folderId =
                        e.target.value === "none" ? null : e.target.value;
                      bulk((r) => api(`/rooms/${r.id}`, { folderId }, "PATCH"));
                    }}
                  >
                    <option value="" disabled>
                      Move to folder…
                    </option>
                    {folders.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                    <option value="none">No folder</option>
                  </select>
                </label>
                <button
                  className="outline"
                  disabled={busy}
                  onClick={() =>
                    bulk((r) =>
                      api(
                        `/rooms/${r.id}`,
                        { pinned: !selected.every((s) => s.pinned) },
                        "PATCH",
                      ),
                    )
                  }
                >
                  <Pin size={14} />
                  {selected.every((s) => s.pinned) ? "Unpin" : "Pin"}
                </button>
                <button
                  className="primary"
                  disabled={
                    busy || selected.some((r) => roomState(r, runs) === "live")
                  }
                  title={
                    selected.some((r) => roomState(r, runs) === "live")
                      ? "Stop active agents before archiving"
                      : undefined
                  }
                  onClick={() => bulk((r) => api(`/rooms/${r.id}/archive`))}
                >
                  <Archive size={14} />
                  Archive {selected.length}
                </button>
              </>
            )}
            {archivedView && (
              <>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => bulk((r) => api(`/rooms/${r.id}/unarchive`))}
                >
                  Restore {selected.length}
                </button>
                <button
                  className="outline danger"
                  disabled={busy}
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 size={14} />
                  Delete permanently…
                </button>
              </>
            )}
            <button
              className="icon"
              aria-label="Clear selection"
              onClick={() => setPicked([])}
            >
              <X size={16} />
            </button>
          </div>
        )}
        <div className="table-wrap">
          <table className="library-table">
            <thead>
              <tr>
                <th scope="col" className="check-col">
                  <input
                    type="checkbox"
                    aria-label="Select all shown conversations"
                    checked={!!shown.length && selected.length === shown.length}
                    onChange={(e) =>
                      setPicked(e.target.checked ? shown.map((r) => r.id) : [])
                    }
                  />
                </th>
                <th scope="col">Conversation</th>
                <th scope="col">Folder</th>
                <th scope="col" className="num-col">
                  Agents
                </th>
                <th scope="col">
                  {archivedView ? "Archived" : "Last activity"}
                </th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const state = roomState(r, runs);
                const folder = folders.find((f) => f.id === r.folderId);
                return (
                  <tr
                    key={r.id}
                    className={picked.includes(r.id) ? "picked" : ""}
                  >
                    <td className="check-col">
                      <input
                        type="checkbox"
                        aria-label={`Select ${r.title}`}
                        checked={picked.includes(r.id)}
                        onChange={(e) =>
                          setPicked((old) =>
                            e.target.checked
                              ? [...old, r.id]
                              : old.filter((id) => id !== r.id),
                          )
                        }
                      />
                    </td>
                    <td>
                      <button
                        className="link-button"
                        onClick={() => onOpen(r.id)}
                      >
                        {r.title}
                      </button>
                      {r.pinned && (
                        <Pin
                          size={12}
                          className="room-pin"
                          aria-label="Pinned"
                        />
                      )}
                      {state === "live" && (
                        <span className="pill pill-info">live</span>
                      )}
                      {state === "paused" && !r.archived && (
                        <span className="pill pill-warn">paused</span>
                      )}
                    </td>
                    <td>
                      {folder ? (
                        <span className="folder-cell">
                          <span
                            className={`folder-swatch ${folder.color}`}
                            aria-hidden="true"
                          />
                          {folder.name}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="num-col">{r.agentIds.length}</td>
                    <td>
                      {when(
                        archivedView
                          ? r.archivedAt
                          : r.messages.at(-1)?.createdAt || r.createdAt,
                      )}
                    </td>
                    <td className="row-actions">
                      {r.archived ? (
                        <button
                          className="outline small"
                          disabled={busy}
                          onClick={() =>
                            act(() => api(`/rooms/${r.id}/unarchive`))
                          }
                        >
                          Restore
                        </button>
                      ) : (
                        <button
                          className="outline small"
                          disabled={busy || state === "live"}
                          onClick={() =>
                            act(() => api(`/rooms/${r.id}/archive`))
                          }
                        >
                          Archive
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!shown.length && (
            <p className="library-empty">
              {archivedView
                ? "Nothing archived. Archive a settled conversation to tidy your sidebar."
                : query
                  ? "No conversations match."
                  : "No conversations here yet."}
            </p>
          )}
        </div>
      </div>
      {folderDialog && (
        <FolderDialog
          folder={folderDialog.id ? folderDialog : null}
          busy={busy}
          error={error}
          onClose={() => setFolderDialog(null)}
          onSave={(fields) =>
            act(async () => {
              if (folderDialog.id)
                await api(`/folders/${folderDialog.id}`, fields, "PATCH");
              else {
                const created = await api("/folders", fields);
                setView(`folder:${created.id}`);
              }
              setFolderDialog(null);
            })
          }
        />
      )}
      {confirmDelete && (
        <Dialog
          title="Delete permanently?"
          onClose={() => setConfirmDelete(false)}
          initialFocus=".modal .outline"
        >
          <p>
            This removes {selected.length} archived conversation
            {selected.length === 1 ? "" : "s"} and their history from this
            computer. It cannot be undone. Agents lose access to them.
          </p>
          <ul className="delete-list">
            {selected.map((r) => (
              <li key={r.id}>{r.title}</li>
            ))}
          </ul>
          <div className="dialog-actions">
            <button className="outline" onClick={() => setConfirmDelete(false)}>
              Keep them
            </button>
            <button
              className="primary danger"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  for (const r of selected)
                    await api(`/rooms/${r.id}`, null, "DELETE");
                  setPicked([]);
                  setConfirmDelete(false);
                })
              }
            >
              <Trash2 size={15} />
              Delete {selected.length} permanently
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}

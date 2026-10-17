import React from "react";
import { Archive, Pin, Trash2, X } from "lucide-react";
import { roomState } from "../conversations.jsx";
import { when } from "../ui.jsx";

export function BulkBar({
  selected,
  archivedView,
  busy,
  folders,
  runs,
  bulk,
  api,
  setPicked,
  setConfirmDelete,
}) {
  return (
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
  );
}

export function LibraryTable({
  shown,
  picked,
  setPicked,
  folders,
  runs,
  archivedView,
  busy,
  onOpen,
  api,
  act,
  query,
}) {
  return (
    <div className="table-wrap">
      <table className="library-table">
        <thead>
          <tr>
            <th scope="col" className="check-col">
              <input
                type="checkbox"
                aria-label="Select all shown conversations"
                checked={!!shown.length && picked.length === shown.length}
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
  );
}

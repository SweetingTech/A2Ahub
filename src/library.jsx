import React, { useMemo, useState } from "react";
import {
  Archive,
  FolderPlus,
  MessageCircle,
  Pencil,
  Pin,
  Search,
  Trash2,
} from "lucide-react";
import { Dialog } from "./workspace.jsx";
import { FolderDialog } from "./components/FolderDialog.jsx";
import { BulkBar, LibraryTable } from "./components/LibraryTable.jsx";

export { FolderDialog };

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
          <BulkBar
            selected={selected}
            archivedView={archivedView}
            busy={busy}
            folders={folders}
            runs={runs}
            bulk={bulk}
            api={api}
            setPicked={setPicked}
            setConfirmDelete={setConfirmDelete}
          />
        )}
        <LibraryTable
          shown={shown}
          picked={picked}
          setPicked={setPicked}
          folders={folders}
          runs={runs}
          archivedView={archivedView}
          busy={busy}
          onOpen={onOpen}
          api={api}
          act={act}
          query={query}
        />
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

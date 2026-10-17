import { AgentPicker, Dialog } from "../workspace.jsx";
import { FolderDialog } from "../library.jsx";

// AppDialogs — the picker, folder, and rename dialogs rendered at the end of
// the app shell. Each is conditional on its own flag; the host owns all the
// state and handlers.
export function AppDialogs({
  // agent picker
  picker,
  room,
  participants,
  selected,
  busy,
  online,
  roomActive,
  error,
  choose,
  setPicker,
  navigate,
  // folder dialog
  folderDialog,
  setFolderDialog,
  action,
  api,
  // rename dialog
  renameRoom,
  setRenameRoom,
  roomTitle,
  setRoomTitle,
  settings,
  setData,
}) {
  return (
    <>
      {picker && room && (
        <AgentPicker
          participants={participants}
          selected={selected}
          roomTitle={room.title}
          busy={busy || !online}
          locked={roomActive}
          error={error}
          onChoose={choose}
          onClose={() => setPicker(false)}
          onAccess={() => {
            setPicker(false);
            navigate("/access");
          }}
        />
      )}
      {folderDialog && (
        <FolderDialog
          busy={busy}
          error={error}
          onClose={() => setFolderDialog(false)}
          onSave={(fields) =>
            action(async () => {
              await api("/folders", fields);
              setFolderDialog(false);
            })
          }
        />
      )}
      {renameRoom && (
        <Dialog
          title="Rename conversation"
          onClose={() => setRenameRoom(null)}
          initialFocus="#conversation-title"
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              action(async () => {
                await settings({ title: roomTitle.trim() }, renameRoom);
                setData(await api("/state", null, "GET"));
                setRenameRoom(null);
              });
            }}
          >
            <label htmlFor="conversation-title">Conversation name</label>
            <input
              id="conversation-title"
              value={roomTitle}
              maxLength={100}
              required
              onChange={(event) => setRoomTitle(event.target.value)}
            />
            {error && (
              <p className="banner" role="alert">
                {error}
              </p>
            )}
            <button className="primary" disabled={busy || !roomTitle.trim()}>
              {busy ? "Saving…" : "Save name"}
            </button>
          </form>
        </Dialog>
      )}
    </>
  );
}

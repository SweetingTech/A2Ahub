import { AlertCircle, Archive, Plus, X } from "lucide-react";
import { AccessPage } from "../access.jsx";
import { AgentDirectory, pages } from "../workspace.jsx";
import { LibraryPage } from "../library.jsx";
import { AdminPage } from "../admin.jsx";
import { SettingsPage } from "../settings.jsx";
import { ChatArea } from "./ChatArea.jsx";
import { Composer } from "./Composer.jsx";

const BrandMark = ({ size = 22 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <circle cx="18" cy="5" r="2.6" />
    <circle cx="6" cy="12" r="2.6" />
    <circle cx="18" cy="19" r="2.6" />
    <path d="M8.3 10.7l7.4-4.3M8.3 13.3l7.4 4.3" />
  </svg>
);

// PageRouter — the <main> content region: connection/error banners, the
// routed page (agents / access / library / admin / settings / 404), and the
// chat page (empty state or ChatArea + Composer). All state and handlers are
// supplied by the host.
export function PageRouter({
  // banner / routing
  online,
  error,
  modal,
  picker,
  renameRoom,
  folderDialog,
  path,
  search,
  query,
  setError,
  navigate,
  // data
  data,
  participants,
  rooms,
  folders,
  runs,
  room,
  agent,
  archived,
  selected,
  relay,
  limit,
  roomActive,
  active,
  run,
  roomRuns,
  otherRoomActive,
  talkingIds,
  queuedIds,
  meterRun,
  nameOf,
  members,
  waitingConversations,
  offlineConversations,
  offlineConnectors,
  // chat compose
  text,
  setText,
  canSend,
  dropping,
  setDropping,
  choose,
  settings,
  submit,
  action,
  api,
  setPicker,
  setModal,
  setInspected,
  setDetailsTab,
  setInspectOpen,
  setRoomTitle,
  setRenameRoom,
  appearance,
  setAppearance,
  setSearch,
  setData,
  openRoom,
  newConversation,
  bottom,
  composer,
}) {
  const chatPage = path === "/";
  return (
    <main id="main-content">
      {!online && (
        <div className="banner" role="alert">
          Connection to A2Ahub lost. Reconnecting…
        </div>
      )}
      {error && !modal && !picker && !renameRoom && !folderDialog && (
        <div className="banner" role="alert">
          <AlertCircle size={18} />
          {error}
          <button
            className="icon"
            aria-label="Dismiss error"
            onClick={() => setError("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {path === "/agents" && (
        <AgentDirectory
          participants={participants}
          selected={selected}
          roomTitle={archived ? undefined : room?.title}
          roomId={archived ? undefined : room?.id}
          agentConnectionUrl={
            data.agentConnectionUrl || data.agentOrigin || location.origin
          }
          setupAgentName={agent?.kind === "inbound" ? agent.name : undefined}
          busy={busy || !online}
          locked={roomActive}
          onChoose={choose}
          onConnect={() => {
            setError("");
            setModal(true);
          }}
          onInspect={(id) => {
            setInspected(id);
            setDetailsTab("agent");
            setInspectOpen(true);
          }}
          onAccess={() => navigate("/access")}
          onConversation={() => navigate("/")}
        />
      )}
      {path === "/access" && (
        <AccessPage
          agentOrigin={data.agentOrigin}
          onAgents={() => navigate("/agents")}
        />
      )}
      {path === "/library" && (
        <LibraryPage
          key={search}
          rooms={rooms}
          folders={folders}
          runs={runs}
          busy={busy || !online}
          error={error}
          initialView={query.get("view") || "all"}
          act={action}
          api={api}
          onOpen={openRoom}
        />
      )}
      {path === "/admin" && (
        <AdminPage
          api={api}
          refreshKey={`${runs.length}-${runs.filter((r) => r.state === "running").length}-${data.pendingRequests}`}
          navigate={navigate}
          openRoom={openRoom}
        />
      )}
      {path === "/settings" && (
        <SettingsPage
          profile={data.profile}
          busy={busy || !online}
          tab={query.get("tab") || "profile"}
          setTab={(tab) => {
            history.replaceState({}, "", `/settings?tab=${tab}`);
            setSearch(`?tab=${tab}`);
          }}
          appearance={appearance}
          setAppearance={setAppearance}
          api={api}
          onSave={(displayName) =>
            action(async () => {
              await api("/profile", { displayName }, "PATCH");
              setData(await api("/state", null, "GET"));
            })
          }
          onLogout={() =>
            action(async () => {
              const r = await fetch("/auth/logout", { method: "POST" });
              if (!r.ok)
                throw new Error("Sign-out failed. Please try again.");
              window.dispatchEvent(new Event("a2ahub-auth-required"));
            })
          }
        />
      )}
      {!pages.some((p) => p.path === path) && (
        <section className="page-content page-empty">
          <h2>This page isn’t here</h2>
          <p>Your conversations and agents are still available.</p>
          <button className="primary" onClick={() => navigate("/")}>
            Go to conversations
          </button>
        </section>
      )}
      {chatPage && !room && (
        <section className="page-content page-empty">
          <span className="brand-mark large">
            <BrandMark size={34} />
          </span>
          <h2>No open conversations</h2>
          <p>Start a new one, or restore one from the archive.</p>
          <div className="page-actions center">
            <button className="primary" onClick={newConversation}>
              <Plus size={16} /> New conversation
            </button>
            <button
              className="outline"
              onClick={() => navigate("/library?view=archived")}
            >
              <Archive size={16} /> Open archive
            </button>
          </div>
        </section>
      )}
      {chatPage && room && (
        <>
          <ChatArea
            room={room}
            bottom={bottom}
            archived={archived}
            setText={setText}
            composer={composer}
          />
          <Composer
            room={room}
            archived={archived}
            busy={busy}
            online={online}
            roomActive={roomActive}
            otherRoomActive={otherRoomActive}
            run={run}
            relay={relay}
            limit={limit}
            selected={selected}
            members={members}
            text={text}
            setText={setText}
            canSend={canSend}
            dropping={dropping}
            setDropping={setDropping}
            waitingConversations={waitingConversations}
            offlineConversations={offlineConversations}
            offlineConnectors={offlineConnectors}
            talkingIds={talkingIds}
            queuedIds={queuedIds}
            nameOf={nameOf}
            choose={choose}
            settings={settings}
            submit={submit}
            action={action}
            api={api}
            navigate={navigate}
            setError={setError}
            setPicker={setPicker}
            composerRef={composer}
          />
        </>
      )}
    </main>
  );
}

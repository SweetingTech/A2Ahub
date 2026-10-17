import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/instrument-sans/wght.css";
import "@fontsource-variable/bricolage-grotesque/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "@fontsource/atkinson-hyperlegible/latin-400.css";
import "@fontsource/atkinson-hyperlegible/latin-700.css";
import "./style.css";
import { OwnerGate } from "./access.jsx";
import { Navigation, connectionStatus, pages } from "./workspace.jsx";
import { api, readStored, storeLocal } from "./api.js";
import {
  applyAppearance,
  loadAppearance,
  saveAppearance,
} from "./appearance.js";
import { useWorkspaceData } from "./hooks/useWorkspaceData.js";
import { Rail, BrandMark } from "./components/Rail.jsx";
import { RoomDetails } from "./components/RoomDetails.jsx";
import { PageHeader } from "./components/PageHeader.jsx";
import { PageRouter } from "./components/PageRouter.jsx";
import { Inspector } from "./components/Inspector.jsx";
import { AppDialogs } from "./components/AppDialogs.jsx";
import { AddAgentDialog } from "./components/AddAgentDialog.jsx";

// Apply saved appearance before the first paint to avoid a flash of the
// default theme for people who rely on high contrast or large text.
applyAppearance(loadAppearance());

function App() {
  const [roomId, setRoomId] = useState(() => readStored("a2ahub-room", "")),
    [drafts, setDrafts] = useState(() => readStored("a2ahub-drafts", {})),
    [path, setPath] = useState(location.pathname),
    [search, setSearch] = useState(location.search),
    [modal, setModal] = useState(false),
    [picker, setPicker] = useState(false),
    [renameRoom, setRenameRoom] = useState(null),
    [roomTitle, setRoomTitle] = useState(""),
    [folderDialog, setFolderDialog] = useState(false),
    [dropping, setDropping] = useState(false),
    [url, setUrl] = useState(""),
    [tokenEnv, setTokenEnv] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [inspected, setInspected] = useState(""),
    [mobile, setMobile] = useState(false),
    [online, setOnline] = useState(true),
    [inspectOpen, setInspectOpen] = useState(false),
    [detailsTab, setDetailsTab] = useState(() =>
      readStored("a2ahub-details-tab", "room"),
    ),
    [appearance, setAppearanceState] = useState(loadAppearance);
  const bottom = useRef(null),
    composer = useRef(null),
    pageHeading = useRef(null),
    menuButton = useRef(null),
    inspector = useRef(null),
    searchBox = useRef(null),
    acceptDrop = useRef(null);
  const { data, setData } = useWorkspaceData({ setError, setOnline });
  const query = new URLSearchParams(search);
  function setAppearance(next) {
    setAppearanceState(next);
    saveAppearance(next);
    applyAppearance(next);
  }
  useEffect(() => {
    if (!appearance.followSystem || typeof matchMedia !== "function") return;
    const media = matchMedia("(prefers-color-scheme: dark)");
    const change = () => applyAppearance(appearance);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, [appearance]);
  useEffect(() => {
    const dropped = (event) => acceptDrop.current?.(event.detail);
    window.addEventListener("a2ahub-agent-drop", dropped);
    return () => window.removeEventListener("a2ahub-agent-drop", dropped);
  }, []);
  function navigate(next) {
    history.pushState({}, "", next);
    const target = new URL(next, location.origin);
    setPath(target.pathname);
    setSearch(target.search);
    setMobile(false);
    setInspectOpen(false);
    setPicker(false);
    setModal(false);
    setRenameRoom(null);
    setError("");
  }
  useEffect(() => {
    const change = () => {
      setPath(location.pathname);
      setSearch(location.search);
      setMobile(false);
      setInspectOpen(false);
      setPicker(false);
      setModal(false);
      setRenameRoom(null);
    };
    window.addEventListener("popstate", change);
    return () => window.removeEventListener("popstate", change);
  }, []);
  useEffect(() => storeLocal("a2ahub-room", roomId), [roomId]);
  useEffect(() => storeLocal("a2ahub-drafts", drafts), [drafts]);
  useEffect(() => storeLocal("a2ahub-details-tab", detailsTab), [detailsTab]);
  useEffect(() => {
    pageHeading.current?.focus();
  }, [path]);
  // Ctrl/Cmd+K jumps to conversation search from anywhere.
  useEffect(() => {
    function shortcut(event) {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k")
        return;
      if (modal || picker || renameRoom || folderDialog) return;
      event.preventDefault();
      if (location.pathname !== "/") navigate("/");
      if (window.matchMedia?.("(max-width: 700px)").matches) setMobile(true);
      requestAnimationFrame(() => searchBox.current?.focus());
    }
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, [modal, picker, renameRoom, folderDialog]);
  useEffect(() => {
    if (!mobile && !inspectOpen) return;
    const previous = document.activeElement;
    if (inspectOpen) inspector.current?.focus();
    else document.querySelector(".sidebar .mobile-close")?.focus();
    const escape = (event) => {
      if (event.key !== "Escape" || modal || picker) return;
      if (document.querySelector(".menu")) return;
      setMobile(false);
      setInspectOpen(false);
    };
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("keydown", escape);
      if (mobile) menuButton.current?.focus();
      else if (previous?.isConnected) previous.focus();
    };
  }, [mobile, inspectOpen, modal, picker]);
  const participants =
    data?.participants ||
    data?.agents?.map((a) => ({ ...a, kind: "endpoint" })) ||
    [];
  const rooms = data?.rooms || [],
    folders = data?.folders || [],
    runs = data?.runs || [];
  const room =
      rooms.find((r) => r.id === roomId) || rooms.find((r) => !r.archived),
    agent = participants.find((a) => a.id === inspected) || participants[0];
  const archived = !!room?.archived;
  const text = drafts[room?.id] || "";
  const setText = (value) => {
    if (room) setDrafts((old) => ({ ...old, [room.id]: value }));
  };
  const ownerName = data?.profile?.displayName || "You";
  const pageTitle =
    pages.find((p) => p.path === path)?.title || "Page not found";
  const active = runs.find((r) => ["running", "stopping"].includes(r.state)),
    run = [...runs].reverse().find((r) => r.roomId === room?.id);
  const selected = room?.agentIds || [],
    members = participants.filter((a) => selected.includes(a.id)),
    relay = room?.agentChat ?? true,
    limit = room?.replyLimit || 6,
    roomRuns = runs.filter(
      (r) => r.roomId === room?.id && ["running", "stopping"].includes(r.state),
    ),
    roomActive = roomRuns.length > 0,
    otherRoomActive = active && active.roomId !== room?.id,
    talkingIds = [...new Set(roomRuns.flatMap((r) => r.activeAgentIds))],
    queuedIds = [...new Set(roomRuns.flatMap((r) => r.queuedAgentIds))];
  const meterRun = roomRuns.at(-1) || run;
  const nameOf = (id) => participants.find((a) => a.id === id)?.name || "Agent";
  const waitingConversations = members.filter(
    (a) =>
      a.receiver?.kind === "session" && connectionStatus(a) === "unchecked",
  );
  const offlineConversations = members.filter(
    (a) =>
      a.receiver?.kind === "session" &&
      !["connected", "unchecked"].includes(connectionStatus(a)),
  );
  const offlineConnectors = members.filter(
    (a) =>
      a.kind === "inbound" &&
      a.receiver?.kind !== "session" &&
      a.status !== "connected",
  );
  useEffect(() => {
    bottom.current?.scrollIntoView({
      behavior: appearance.reduceMotion ? "auto" : "smooth",
    });
  }, [room?.messages.length, room?.messages.at(-1)?.text]);
  async function action(fn) {
    setError("");
    setBusy(true);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  function settings(change, target = room) {
    return api(`/rooms/${target.id}`, change, "PATCH");
  }
  function choose(id, include = !selected.includes(id)) {
    if (
      !room ||
      archived ||
      busy ||
      roomActive ||
      !participants.some((a) => a.id === id)
    )
      return;
    if (include && (selected.includes(id) || selected.length >= 6)) return;
    const agentIds = include
      ? [...selected, id]
      : selected.filter((x) => x !== id);
    return action(async () => {
      await settings({
        agentIds,
        replyLimit: Math.max(limit, agentIds.length),
      });
      setData(await api("/state", null, "GET"));
    });
  }
  acceptDrop.current = (detail) => {
    if (path === "/" && detail?.roomId === room?.id)
      choose(detail.agentId, true);
  };
  async function submit(e) {
    e.preventDefault();
    await action(async () => {
      await api("/runs", {
        roomId: room.id,
        text,
      });
      setDrafts((old) =>
        old[room.id] === text ? { ...old, [room.id]: "" } : old,
      );
    });
  }
  const addAgent = (e) => {
    e.preventDefault();
    action(async () => {
      const a = await api("/agents", { url, tokenEnv });
      setInspected(a.id);
      setData(await api("/state", null, "GET"));
      setModal(false);
      setUrl("");
      setTokenEnv("");
    });
  };
  const openRoom = (id) => {
    setRoomId(id);
    navigate("/");
  };
  const newConversation = () =>
    action(async () => {
      const r = await api("/rooms");
      setRoomId(r.id);
      navigate("/");
      requestAnimationFrame(() => composer.current?.focus());
    });
  const canSend =
    !busy &&
    online &&
    !otherRoomActive &&
    !room?.paused &&
    !archived &&
    text.trim() &&
    selected.length;
  if (!data)
    return (
      <div className="loading">
        <span className="brand-mark large">
          <BrandMark size={34} />
        </span>
        Connecting to your local workspace…
        {!online && <p>Server unavailable. Start A2Ahub with npm start.</p>}
      </div>
    );
  const badges = {
    "/access": data.pendingRequests || 0,
  };
  const chatPage = path === "/";
  return (
    <div className={`app ${chatPage ? "chat-page" : "managed-page"}`}>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <Rail
        path={path}
        navigate={navigate}
        badges={badges}
        ownerName={ownerName}
      />
      <RoomDetails
        mobile={mobile}
        busy={busy}
        online={online}
        rooms={rooms}
        folders={folders}
        runs={runs}
        chatPage={chatPage}
        room={room}
        participants={participants}
        setMobile={setMobile}
        setRoomTitle={setRoomTitle}
        setError={setError}
        setRenameRoom={setRenameRoom}
        setFolderDialog={setFolderDialog}
        openRoom={openRoom}
        action={action}
        settings={settings}
        api={api}
        navigate={navigate}
        searchBox={searchBox}
        setInspected={setInspected}
        setDetailsTab={setDetailsTab}
        setInspectOpen={setInspectOpen}
        newConversation={newConversation}
      />
      <PageHeader
        menuButtonRef={menuButton}
        pageHeadingRef={pageHeading}
        chatPage={chatPage}
        room={room}
        pageTitle={pageTitle}
        archived={archived}
        selected={selected}
        relay={relay}
        busy={busy}
        online={online}
        roomActive={roomActive}
        active={active}
        meterRun={meterRun}
        roomRuns={roomRuns}
        inspectOpen={inspectOpen}
        mobile={mobile}
        setMobile={setMobile}
        setRoomTitle={setRoomTitle}
        setError={setError}
        setRenameRoom={setRenameRoom}
        setInspectOpen={setInspectOpen}
        action={action}
        api={api}
      />
      <PageRouter
        online={online}
        error={error}
        modal={modal}
        picker={picker}
        renameRoom={renameRoom}
        folderDialog={folderDialog}
        path={path}
        search={search}
        query={query}
        setError={setError}
        navigate={navigate}
        data={data}
        participants={participants}
        rooms={rooms}
        folders={folders}
        runs={runs}
        room={room}
        agent={agent}
        archived={archived}
        selected={selected}
        relay={relay}
        limit={limit}
        roomActive={roomActive}
        active={active}
        run={run}
        otherRoomActive={otherRoomActive}
        talkingIds={talkingIds}
        queuedIds={queuedIds}
        nameOf={nameOf}
        members={members}
        waitingConversations={waitingConversations}
        offlineConversations={offlineConversations}
        offlineConnectors={offlineConnectors}
        text={text}
        setText={setText}
        canSend={canSend}
        dropping={dropping}
        setDropping={setDropping}
        choose={choose}
        settings={settings}
        submit={submit}
        action={action}
        api={api}
        setPicker={setPicker}
        setModal={setModal}
        setInspected={setInspected}
        setDetailsTab={setDetailsTab}
        setInspectOpen={setInspectOpen}
        appearance={appearance}
        setAppearance={setAppearance}
        setSearch={setSearch}
        setData={setData}
        openRoom={openRoom}
        newConversation={newConversation}
        bottom={bottom}
        composer={composer}
      />
      <Inspector
        inspectorRef={inspector}
        inspectOpen={inspectOpen}
        setInspectOpen={setInspectOpen}
        detailsTab={detailsTab}
        setDetailsTab={setDetailsTab}
        room={room}
        folders={folders}
        relay={relay}
        limit={limit}
        roomActive={roomActive}
        meterRun={meterRun}
        talkingIds={talkingIds}
        queuedIds={queuedIds}
        nameOf={nameOf}
        agent={agent}
        rooms={rooms}
        busy={busy}
        active={active}
        action={action}
        api={api}
        navigate={navigate}
      />
      <Navigation
        path={path}
        navigate={navigate}
        badges={badges}
        className="tabbar"
        only={["/", "/agents", "/access", "/admin", "/settings"]}
      />
      <AppDialogs
        picker={picker}
        room={room}
        participants={participants}
        selected={selected}
        busy={busy}
        online={online}
        roomActive={roomActive}
        error={error}
        choose={choose}
        setPicker={setPicker}
        navigate={navigate}
        folderDialog={folderDialog}
        setFolderDialog={setFolderDialog}
        action={action}
        api={api}
        renameRoom={renameRoom}
        setRenameRoom={setRenameRoom}
        roomTitle={roomTitle}
        setRoomTitle={setRoomTitle}
        settings={settings}
        setData={setData}
      />
      <AddAgentDialog
        modal={modal}
        setModal={setModal}
        url={url}
        setUrl={setUrl}
        tokenEnv={tokenEnv}
        setTokenEnv={setTokenEnv}
        error={error}
        busy={busy}
        addAgent={addAgent}
      />
    </div>
  );
}
createRoot(document.getElementById("root")).render(
  <OwnerGate>
    <App />
  </OwnerGate>,
);

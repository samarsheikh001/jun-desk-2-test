import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BookOpenIcon, BotIcon, ChartColumnIcon, ChatIcon, FlashIcon, HelpIcon, InboxIcon, SearchIcon, SettingsIcon, SignOutIcon, UsersIcon } from "@/components/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@/components/ui/dropdown-menu.tsx";
import { ScrollArea } from "@/components/ui/scroll-area.tsx";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuBadge,
  SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem, SidebarProvider, SidebarTrigger, useSidebar,
} from "@/components/ui/sidebar.tsx";
import { DeskIcon } from "./components/DeskIcon.tsx";
import { PageErrorBoundary } from "./components/PageErrorBoundary.tsx";
import { ThemeButton } from "./components/ThemeButton.tsx";
import type { HubClientEvent, HubEvent, LiveVisitor, PresenceEntry } from "../shared/protocol.ts";
import { api, type Me } from "./api.ts";
import { InboxPage } from "./inbox/InboxPage.tsx";
import { WidgetPage } from "./appearance/AppearancePage.tsx";
import { AGENT_SECTIONS, AgentPage, agentSection, movedFromAgentCode } from "./agent/AgentPage.tsx";
import { CommandPalette, ShortcutsHelp } from "./components/CommandPalette.tsx";
import { bridge, isControlTarget, isTypingTarget, modKey } from "./lib/bridge.ts";
import { dispatchShortcut, INITIAL_SHORTCUT_STATE, type ShortcutCommand } from "./lib/commands.ts";
import { KnowledgePage } from "./knowledge/KnowledgePage.tsx";
import { deskServiceWorker, listenForNotificationClicks, notificationPermission, showInPageNotification, tabFocused } from "./lib/notifications.ts";
import { LiveSocket } from "./lib/socket.ts";
import { playChime, unlockSoundOnInteraction } from "./lib/sound.ts";
import { ReportsPage } from "./reports/ReportsPage.tsx";
import { navigate, usePath } from "./lib/router.ts";
import { movedFromSettings, SettingsDialog } from "./SettingsDialog.tsx";
import { VisitorsPage } from "./visitors/VisitorsPage.tsx";
import { STEP_ORDER, useOnboarding, WelcomePage } from "./welcome/WelcomePage.tsx";
import { GetStartedCard } from "./welcome/GetStartedCard.tsx";

const NAV = [
  { id: "dashboard", label: "Dashboard", Icon: ChartColumnIcon },
  { id: "inbox", label: "Inbox", Icon: InboxIcon },
  { id: "visitors", label: "Visitors", Icon: UsersIcon },
  { id: "knowledge", label: "Knowledge", Icon: BookOpenIcon },
  { id: "agent", label: "Agent", Icon: BotIcon },
  { id: "appearance", label: "Chat widget", Icon: ChatIcon },
] as const;

export interface Hub {
  subscribe(listener: (event: HubEvent) => void): () => void;
}

/** Signed-in layout: header, navigation, the workspace hub socket, and the current page. */
export function Shell({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  // Old /settings links to the parts that moved out (widget install, AI settings, the ChatGPT
  // sign-in's return). Loading one: the address is rewritten before the first render. Following
  // one inside the desk: rendered as its new page at once (the dialog never flashes), and the
  // address is replaced before paint.
  useState(() => {
    const { pathname, search, hash } = window.location;
    const target = movedFromSettings(pathname, search, hash) ?? movedFromAgentCode(pathname);
    if (target) window.history.replaceState(null, "", target);
  });
  const urlPath = usePath();
  const moved = movedFromSettings(urlPath, window.location.search, window.location.hash) ?? movedFromAgentCode(urlPath);
  const path = moved ? moved.split("?")[0]! : urlPath;
  useLayoutEffect(() => {
    if (moved) navigate(moved, { replace: true });
  }, [moved]);
  // Settings is a dialog over the page you were on (Town's): /settings… opens it, and the page
  // behind keeps the last other path (the inbox when you land on /settings directly).
  const settingsOpen = path.startsWith("/settings");
  const pageBehind = useRef("/inbox");
  if (!settingsOpen) pageBehind.current = path;
  const pagePath = settingsOpen ? pageBehind.current : path;
  // Opened from inside the desk (a history entry to go back over) or by loading a /settings URL.
  const openedInDesk = useRef(false);
  const lastPath = useRef<string | null>(null);
  useEffect(() => {
    if (settingsOpen && lastPath.current !== null && !lastPath.current.startsWith("/settings")) openedInDesk.current = true;
    if (!settingsOpen) openedInDesk.current = false;
    lastPath.current = path;
  }, [path, settingsOpen]);
  const closeSettings = useCallback(() => {
    if (openedInDesk.current) window.history.back();
    else navigate(pageBehind.current, { replace: true });
  }, []);
  const workspace = me.memberships?.[0];
  const [online, setOnline] = useState<PresenceEntry[]>([]);
  // V-01: kept here (not in the page) because the hub sends the full list only on connect.
  const [visitors, setVisitors] = useState<LiveVisitor[]>([]);
  const listeners = useRef(new Set<(event: HubEvent) => void>());
  const onboarding = useOnboarding(workspace?.workspaceId ?? "");
  // The sidebar's "Get started" checklist follows what's done elsewhere (Settings, Knowledge…).
  const { reload: reloadOnboarding } = onboarding;
  useEffect(() => {
    if (workspace) reloadOnboarding().catch(() => {});
  }, [path, workspace, reloadOnboarding]);

  useEffect(() => {
    if (path === "/" || path === "") navigate("/inbox", { replace: true });
  }, [path]);

  useEffect(() => {
    if (!workspace) return;
    // I-14: the hub skips Web Push for you while a desk tab is in front of you.
    const reportFocus = () => socket.send({ type: "focus", focused: tabFocused() } satisfies HubClientEvent);
    const socket = new LiveSocket<HubEvent>({
      url: () => `/api/workspaces/${workspace.workspaceId}/ws`,
      onState: (state) => {
        if (state === "open") reportFocus();
      },
      onEvent: (event) => {
        // Not in front of you: a system notification (in front: the inbox's own toasts and lists).
        if (event.type === "notify" && event.mode === "system" && !tabFocused()) void showInPageNotification(event.notification).catch(() => {});
        // I-14 sound: a chime for the same events, unless this tab is in front and showing that chat.
        if (event.type === "notify" && event.sound !== false && !(tabFocused() && window.location.pathname === event.notification.url)) playChime();
        if (event.type === "presence") setOnline(event.online);
        if (event.type === "visitors") setVisitors(event.visitors);
        if (event.type === "visitor") setVisitors((list) => [...list.filter((v) => v.sessionId !== event.visitor.sessionId), event.visitor]);
        if (event.type === "visitor_left") setVisitors((list) => list.filter((v) => v.sessionId !== event.sessionId));
        for (const listener of listeners.current) listener(event);
      },
    });
    window.addEventListener("focus", reportFocus);
    window.addEventListener("blur", reportFocus);
    document.addEventListener("visibilitychange", reportFocus);
    // The service worker shows notifications (in-page ones too) and routes clicks to this tab.
    if (notificationPermission() === "granted") void deskServiceWorker().catch(() => {});
    // Browsers allow sound only after you've interacted with the page.
    unlockSoundOnInteraction();
    const stopClicks = listenForNotificationClicks();
    return () => {
      socket.close();
      window.removeEventListener("focus", reportFocus);
      window.removeEventListener("blur", reportFocus);
      document.removeEventListener("visibilitychange", reportFocus);
      stopClicks();
    };
  }, [workspace]);

  // I-13: the command palette, the "?" sheet and the keyboard shortcuts.
  const [overlay, setOverlay] = useState<"palette" | "help" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const shortcutState = useRef(INITIAL_SHORTCUT_STATE);
  const openOverlay = useCallback((next: "palette" | "help") => {
    setOverlay((current) => {
      if (!current && document.activeElement instanceof HTMLElement) returnFocus.current = document.activeElement;
      return next;
    });
  }, []);
  const afterClose = useRef<(() => void) | null>(null);
  /** Closes the palette or sheet; once it's gone, focus goes back and `then` runs (it may move focus on). */
  const closeOverlay = useCallback((then?: () => void) => {
    afterClose.current = then ?? null;
    setOverlay(null);
  }, []);
  useEffect(() => {
    if (overlay) return;
    // After the commit: while a modal dialog is open the rest of the page is inert and can't take focus.
    const target = returnFocus.current;
    const then = afterClose.current;
    returnFocus.current = null;
    afterClose.current = null;
    if (target?.isConnected) target.focus();
    then?.();
  }, [overlay]);
  const showNotice = useCallback((text: string) => setNotice(text), []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2500);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const openHelp = useCallback(() => openOverlay("help"), [openOverlay]);

  useEffect(() => {
    const run = (command: ShortcutCommand) => {
      const { inbox, thread } = bridge;
      switch (command) {
        case "palette": return overlay === "palette" ? closeOverlay() : openOverlay("palette");
        case "help": return openOverlay("help");
        case "go-inbox": return navigate("/inbox");
        case "go-visitors": return navigate("/visitors");
        case "go-dashboard": return navigate("/dashboard");
        case "go-settings": return navigate("/settings");
        case "next": return inbox?.move(1);
        case "previous": return inbox?.move(-1);
        case "open": return inbox?.openCursor();
        case "search": return inbox?.focusSearch();
        case "resolve": return inbox?.act("resolve");
        case "assign-me": return inbox?.act("assign-me");
        case "reply": return thread?.focusComposer("reply");
        case "note": return thread?.focusComposer("note");
        case "tag": return thread?.startTag();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented && !(e.key.toLowerCase() === "k" && (e.ctrlKey || e.metaKey))) return;
      const otherDialog = Array.from(document.querySelectorAll("dialog[open]")).some((d) => !d.classList.contains("palette"));
      const { command, state } = dispatchShortcut(
        {
          key: e.key,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          altKey: e.altKey,
          shiftKey: e.shiftKey,
          isComposing: e.isComposing || e.key === "Process" || e.keyCode === 229,
          typing: isTypingTarget(e.target) && overlay !== "palette",
          onControl: isControlTarget(e.target),
        },
        shortcutState.current,
        { inbox: window.location.pathname.startsWith("/inbox"), modal: overlay === "palette" ? "palette" : otherDialog || overlay || settingsOpen ? "other" : "none" },
        Date.now(),
      );
      shortcutState.current = state;
      if (!command) return;
      e.preventDefault();
      run(command);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [overlay, openOverlay, closeOverlay, settingsOpen]);

  const hub = useMemo<Hub>(
    () => ({
      subscribe(listener) {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener);
      },
    }),
    [],
  );

  if (!workspace || !me.user) return <div className="center muted">You're not a member of any workspace.</div>;
  const section =
    pagePath.startsWith("/knowledge") ? "knowledge"
    : pagePath.startsWith("/agent") ? "agent"
    : pagePath.startsWith("/appearance") ? "appearance"
    : pagePath.startsWith("/visitors") ? "visitors"
    : pagePath.startsWith("/dashboard") || pagePath.startsWith("/reports") ? "dashboard"
    : pagePath.startsWith("/welcome") ? "welcome"
    : "inbox";
  const ob = onboarding.state;
  const obDone = ob ? STEP_ORDER.filter((k) => ob.steps[k]).length : 0;
  const showGetStarted = Boolean(ob && !ob.dismissed && obDone < STEP_ORDER.length && workspace.role !== "agent");
  const canEdit = workspace.role !== "agent";
  const conversationId = pagePath.match(/^\/inbox\/([\w-]+)/)?.[1] ?? null;

  return (
    // Town's sidebar (D-36): shadcn's Sidebar, collapsing to a 56px icon rail (toggle, or Ctrl/Cmd+B).
    <SidebarProvider className="shell">
      <CloseSheetOnNavigate path={path} />
      <Sidebar collapsible="icon" className="desk-sidebar">
        <SidebarHeader className="desk-sidebar-head">
          <SidebarTrigger />
          <div className="brand"><DeskIcon /><span>Jun Desk</span></div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarMenu aria-label="Main">
              {NAV.map(({ id, label, Icon }) => (
                <SidebarMenuItem key={id}>
                  <SidebarMenuButton
                    isActive={section === id && !settingsOpen}
                    tooltip={label}
                    render={<a href={`/${id}`} aria-current={section === id && !settingsOpen ? "page" : undefined} onClick={(e) => { e.preventDefault(); navigate(`/${id}`); }} />}
                  >
                    <Icon />
                    <span>{label}</span>
                  </SidebarMenuButton>
                  {id === "visitors" && visitors.length > 0 && <SidebarMenuBadge className="nav-count">{visitors.length}</SidebarMenuBadge>}
                  {/* The Agent's parts open under it while you're there (Chatbase's "Build"); the icon rail shows only Agent. */}
                  {id === "agent" && section === "agent" && !settingsOpen && (
                    <SidebarMenuSub aria-label="Agent">
                      {AGENT_SECTIONS.map((a) => {
                        const active = agentSection(pagePath) === a.id;
                        return (
                          <SidebarMenuSubItem key={a.id}>
                            {a.group && <span className="agent-nav-group">{a.group}</span>}
                            <SidebarMenuSubButton
                              isActive={active}
                              href={a.path}
                              aria-current={active ? "page" : undefined}
                              onClick={(e) => { e.preventDefault(); navigate(a.path); }}
                            >
                              <span>{a.label}</span>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        );
                      })}
                    </SidebarMenuSub>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          {ob && showGetStarted && section !== "welcome" && (
            <>
              <div className="desk-sidebar-expanded"><GetStartedCard onboarding={ob} /></div>
              <SidebarMenu className="desk-sidebar-collapsed">
                <SidebarMenuItem>
                  <SidebarMenuButton tooltip={`Get started (${obDone} of ${STEP_ORDER.length})`} render={<a href="/welcome" onClick={(e) => { e.preventDefault(); navigate("/welcome"); }} />}>
                    <FlashIcon />
                    <span>Get started</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </>
          )}
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton type="button" onClick={() => openOverlay("palette")} aria-keyshortcuts="Control+K Meta+K" tooltip={`Search (${modKey()} K)`}>
                <SearchIcon />
                <span>Search</span>
                <kbd className="ml-auto">{modKey()} K</kbd>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <ThemeButton />
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton type="button" onClick={openHelp} aria-keyshortcuts="Shift+?" tooltip="Keyboard shortcuts (?)">
                <HelpIcon />
                <span>Keyboard shortcuts</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger render={<SidebarMenuButton type="button" size="lg" className="desk-user" aria-label="Account" />}>
                  <span className="avatar me" aria-hidden="true">{me.user.name.slice(0, 1).toUpperCase()}</span>
                  <span className="desk-user-text">
                    <span className="desk-user-name">{me.user.name}</span>
                    <span className="desk-user-sub">{workspace.workspaceName} · {online.length} online</span>
                  </span>
                </DropdownMenuTrigger>
                <AccountMenuContent>
                  {/* Settings lives here, under your name (Town's profile menu), not in the main nav. */}
                  <DropdownMenuGroup>
                    <DropdownMenuLabel className="desk-user-menu-head">
                      <span className="desk-user-name">{me.user.name}</span>
                      {me.user.email && <span className="desk-user-sub">{me.user.email}</span>}
                    </DropdownMenuLabel>
                    <DropdownMenuItem onClick={() => navigate("/settings")}>
                      <SettingsIcon />
                      Settings
                      <DropdownMenuShortcut>G S</DropdownMenuShortcut>
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Online now</DropdownMenuLabel>
                    {online.map((o) => (
                      <DropdownMenuItem key={o.userId} disabled>
                        <span className="avatar" aria-hidden="true">{o.name.slice(0, 1).toUpperCase()}</span>
                        {o.name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={async () => { await api("/auth/logout", { body: {} }); onSignOut(); }}>
                    <SignOutIcon />
                    Sign out
                  </DropdownMenuItem>
                </AccountMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="desk-inset">
      <header className="desk-mobile-bar">
        <SidebarTrigger />
        <div className="brand"><DeskIcon /><span>Jun Desk</span></div>
      </header>
      <ScrollArea render={<main />} className="desk-main" contentClassName="desk-main-body">
      <PageErrorBoundary key={section}>
      {section === "knowledge" ? (
        <KnowledgePage workspaceId={workspace.workspaceId} canEdit={canEdit} />
      ) : section === "welcome" ? (
        <WelcomePage workspaceId={workspace.workspaceId} workspaceName={workspace.workspaceName} onboarding={onboarding.state} reload={onboarding.reload} />
      ) : section === "visitors" ? (
        <VisitorsPage workspaceId={workspace.workspaceId} visitors={visitors} />
      ) : section === "dashboard" ? (
        <ReportsPage workspaceId={workspace.workspaceId} />
      ) : section === "appearance" ? (
        <WidgetPage workspaceId={workspace.workspaceId} workspaceName={workspace.workspaceName} canEdit={canEdit} tab={pagePath.startsWith("/appearance/install") ? "install" : "look"} />
      ) : section === "agent" ? (
        <AgentPage workspaceId={workspace.workspaceId} canEdit={canEdit} path={pagePath} />
      ) : (
        <InboxPage workspaceId={workspace.workspaceId} workspaceName={workspace.workspaceName} me={me.user} hub={hub} conversationId={conversationId} />
      )}
      </PageErrorBoundary>
      </ScrollArea>
      {settingsOpen && <PageErrorBoundary><SettingsDialog me={me} path={path} onClose={closeSettings} /></PageErrorBoundary>}
      </SidebarInset>
      {overlay === "palette" && <CommandPalette workspaceId={workspace.workspaceId} meId={me.user.id} onClose={closeOverlay} onHelp={openHelp} onToast={showNotice} />}
      {overlay === "help" && <ShortcutsHelp onClose={closeOverlay} />}
      {notice && <div className="toast" role="status"><span>{notice}</span></div>}
    </SidebarProvider>
  );
}

/** The account menu opens beside the sidebar; on phones (the sidebar is a sheet) above the button, so it stays on screen. */
function AccountMenuContent({ children }: { children: ReactNode }) {
  const { isMobile } = useSidebar();
  return <DropdownMenuContent side={isMobile ? "top" : "right"} align={isMobile ? "start" : "end"} className="min-w-56">{children}</DropdownMenuContent>;
}

/** On phones the sidebar is a sheet: going to another page closes it. */
function CloseSheetOnNavigate({ path }: { path: string }) {
  const { setOpenMobile } = useSidebar();
  useEffect(() => setOpenMobile(false), [path, setOpenMobile]);
  return null;
}

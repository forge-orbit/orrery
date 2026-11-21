import { Badge } from "@astryxdesign/core/Badge";
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Link as AstryxLink } from "@astryxdesign/core/Link";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Outlet,
  createRootRouteWithContext,
  useMatches,
  useNavigate,
} from "@tanstack/react-router";
import { useState } from "react";
import markDark from "../../../../assets/orrery-mark-dark.svg";
import markLight from "../../../../assets/orrery-mark.svg";
import { sessionQuery, signOut } from "../features/accounts/index.ts";
import { installationInvitationsQuery } from "../features/invitations/index.ts";
import { notificationUnreadCountQuery } from "../features/notifications/index.ts";
import { workspacesQuery } from "../features/workspaces/index.ts";
import { AppearancePicker } from "../lib/appearance.tsx";
import { Link } from "../lib/Link.tsx";

export interface RouterContext {
  queryClient: QueryClient;
}

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    accessPage?: boolean;
  }
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  notFoundComponent: () => (
    <main>
      <Stack className="empty-panel">
        <EmptyState
          title="Page not found"
          description="Check the address or return to your workspaces."
          headingLevel={1}
          actions={
            <Link to="/" color="accent" hasUnderline>
              Go to your workspaces
            </Link>
          }
        />
      </Stack>
    </main>
  ),
});

function MenuIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path
        d="M2.5 4.5h13M2.5 9h13M2.5 13.5h13"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function NavWorkspacesIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="2" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.35" />
      <rect x="9" y="2" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.35" />
      <rect x="2" y="9" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.35" />
      <rect x="9" y="9" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.35" />
    </svg>
  );
}

function NavMyWorkIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.8" stroke="currentColor" strokeWidth="1.35" />
      <path
        d="M5.6 8.2 7.2 9.8 10.6 6.4"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function NavInboxIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 9.5 4 3.5h8l1.5 6v3.2a.8.8 0 0 1-.8.8H3.3a.8.8 0 0 1-.8-.8V9.5Z"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
      <path
        d="M2.5 9.5h3.2l1 1.7h2.6l1-1.7h3.2"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function NavNotificationsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4 6.6a4 4 0 0 1 8 0c0 2.4.7 3.4 1.2 4H2.8C3.3 10 4 9 4 6.6Z"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
      <path
        d="M6.4 12.4a1.7 1.7 0 0 0 3.2 0"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
    </svg>
  );
}

function RootLayout() {
  const accessPage = useMatches({
    select: (matches) => matches.some((match) => match.staticData.accessPage === true),
  });
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  if (accessPage) {
    return (
      <Stack className="access-layout">
        <aside className="access-cover">
          <header className="access-toolbar">
            <BrandHome />
            <AppearancePicker forceDark />
          </header>
          <OrbitDiagram />
          <Stack className="access-cover-copy">
            <Text as="p" display="block" type="inherit" color="inherit">
              Projects for humans and agents.
            </Text>
            <small>
              Track issues, share knowledge, and give agents direction when they need it.
            </small>
          </Stack>
        </aside>
        <Stack className="access-content">
          <div className="access-main">
            <Outlet />
          </div>
          <footer className="access-footer">
            <ForgeOrbitAttribution />
          </footer>
        </Stack>
      </Stack>
    );
  }

  return (
    <Stack className="app-layout">
      <AstryxLink className="skip-link" href="#content">
        Skip to content
      </AstryxLink>
      <header className="mobile-topbar">
        <Stack direction="horizontal" className="mobile-topbar-left">
          <IconButton
            type="button"
            variant="ghost"
            size="sm"
            label="Open navigation"
            icon={<MenuIcon />}
            onClick={() => setMobileNavOpen(true)}
          />
          <BrandHome />
        </Stack>
        <AppearancePicker />
      </header>
      <aside className="app-sidebar">
        <div className="sidebar-body">
          <BrandHome />
          <SidebarLinks />
        </div>
        <SidebarFooter />
      </aside>
      <Drawer
        isOpen={mobileNavOpen}
        onOpenChange={setMobileNavOpen}
        side="start"
        width="17.5rem"
        label="Navigation"
      >
        <Layout
          height="fill"
          header={<DrawerHeader title="Orrery" onOpenChange={setMobileNavOpen} hasDivider />}
          footer={
            <LayoutFooter hasDivider className="mobile-drawer-footer">
              <SidebarFooter onNavigate={() => setMobileNavOpen(false)} showAppearance={false} />
            </LayoutFooter>
          }
        >
          <LayoutContent>
            <Stack className="mobile-drawer-nav">
              <SidebarLinks onNavigate={() => setMobileNavOpen(false)} />
            </Stack>
          </LayoutContent>
        </Layout>
      </Drawer>
      <Stack className="app-content" id="content" tabIndex={-1}>
        <Outlet />
      </Stack>
    </Stack>
  );
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function OrbitDiagram() {
  const reducedMotion = prefersReducedMotion();
  return (
    <Stack className="orbit-diagram" aria-hidden="true">
      <svg className="orbit-diagram-svg" viewBox="0 0 400 400" fill="none">
        <defs>
          <path id="orrery-orbit-1" d="M 26 200 A 174 100 0 1 0 374 200 A 174 100 0 1 0 26 200" />
          <path id="orrery-orbit-2" d="M 54 200 A 146 86 0 1 1 346 200 A 146 86 0 1 1 54 200" />
          <path id="orrery-orbit-3" d="M 86 200 A 114 58 0 1 0 314 200 A 114 58 0 1 0 86 200" />
        </defs>

        <line x1="200" y1="0" x2="200" y2="400" className="orbit-axis" />
        <line x1="0" y1="200" x2="400" y2="200" className="orbit-axis" />

        <g transform="rotate(-32 200 200)">
          <use href="#orrery-orbit-1" className="orbit-ring" />
          <g transform={reducedMotion ? "translate(374 200)" : undefined}>
            <circle r="11" className="orbit-planet-halo" />
            <circle r="5" className="orbit-planet-primary" />
            {!reducedMotion && (
              <animateMotion dur="24s" repeatCount="indefinite">
                <mpath href="#orrery-orbit-1" />
              </animateMotion>
            )}
          </g>
        </g>

        <g transform="rotate(26 200 200)">
          <use href="#orrery-orbit-2" className="orbit-ring orbit-ring-mid" />
          <g transform={reducedMotion ? "translate(54 200)" : undefined}>
            <circle r="7.5" className="orbit-moon-halo" />
            <circle r="3.2" className="orbit-moon" />
            {!reducedMotion && (
              <animateMotion dur="34s" begin="-11s" repeatCount="indefinite">
                <mpath href="#orrery-orbit-2" />
              </animateMotion>
            )}
          </g>
        </g>

        <g transform="rotate(-68 200 200)">
          <use href="#orrery-orbit-3" className="orbit-ring orbit-ring-inner" />
          <circle
            r="2.4"
            cx={reducedMotion ? 314 : undefined}
            cy={reducedMotion ? 200 : undefined}
            className="orbit-satellite"
          >
            {!reducedMotion && (
              <animateMotion dur="17s" begin="-5s" repeatCount="indefinite">
                <mpath href="#orrery-orbit-3" />
              </animateMotion>
            )}
          </circle>
        </g>

        <circle cx="200" cy="200" r="11" className="orbit-sun-halo" />
        <circle cx="200" cy="200" r="5" className="orbit-sun" />
      </svg>
    </Stack>
  );
}

function BrandHome() {
  return (
    <Link to="/" className="brand-home" color="inherit">
      <Text type="inherit" color="inherit" className="brand-lockup">
        <img src={markLight} width="22" height="20" alt="" className="brand-mark-light" />
        <img src={markDark} width="22" height="20" alt="" className="brand-mark-dark" />
        Orrery
      </Text>
    </Link>
  );
}

function SignOutIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6.5 2.75H3.8a1.05 1.05 0 0 0-1.05 1.05v8.4c0 .58.47 1.05 1.05 1.05h2.7M10.5 11.25 13.75 8 10.5 4.75M13.5 8H6.5"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function NavMailIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect
        x="2"
        y="3.2"
        width="12"
        height="9.6"
        rx="1.4"
        stroke="currentColor"
        strokeWidth="1.35"
      />
      <path
        d="m2.6 4.4 5.4 4.1 5.4-4.1"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function NavHistoryIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.8" stroke="currentColor" strokeWidth="1.35" />
      <path
        d="M8 4.8V8l2.2 1.4"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SidebarLinks({ onNavigate }: { onNavigate?: () => void }) {
  const { data: session } = useQuery(sessionQuery);
  const { data: workspaces = [] } = useQuery({
    ...workspacesQuery,
    enabled: session?.signedIn === true,
  });
  const { data: adminInvitations } = useQuery({
    ...installationInvitationsQuery,
    enabled: session?.signedIn === true,
  });
  const { data: unreadNotifications } = useQuery({
    ...notificationUnreadCountQuery,
    enabled: session?.signedIn === true,
  });
  const isAdmin = adminInvitations !== undefined && adminInvitations !== null;
  const clickProp = onNavigate === undefined ? {} : { onClick: onNavigate };

  return (
    <>
      <nav className="app-nav" aria-label="Main navigation">
        <Link to="/" activeOptions={{ exact: true }} color="inherit" {...clickProp}>
          <span className="nav-item-inner">
            <NavWorkspacesIcon />
            <span className="nav-item-label">Workspaces</span>
          </span>
        </Link>
        <Link to="/my-work" color="inherit" {...clickProp}>
          <span className="nav-item-inner">
            <NavMyWorkIcon />
            <span className="nav-item-label">My work</span>
          </span>
        </Link>
        <Link to="/inbox" color="inherit" {...clickProp}>
          <span className="nav-item-inner">
            <NavInboxIcon />
            <span className="nav-item-label">Inbox</span>
          </span>
        </Link>
        <Link
          to="/notifications"
          search={{ unreadOnly: false }}
          activeOptions={{ includeSearch: false }}
          aria-label={
            unreadNotifications !== undefined && unreadNotifications > 0
              ? `Notifications, ${unreadNotifications} unread`
              : "Notifications"
          }
          color="inherit"
          data-notifications-link
          {...clickProp}
        >
          <span className="nav-item-inner">
            <NavNotificationsIcon />
            <span className="nav-item-label">Notifications</span>
            {unreadNotifications !== undefined && unreadNotifications > 0 && (
              <Badge
                label={unreadNotifications > 99 ? "99+" : unreadNotifications}
                variant="orange"
              />
            )}
          </span>
        </Link>
      </nav>
      {workspaces.length > 0 && (
        <nav className="app-nav workspace-nav" aria-label="Your workspaces">
          <Text as="p" display="block" type="inherit" color="inherit">
            Your workspaces
          </Text>
          {workspaces.map((workspace) => (
            <Link
              key={workspace.id}
              to="/workspaces/$workspaceId"
              params={{ workspaceId: workspace.id }}
              color="inherit"
              {...clickProp}
            >
              <span className="nav-item-inner">
                <span className="workspace-nav-dot" aria-hidden="true">
                  {workspace.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="nav-item-label">{workspace.name}</span>
              </span>
            </Link>
          ))}
        </nav>
      )}
      {isAdmin && (
        <nav className="app-nav workspace-nav" aria-label="Installation administration">
          <Text as="p" display="block" type="inherit" color="inherit">
            Admin
          </Text>
          <Link to="/settings/smtp" color="inherit" {...clickProp}>
            <span className="nav-item-inner">
              <NavMailIcon />
              <span className="nav-item-label">SMTP settings</span>
            </span>
          </Link>
          <Link to="/history/installation" color="inherit" {...clickProp}>
            <span className="nav-item-inner">
              <NavHistoryIcon />
              <span className="nav-item-label">Installation history</span>
            </span>
          </Link>
        </nav>
      )}
    </>
  );
}

function SidebarFooter({
  onNavigate,
  showAppearance = true,
}: {
  onNavigate?: () => void;
  showAppearance?: boolean;
}) {
  const { data: session } = useQuery(sessionQuery);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const logout = useMutation({
    mutationFn: signOut,
    onSuccess: async () => {
      queryClient.clear();
      onNavigate?.();
      toast({ body: "Signed out." });
      await navigate({ to: "/signin", replace: true });
    },
    onError: (error) => {
      toast({ body: error.message, type: "error" });
    },
  });
  const clickProp = onNavigate === undefined ? {} : { onClick: onNavigate };

  return (
    <footer className="sidebar-footer">
      {session?.signedIn && (
        <Stack direction="horizontal" vAlign="center" gap={1} className="sidebar-account-row">
          <Link to="/account" color="inherit" className="sidebar-account-link" {...clickProp}>
            <span className="sidebar-account-text">
              <span className="sidebar-account-name">{session.displayName ?? session.email}</span>
              {session.displayName !== null && (
                <span className="sidebar-account-email">{session.email}</span>
              )}
            </span>
          </Link>
          <IconButton
            type="button"
            variant="ghost"
            size="sm"
            label="Sign out"
            icon={<SignOutIcon />}
            isDisabled={logout.isPending}
            onClick={() => logout.mutate()}
          />
        </Stack>
      )}
      {showAppearance && <AppearancePicker />}
      <ForgeOrbitAttribution className="sidebar-attribution" />
    </footer>
  );
}

function ForgeOrbitAttribution({ className }: { className?: string }) {
  return (
    <p className={className ? `forge-orbit-attribution ${className}` : "forge-orbit-attribution"}>
      Made by{" "}
      <AstryxLink
        href="https://github.com/forge-orbit"
        target="_blank"
        rel="noopener noreferrer"
        type="inherit"
        color="inherit"
        hasUnderline
      >
        Forge Orbit
      </AstryxLink>
    </p>
  );
}

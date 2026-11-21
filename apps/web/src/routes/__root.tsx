import { Badge } from "@astryxdesign/core/Badge";
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
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
import { createElement, useState } from "react";
import markDark from "../../../../assets/orrery-mark-dark.svg";
import markLight from "../../../../assets/orrery-mark.svg";
import { sessionQuery, signOut } from "../features/accounts/index.ts";
import { installationInvitationsQuery } from "../features/invitations/index.ts";
import { notificationUnreadCountQuery } from "../features/notifications/index.ts";
import { workspacesQuery } from "../features/workspaces/index.ts";
import { AppearancePicker, useResolvedAppearance } from "../lib/appearance.tsx";
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
    <Stack as="main">
      <Stack data-empty-panel="">
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
    </Stack>
  ),
});

function NavWorkspacesIcon() {
  return createElement(
    "svg",
    { width: 15, height: 15, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
    createElement("rect", {
      x: 2,
      y: 2,
      width: 5,
      height: 5,
      rx: 1.2,
      stroke: "currentColor",
      strokeWidth: 1.35,
    }),
    createElement("rect", {
      x: 9,
      y: 2,
      width: 5,
      height: 5,
      rx: 1.2,
      stroke: "currentColor",
      strokeWidth: 1.35,
    }),
    createElement("rect", {
      x: 2,
      y: 9,
      width: 5,
      height: 5,
      rx: 1.2,
      stroke: "currentColor",
      strokeWidth: 1.35,
    }),
    createElement("rect", {
      x: 9,
      y: 9,
      width: 5,
      height: 5,
      rx: 1.2,
      stroke: "currentColor",
      strokeWidth: 1.35,
    }),
  );
}

function NavMyWorkIcon() {
  return createElement(
    "svg",
    { width: 15, height: 15, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
    createElement("circle", { cx: 8, cy: 8, r: 5.8, stroke: "currentColor", strokeWidth: 1.35 }),
    createElement("path", {
      d: "M5.6 8.2 7.2 9.8 10.6 6.4",
      stroke: "currentColor",
      strokeWidth: 1.35,
      strokeLinecap: "round",
      strokeLinejoin: "round",
    }),
  );
}

function NavInboxIcon() {
  return createElement(
    "svg",
    { width: 15, height: 15, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
    createElement("path", {
      d: "M2.5 9.5 4 3.5h8l1.5 6v3.2a.8.8 0 0 1-.8.8H3.3a.8.8 0 0 1-.8-.8V9.5Z",
      stroke: "currentColor",
      strokeWidth: 1.35,
      strokeLinejoin: "round",
    }),
    createElement("path", {
      d: "M2.5 9.5h3.2l1 1.7h2.6l1-1.7h3.2",
      stroke: "currentColor",
      strokeWidth: 1.35,
      strokeLinejoin: "round",
    }),
  );
}

function NavNotificationsIcon() {
  return createElement(
    "svg",
    { width: 15, height: 15, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
    createElement("path", {
      d: "M4 6.6a4 4 0 0 1 8 0c0 2.4.7 3.4 1.2 4H2.8C3.3 10 4 9 4 6.6Z",
      stroke: "currentColor",
      strokeWidth: 1.35,
      strokeLinejoin: "round",
    }),
    createElement("path", {
      d: "M6.4 12.4a1.7 1.7 0 0 0 3.2 0",
      stroke: "currentColor",
      strokeWidth: 1.35,
      strokeLinecap: "round",
    }),
  );
}

function RootLayout() {
  const accessPage = useMatches({
    select: (matches) => matches.some((match) => match.staticData.accessPage === true),
  });
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  if (accessPage) {
    return (
      <Stack data-access-layout="">
        <Stack as="aside" data-access-cover="">
          <Stack
            as="header"
            direction="horizontal"
            justify="between"
            align="center"
            data-access-toolbar=""
          >
            <BrandHome forceDark />
            <AppearancePicker forceDark />
          </Stack>
          <OrbitDiagram />
          <Stack data-access-cover-copy="">
            <Text as="p" display="block" type="inherit" color="inherit">
              Projects for humans and agents.
            </Text>
            <small>
              Track issues, share knowledge, and give agents direction when they need it.
            </small>
          </Stack>
        </Stack>
        <Stack data-access-content="">
          <Stack data-access-main="">
            <Outlet />
          </Stack>
          <footer data-access-footer="">
            <ForgeOrbitAttribution />
          </footer>
        </Stack>
      </Stack>
    );
  }

  return (
    <Stack data-app-layout="">
      <AstryxLink href="#content" data-skip-link="">
        Skip to content
      </AstryxLink>
      <Stack
        as="header"
        direction="horizontal"
        justify="between"
        align="center"
        data-mobile-topbar=""
      >
        <Stack direction="horizontal" data-mobile-topbar-left="">
          <IconButton
            type="button"
            variant="ghost"
            size="sm"
            label="Open navigation"
            icon={<Icon icon="menu" />}
            onClick={() => setMobileNavOpen(true)}
          />
          <BrandHome />
        </Stack>
        <AppearancePicker />
      </Stack>
      <Stack as="aside" justify="between" data-app-sidebar="">
        <Stack data-sidebar-body="">
          <BrandHome />
          <SidebarLinks />
        </Stack>
        <SidebarFooter />
      </Stack>
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
            <LayoutFooter hasDivider data-mobile-drawer-footer="">
              <SidebarFooter onNavigate={() => setMobileNavOpen(false)} showAppearance={false} />
            </LayoutFooter>
          }
        >
          <LayoutContent>
            <Stack data-mobile-drawer-nav="">
              <SidebarLinks onNavigate={() => setMobileNavOpen(false)} />
            </Stack>
          </LayoutContent>
        </Layout>
      </Drawer>
      <Stack id="content" tabIndex={-1} data-app-content="">
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
    <Stack data-orbit-diagram="" aria-hidden="true">
      {createElement(
        "svg",
        { viewBox: "0 0 400 400", fill: "none" },
        createElement(
          "defs",
          null,
          createElement("path", {
            id: "orrery-orbit-1",
            d: "M 26 200 A 174 100 0 1 0 374 200 A 174 100 0 1 0 26 200",
          }),
          createElement("path", {
            id: "orrery-orbit-2",
            d: "M 54 200 A 146 86 0 1 1 346 200 A 146 86 0 1 1 54 200",
          }),
          createElement("path", {
            id: "orrery-orbit-3",
            d: "M 86 200 A 114 58 0 1 0 314 200 A 114 58 0 1 0 86 200",
          }),
        ),
        createElement("line", {
          x1: 200,
          y1: 0,
          x2: 200,
          y2: 400,
          stroke: "color-mix(in srgb, var(--orrery-cream) 15%, transparent)",
          strokeWidth: 1,
        }),
        createElement("line", {
          x1: 0,
          y1: 200,
          x2: 400,
          y2: 200,
          stroke: "color-mix(in srgb, var(--orrery-cream) 15%, transparent)",
          strokeWidth: 1,
        }),
        createElement(
          "g",
          { transform: "rotate(-32 200 200)" },
          createElement("use", {
            href: "#orrery-orbit-1",
            stroke: "color-mix(in srgb, var(--orrery-cream) 36%, transparent)",
            strokeWidth: 1,
          }),
          createElement(
            "g",
            { transform: reducedMotion ? "translate(374 200)" : undefined },
            createElement("circle", {
              r: 11,
              fill: "color-mix(in srgb, var(--orrery-orange) 22%, transparent)",
            }),
            createElement("circle", { r: 5, fill: "var(--orrery-orange)" }),
            !reducedMotion &&
              createElement(
                "animateMotion",
                { dur: "24s", repeatCount: "indefinite" },
                createElement("mpath", { href: "#orrery-orbit-1" }),
              ),
          ),
        ),
        createElement(
          "g",
          { transform: "rotate(26 200 200)" },
          createElement("use", {
            href: "#orrery-orbit-2",
            stroke: "color-mix(in srgb, var(--orrery-cream) 28%, transparent)",
            strokeWidth: 1,
          }),
          createElement(
            "g",
            { transform: reducedMotion ? "translate(54 200)" : undefined },
            createElement("circle", {
              r: 7.5,
              fill: "color-mix(in srgb, var(--orrery-cream) 12%, transparent)",
            }),
            createElement("circle", {
              r: 3.2,
              fill: "color-mix(in srgb, var(--orrery-cream) 82%, transparent)",
            }),
            !reducedMotion &&
              createElement(
                "animateMotion",
                { dur: "34s", begin: "-11s", repeatCount: "indefinite" },
                createElement("mpath", { href: "#orrery-orbit-2" }),
              ),
          ),
        ),
        createElement(
          "g",
          { transform: "rotate(-68 200 200)" },
          createElement("use", {
            href: "#orrery-orbit-3",
            stroke: "color-mix(in srgb, var(--orrery-cream) 22%, transparent)",
            strokeWidth: 1,
          }),
          createElement(
            "circle",
            {
              r: 2.4,
              cx: reducedMotion ? 314 : undefined,
              cy: reducedMotion ? 200 : undefined,
              fill: "color-mix(in srgb, var(--orrery-orange) 72%, var(--orrery-cream))",
            },
            !reducedMotion &&
              createElement(
                "animateMotion",
                { dur: "17s", begin: "-5s", repeatCount: "indefinite" },
                createElement("mpath", { href: "#orrery-orbit-3" }),
              ),
          ),
        ),
        createElement("circle", {
          cx: 200,
          cy: 200,
          r: 11,
          fill: "color-mix(in srgb, var(--orrery-cream) 15%, transparent)",
        }),
        createElement("circle", { cx: 200, cy: 200, r: 5, fill: "var(--orrery-cream)" }),
      )}
    </Stack>
  );
}

function BrandHome({ forceDark = false }: { forceDark?: boolean }) {
  const appearance = useResolvedAppearance();
  return (
    <Link to="/" color="inherit" data-brand-home="">
      <Stack as="span" direction="horizontal" gap={1.5} align="center" data-brand-lockup="">
        <img
          src={forceDark || appearance === "dark" ? markDark : markLight}
          width="22"
          height="20"
          alt=""
        />
        Orrery
      </Stack>
    </Link>
  );
}

function SignOutIcon() {
  return createElement(
    "svg",
    { width: 15, height: 15, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
    createElement("path", {
      d: "M6.5 2.75H3.8a1.05 1.05 0 0 0-1.05 1.05v8.4c0 .58.47 1.05 1.05 1.05h2.7M10.5 11.25 13.75 8 10.5 4.75M13.5 8H6.5",
      stroke: "currentColor",
      strokeWidth: 1.35,
      strokeLinecap: "round",
      strokeLinejoin: "round",
    }),
  );
}

function NavMailIcon() {
  return createElement(
    "svg",
    { width: 15, height: 15, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
    createElement("rect", {
      x: 2,
      y: 3.2,
      width: 12,
      height: 9.6,
      rx: 1.4,
      stroke: "currentColor",
      strokeWidth: 1.35,
    }),
    createElement("path", {
      d: "m2.6 4.4 5.4 4.1 5.4-4.1",
      stroke: "currentColor",
      strokeWidth: 1.35,
      strokeLinecap: "round",
      strokeLinejoin: "round",
    }),
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
      <Stack as="nav" data-app-nav="" aria-label="Main navigation">
        <Link to="/" activeOptions={{ exact: true }} color="inherit" {...clickProp}>
          <Stack direction="horizontal" align="center" gap={1} data-nav-item-inner="">
            <NavWorkspacesIcon />
            <Text as="span" data-nav-item-label="">
              Workspaces
            </Text>
          </Stack>
        </Link>
        <Link to="/my-work" color="inherit" {...clickProp}>
          <Stack direction="horizontal" align="center" gap={1} data-nav-item-inner="">
            <NavMyWorkIcon />
            <Text as="span" data-nav-item-label="">
              My work
            </Text>
          </Stack>
        </Link>
        <Link to="/inbox" color="inherit" {...clickProp}>
          <Stack direction="horizontal" align="center" gap={1} data-nav-item-inner="">
            <NavInboxIcon />
            <Text as="span" data-nav-item-label="">
              Inbox
            </Text>
          </Stack>
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
          data-notifications-link=""
          {...clickProp}
        >
          <Stack direction="horizontal" align="center" gap={1} data-nav-item-inner="">
            <NavNotificationsIcon />
            <Text as="span" data-nav-item-label="">
              Notifications
            </Text>
            {unreadNotifications !== undefined && unreadNotifications > 0 && (
              <Badge
                label={unreadNotifications > 99 ? "99+" : unreadNotifications}
                variant="orange"
              />
            )}
          </Stack>
        </Link>
      </Stack>
      {workspaces.length > 0 && (
        <Stack as="nav" data-app-nav="" data-workspace-nav="" aria-label="Your workspaces">
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
              <Stack direction="horizontal" align="center" gap={1} data-nav-item-inner="">
                <Stack
                  as="span"
                  width="1.25rem"
                  height="1.25rem"
                  justify="center"
                  align="center"
                  data-workspace-nav-dot=""
                  aria-hidden="true"
                >
                  {workspace.name.slice(0, 1).toUpperCase()}
                </Stack>
                <Text as="span" data-nav-item-label="">
                  {workspace.name}
                </Text>
              </Stack>
            </Link>
          ))}
        </Stack>
      )}
      {isAdmin && (
        <Stack
          as="nav"
          data-app-nav=""
          data-workspace-nav=""
          aria-label="Installation administration"
        >
          <Text as="p" display="block" type="inherit" color="inherit">
            Admin
          </Text>
          <Link to="/settings/smtp" color="inherit" {...clickProp}>
            <Stack direction="horizontal" align="center" gap={1} data-nav-item-inner="">
              <NavMailIcon />
              <Text as="span" data-nav-item-label="">
                SMTP settings
              </Text>
            </Stack>
          </Link>
          <Link to="/history/installation" color="inherit" {...clickProp}>
            <Stack direction="horizontal" align="center" gap={1} data-nav-item-inner="">
              <Icon icon="clock" size="sm" />
              <Text as="span" data-nav-item-label="">
                Installation history
              </Text>
            </Stack>
          </Link>
        </Stack>
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
    <footer data-sidebar-footer="">
      {session?.signedIn && (
        <Stack direction="horizontal" vAlign="center" gap={1} data-sidebar-account-row="">
          <Link to="/account" color="inherit" data-sidebar-account-link="" {...clickProp}>
            <Stack data-sidebar-account-text="">
              <Text
                as="span"
                type="body"
                weight="semibold"
                color="inherit"
                data-sidebar-account-name=""
              >
                {session.displayName ?? session.email}
              </Text>
              {session.displayName !== null && (
                <Text as="span" type="supporting" color="secondary" data-sidebar-account-email="">
                  {session.email}
                </Text>
              )}
            </Stack>
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
      <Stack data-sidebar-attribution="">
        <ForgeOrbitAttribution />
      </Stack>
    </footer>
  );
}

function ForgeOrbitAttribution() {
  return (
    <Text as="p" display="block" data-forge-orbit-attribution="">
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
    </Text>
  );
}

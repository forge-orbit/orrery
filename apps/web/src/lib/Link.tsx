import { Link as AstryxLink, type LinkProps } from "@astryxdesign/core/Link";
import { createLink, Link as RouterLink } from "@tanstack/react-router";
import { createElement, type ComponentProps } from "react";

function ThemedLink(props: LinkProps) {
  return <AstryxLink as="a" type="inherit" color="accent" {...props} />;
}

export const Link = createLink(ThemedLink);

export function RouterAnchor({
  href,
  to,
  target,
  children,
  ...props
}: ComponentProps<"a"> & { to?: string }) {
  const destination = typeof href === "string" ? href : typeof to === "string" ? to : undefined;
  if (destination !== undefined && destination.startsWith("/") && !destination.startsWith("//")) {
    return (
      <RouterLink to={destination} {...(target !== undefined ? { target } : {})} {...props}>
        {children}
      </RouterLink>
    );
  }
  return createElement("a", { href: destination, target, ...props }, children);
}

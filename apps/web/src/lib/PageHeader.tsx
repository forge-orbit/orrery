import { Divider } from "@astryxdesign/core/Divider";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Stack, StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import type { ReactNode } from "react";
import { Fragment } from "react";

export interface PageHeaderProps {
  breadcrumbs?: ReactNode[];
  title: ReactNode;
  badge?: ReactNode;
  statusToken?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /**
   * Keep the action buttons pinned to the top-right: long titles wrap on the
   * left instead of pushing the actions onto a second row. Other pages keep
   * the default centre-aligned, wrapping behaviour.
   */
  nonWrappingActions?: boolean;
  /** Draw a bottom divider beneath the header. Set false inside LayoutHeader hasDivider. */
  hasDivider?: boolean;
}

export function PageHeader({
  breadcrumbs,
  title,
  badge,
  statusToken,
  subtitle,
  actions,
  nonWrappingActions = false,
  hasDivider = true,
}: PageHeaderProps) {
  const titleBlock = (
    <Stack gap={0.5}>
      <Stack direction="horizontal" gap={2} align="center" wrap="wrap">
        <Heading level={1} color="inherit">
          {title}
        </Heading>
        {badge !== undefined &&
          (typeof badge === "string" || typeof badge === "number" ? (
            <Token label={String(badge)} color="gray" size="sm" />
          ) : (
            <Text as="span" type="code" color="secondary">
              {badge}
            </Text>
          ))}
        {statusToken}
      </Stack>
      {subtitle !== undefined && (
        <Text
          as={typeof subtitle === "string" ? "p" : "div"}
          display="block"
          type="supporting"
          color="secondary"
        >
          {subtitle}
        </Text>
      )}
    </Stack>
  );
  const actionsBlock = actions !== undefined && (
    <Stack
      direction="horizontal"
      gap={2}
      align="center"
      wrap={nonWrappingActions ? "nowrap" : "wrap"}
    >
      {actions}
    </Stack>
  );

  return (
    <Stack as="header" gap={2} data-page-header="">
      {breadcrumbs !== undefined && breadcrumbs.length > 0 && (
        <Stack
          as="nav"
          direction="horizontal"
          gap={1.5}
          align="center"
          wrap="wrap"
          aria-label="Breadcrumb"
        >
          {breadcrumbs.length === 1 && <Icon icon="chevronLeft" size="xsm" color="secondary" />}
          {breadcrumbs.map((crumb, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- static ordered breadcrumb segments
            <Fragment key={index}>
              {index > 0 && <Icon icon="chevronRight" size="xsm" color="secondary" />}
              {crumb}
            </Fragment>
          ))}
        </Stack>
      )}
      <Stack
        direction="horizontal"
        justify="between"
        align={nonWrappingActions ? "start" : "center"}
        gap={3}
        wrap={nonWrappingActions ? "nowrap" : "wrap"}
      >
        {nonWrappingActions ? (
          <>
            <StackItem size="fill">{titleBlock}</StackItem>
            {actionsBlock && <StackItem size="static">{actionsBlock}</StackItem>}
          </>
        ) : (
          <>
            {titleBlock}
            {actionsBlock}
          </>
        )}
      </Stack>
      {hasDivider && <Divider />}
    </Stack>
  );
}

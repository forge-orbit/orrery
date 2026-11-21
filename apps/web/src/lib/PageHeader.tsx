import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import type { ReactNode } from "react";
import { Fragment } from "react";

export interface PageHeaderProps {
  breadcrumbs?: ReactNode[];
  title: ReactNode;
  badge?: ReactNode;
  statusToken?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({
  breadcrumbs,
  title,
  badge,
  statusToken,
  subtitle,
  actions,
}: PageHeaderProps) {
  return (
    <Stack as="header" gap={2}>
      {breadcrumbs !== undefined && breadcrumbs.length > 0 && (
        <Stack
          as="nav"
          direction="horizontal"
          gap={1.5}
          align="center"
          wrap="wrap"
          aria-label="Breadcrumb"
        >
          {breadcrumbs.length === 1 && <Icon icon="chevronLeft" size="xsm" />}
          {breadcrumbs.map((crumb, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- static ordered breadcrumb segments
            <Fragment key={index}>
              {index > 0 && <Icon icon="chevronRight" size="xsm" />}
              {crumb}
            </Fragment>
          ))}
        </Stack>
      )}
      <Stack direction="horizontal" justify="between" align="center" gap={2} wrap="wrap">
        <Stack gap={0.5}>
          <Stack direction="horizontal" gap={0.5} align="center" wrap="wrap">
            <Heading level={1} color="inherit">
              {title}
            </Heading>
            {badge !== undefined && (
              <Text as="span" type="code" color="secondary">
                {badge}
              </Text>
            )}
            {statusToken}
          </Stack>
          {subtitle !== undefined && (
            <Text as="p" display="block" type="supporting">
              {subtitle}
            </Text>
          )}
        </Stack>
        {actions !== undefined && (
          <Stack direction="horizontal" gap={1} align="center" wrap="wrap">
            {actions}
          </Stack>
        )}
      </Stack>
    </Stack>
  );
}

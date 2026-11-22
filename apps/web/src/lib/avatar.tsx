import { Avatar as AstryxAvatar } from "@astryxdesign/core/Avatar";
import type { ComponentProps } from "react";

type AstryxAvatarProps = ComponentProps<typeof AstryxAvatar>;

/**
 * A Human's profile photo with Astryx's built-in initials fallback. The image is
 * only passed when present: an expired or missing photo falls back to initials
 * rather than showing a broken image.
 */
export function HumanAvatar({
  name,
  avatarUrl,
  size = "xsm",
  tooltip = false,
  alt,
}: {
  name: string;
  avatarUrl?: string | null;
  size?: AstryxAvatarProps["size"];
  tooltip?: AstryxAvatarProps["tooltip"];
  alt?: string;
}) {
  return (
    <AstryxAvatar
      {...(avatarUrl == null ? {} : { src: avatarUrl })}
      name={name}
      {...(alt === undefined ? {} : { alt })}
      size={size}
      shape="circle"
      tooltip={tooltip}
      data-avatar-name={name}
      data-avatar-state={avatarUrl == null ? "initials" : "photo"}
    />
  );
}

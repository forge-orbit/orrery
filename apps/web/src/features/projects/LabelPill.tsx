import { Token } from "@astryxdesign/core/Token";
import type { ProjectLabel } from "@orrery/contract";

type TokenColor =
  | "red"
  | "pink"
  | "orange"
  | "yellow"
  | "green"
  | "teal"
  | "cyan"
  | "blue"
  | "purple"
  | "gray";

export function tokenColorForHex(hex: string): TokenColor {
  switch (hex.toLowerCase()) {
    case "#d94848":
      return "red";
    case "#d6457d":
      return "pink";
    case "#e06c2b":
      return "orange";
    case "#c88a1e":
      return "yellow";
    case "#2f9e66":
      return "green";
    case "#1f8a8a":
      return "teal";
    case "#2884c8":
      return "cyan";
    case "#3b74d6":
      return "blue";
    case "#7c52d9":
      return "purple";
    case "#64748b":
      return "gray";
    default:
      return "blue";
  }
}

export function LabelPill({ label }: { label: ProjectLabel }) {
  return (
    <Token
      label={label.name}
      color={tokenColorForHex(label.color)}
      size="sm"
      data-label-id={label.id}
      data-label-name={label.name}
    />
  );
}

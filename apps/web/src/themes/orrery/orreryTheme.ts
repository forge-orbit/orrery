import { defineTheme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";

export const orreryTheme = defineTheme({
  name: "orrery",
  extends: neutralTheme,
  localTokens: {
    "--orrery-ink": "#14161b",
    "--orrery-cream": "#f6f3ec",
    "--orrery-orange": "#f2561d",
    "--orrery-canvas": ["#ece6da", "#15171c"],
    "--orrery-text": ["#14161b", "#f6f3ec"],
    "--orrery-surface": ["#fffdf8", "#25272f"],
    "--orrery-recessed": ["#e6dfd1", "#1b1d25"],
    "--orrery-muted": ["#595a5e", "#b4b0a8"],
    "--orrery-border": ["#d2c8b6", "#40434d"],
    "--orrery-control-border": ["#827b70", "#82838e"],
    "--orrery-accent": ["#a8360e", "#ff996a"],
    "--orrery-accent-hover": ["#862807", "#ffb18c"],
    "--orrery-on-accent": ["#fffdf8", "#14161b"],
    "--orrery-attention-text": ["#89330f", "#ffc19f"],
    "--orrery-attention-fill": ["#fff0e4", "#38271f"],
    "--orrery-attention-line": ["#c87141", "#ad6b4f"],
    "--orrery-error": ["#a52831", "#ffa0a5"],
    "--orrery-error-fill": ["#fff0ee", "#3b252a"],
    "--orrery-success": ["#295740", "#aed9b8"],
    "--orrery-success-fill": ["#e8efe6", "#23382c"],
    "--orrery-radius": "6px",
    "--orrery-panel-radius": "10px",
    "--orrery-sans": "Figtree, system-ui, sans-serif",
    "--orrery-serif": "Georgia, serif",
    "--orrery-mono": 'ui-monospace, "SFMono-Regular", Consolas, monospace',
  },
  tokens: {
    "--color-background-body": "var(--orrery-canvas)",
    "--color-background-card": "var(--orrery-surface)",
    "--color-background-popover": "var(--orrery-surface)",
    "--color-background-surface": "var(--orrery-surface)",
    "--color-background-muted": "var(--orrery-recessed)",
    "--color-text-primary": "var(--orrery-text)",
    "--color-text-secondary": "var(--orrery-muted)",
    "--color-icon-primary": "var(--orrery-text)",
    "--color-icon-secondary": "var(--orrery-muted)",
    "--color-border": "var(--orrery-border)",
    "--color-border-emphasized": "var(--orrery-control-border)",
    "--color-accent": "var(--orrery-accent)",
    "--color-on-accent": "var(--orrery-on-accent)",
    "--color-text-accent": "var(--orrery-accent)",
    "--color-icon-accent": "var(--orrery-accent)",
    "--color-accent-muted": "var(--orrery-attention-fill)",
    "--color-error": "var(--orrery-error)",
    "--color-error-muted": "var(--orrery-error-fill)",
    "--color-text-error": "var(--orrery-error)",
    "--color-on-error": "var(--orrery-on-accent)",
    "--color-on-error-muted": "var(--orrery-error)",
    "--color-success": "var(--orrery-success)",
    "--color-success-muted": "var(--orrery-success-fill)",
    "--color-text-success": "var(--orrery-success)",
    "--color-on-success-muted": "var(--orrery-success)",
    "--color-warning-muted": "var(--orrery-attention-fill)",
    "--color-text-warning": "var(--orrery-attention-text)",
    "--color-on-warning-muted": "var(--orrery-attention-text)",
    "--font-family-body": "var(--orrery-sans)",
    "--font-family-heading": "var(--orrery-sans)",
    "--font-family-code": "var(--orrery-mono)",
    "--radius-element": "var(--orrery-radius)",
    "--radius-container": "var(--orrery-panel-radius)",
    "--shadow-inset-hover":
      "inset 0px 0px 0px 2px color-mix(in srgb, var(--orrery-accent) 28%, transparent)",
    "--shadow-inset-selected":
      "inset 0px 0px 0px 2px color-mix(in srgb, var(--orrery-accent) 52%, transparent)",
  },
  components: {
    card: {
      base: {
        borderRadius: "var(--orrery-panel-radius)",
        padding: "var(--spacing-4)",
      },
    },
    "clickable-card": {
      base: {
        borderRadius: "var(--orrery-panel-radius)",
      },
    },
    section: {
      base: {
        borderRadius: "var(--orrery-panel-radius)",
        padding: "var(--spacing-4)",
      },
      "variant:section": {
        borderWidth: "1px",
        borderStyle: "solid",
        borderColor: "var(--color-border)",
      },
      "variant:muted": {
        borderWidth: "1px",
        borderStyle: "solid",
        borderColor: "var(--color-border)",
      },
    },
    "side-nav": {
      base: {
        backgroundColor: "var(--color-background-surface)",
      },
    },
    "side-nav-item": {
      selected: {
        backgroundColor: "color-mix(in srgb, var(--orrery-text) 9%, transparent)",
        color: "var(--orrery-text)",
        fontWeight: "600",
      },
    },
    "progress-bar-track": {
      base: {
        backgroundColor: "color-mix(in srgb, var(--orrery-recessed) 50%, var(--orrery-surface))",
      },
    },
    "app-shell-sidenav": {
      base: {
        backgroundColor: "var(--orrery-surface)",
        borderInlineEnd: "1px solid var(--orrery-border)",
      },
    },
    "app-shell-header": {
      base: {
        backgroundColor: "var(--orrery-surface)",
        borderBlockEnd: "1px solid var(--orrery-border)",
      },
    },
  },
});

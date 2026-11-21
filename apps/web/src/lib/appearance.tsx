import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Section } from "@astryxdesign/core/Section";
import { Theme } from "@astryxdesign/core/theme";
import { createContext, createElement, type ReactNode, use, useState } from "react";
import { defaultThemeSlug, themes } from "../astryx-themes.ts";

type Appearance = "system" | "light" | "dark";

const theme = themes[defaultThemeSlug];
const AppearanceContext = createContext<
  [mode: Appearance, setMode: (mode: Appearance) => void] | null
>(null);

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const appearance = useState<Appearance>(() => {
    const initial = document.documentElement.dataset.theme;
    return initial === "light" || initial === "dark" ? initial : "system";
  });

  return (
    <AppearanceContext value={appearance}>
      <Theme theme={theme} mode={appearance[0]}>
        {children}
      </Theme>
    </AppearanceContext>
  );
}

function SystemIcon() {
  return createElement(
    "svg",
    { width: "16", height: "16", viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
    createElement("rect", {
      x: "2",
      y: "3",
      width: "12",
      height: "8.5",
      rx: "1.5",
      stroke: "currentColor",
      strokeWidth: "1.4",
    }),
    createElement("path", {
      d: "M5.5 13.5h5M8 11.5v2",
      stroke: "currentColor",
      strokeWidth: "1.4",
      strokeLinecap: "round",
    }),
  );
}

function SunIcon() {
  return createElement(
    "svg",
    { width: "16", height: "16", viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
    createElement("circle", {
      cx: "8",
      cy: "8",
      r: "3",
      stroke: "currentColor",
      strokeWidth: "1.4",
    }),
    createElement("path", {
      d: "M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.58 3.58l1.06 1.06M11.36 11.36l1.06 1.06M12.42 3.58l-1.06 1.06M4.64 11.36l-1.06 1.06",
      stroke: "currentColor",
      strokeWidth: "1.4",
      strokeLinecap: "round",
    }),
  );
}

function MoonIcon() {
  return createElement(
    "svg",
    { width: "16", height: "16", viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
    createElement("path", {
      d: "M13.2 9.9A5.5 5.5 0 0 1 6.1 2.8a5.5 5.5 0 1 0 7.1 7.1Z",
      stroke: "currentColor",
      strokeWidth: "1.4",
      strokeLinejoin: "round",
    }),
  );
}

export function useResolvedAppearance(): "light" | "dark" {
  const appearance = use(AppearanceContext);
  const mode = appearance?.[0] ?? "system";
  if (mode === "light" || mode === "dark") return mode;
  if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  ) {
    return "dark";
  }
  return "light";
}

export function AppearancePicker({ forceDark = false }: { forceDark?: boolean }) {
  const appearance = use(AppearanceContext);
  if (appearance === null) throw new Error("AppearancePicker requires AppearanceProvider.");
  const [mode, setMode] = appearance;

  function select(value: string) {
    if (value !== "light" && value !== "dark" && value !== "system") return;
    setMode(value);
    try {
      if (value === "system") window.localStorage.removeItem("orrery.appearance");
      else window.localStorage.setItem("orrery.appearance", value);
    } catch {}
  }

  const control = (
    <SegmentedControl label="Appearance" size="sm" value={mode} onChange={select}>
      <SegmentedControlItem value="system" label="System" isLabelHidden icon={<SystemIcon />} />
      <SegmentedControlItem value="light" label="Light" isLabelHidden icon={<SunIcon />} />
      <SegmentedControlItem value="dark" label="Dark" isLabelHidden icon={<MoonIcon />} />
    </SegmentedControl>
  );

  return (
    <Section variant="transparent" padding={0}>
      {forceDark ? (
        <Theme theme={theme} mode="dark">
          {control}
        </Theme>
      ) : (
        control
      )}
    </Section>
  );
}

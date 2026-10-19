import type { GloomPlugin, GloomPluginContext } from "gloomberb/types/plugin";
import { PinePane } from "./pane";

export const PINE_PLUGIN_ID = "pine";
export const PINE_PANE_ID = "pine";

/**
 * The plugin as both entries share it. The Bun entry (index.ts) adds the
 * service that keeps and runs scripts; the desktop view's entry
 * (index.browser.ts) has only the pane, which reaches that service through
 * its capability.
 */
export function createPinePlugin(options: { setup?: (ctx: GloomPluginContext) => void; dispose?: () => void } = {}): GloomPlugin {
  return {
    id: PINE_PLUGIN_ID,
    name: "Pine Scripts",
    version: "0.1.0",
    description: "Paste a Pine Script v5 or v6 indicator and chart it on any ticker",
    homepage: "https://github.com/gloom-sh/gloom-pine",
    toggleable: true,
    // Scripts run in Bun workers: the terminal and the desktop app, not the web.
    targets: ["cli", "tui", "desktop"],
    panes: [
      {
        id: PINE_PANE_ID,
        name: "Pine Scripts",
        icon: "P",
        component: PinePane,
        defaultPosition: "right",
        defaultMode: "floating",
        defaultFloatingSize: { width: 96, height: 32 },
      },
    ],
    paneTemplates: [
      {
        id: "pine-pane",
        paneId: PINE_PANE_ID,
        label: "Pine Scripts",
        description: "Paste a Pine Script indicator and chart it on any ticker, over the price or in a panel of its own.",
        keywords: ["pine", "script", "indicator", "study", "custom indicator"],
        shortcut: { prefix: "PINE" },
        // One window: the scripts are the profile's, not the window's.
        createInstance: () => ({ placement: "floating", instanceId: "pine-scripts" }),
      },
    ],
    ...(options.setup ? { setup: options.setup } : {}),
    ...(options.dispose ? { dispose: options.dispose } : {}),
  };
}

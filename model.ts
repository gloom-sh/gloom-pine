/**
 * What a script is and what running it gives back, shared by the Bun process
 * (which runs scripts) and the pane (which may live in the desktop view).
 * Nothing here imports the script runtime.
 */

/** A script as it is saved. */
export interface PineScript {
  /** Stable for the life of the script; the series id is `pine:<id>`. */
  id: string;
  name: string;
  /** The name was typed rather than taken from the script's title, so a new title leaves it. */
  named?: boolean;
  source: string;
  updatedAt: number;
  /** What the last check found, so the series register at startup without running it. */
  check?: ScriptCheck;
}

/** How a line is drawn, in the chart's own vocabulary. */
export type LineStyle = "line" | "area" | "step" | "columns" | "points";

/** One line a script draws: a `plot()` or an `hline()`. */
export interface ScriptLine {
  /** Letters, digits, ".", "_" or "-", unique in the script. */
  id: string;
  name: string;
  style: LineStyle;
}

export interface ScriptInput {
  title: string;
  type: string;
  defval: unknown;
}

/** What a script declares, read from a run. */
export interface ScriptInfo {
  title: string;
  /** `overlay=true`: drawn over the ticker's price, on its axis. */
  overlay: boolean;
  lines: ScriptLine[];
  /** What the script draws that a Gloom chart does not (shapes, fills, labels), one name each. */
  notDrawn: string[];
  inputs: ScriptInput[];
  /** `strategy()` scripts run as indicators: their plots are drawn, orders are not. */
  strategy: boolean;
}

export interface ScriptError {
  message: string;
  /** 1-based, when the error points at a place in the script. */
  line?: number;
  column?: number;
}

export type ScriptCheck =
  | { ok: true; info: ScriptInfo; checkedAt: number }
  | { ok: false; error: ScriptError; checkedAt: number };

/** One bar as the runtime takes it; times are epoch milliseconds. */
export interface Candle {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** A script's lines over the bars it ran on: `[bar open time, value or null]`. */
export interface ScriptOutput {
  info: ScriptInfo;
  values: Record<string, Array<[number, number | null]>>;
}

/** The namespace every script series charts under: `CAP:pine:<script id>~<line>/<ticker>`. */
export const SERIES_NAMESPACE = "pine";

/** What the pane calls to list, save, rename and delete scripts; the series namespace is a capability of its own. */
export const SCRIPTS_CAPABILITY_ID = "pine-scripts";

export function seriesIdOf(script: Pick<PineScript, "id">): string {
  return `${SERIES_NAMESPACE}:${script.id}`;
}

/** A script id from its first name: `RSI with bands` → `rsi-with-bands`, made unique against `taken`. */
export function scriptIdFor(name: string, taken: ReadonlySet<string>): string {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "script";
  let id = base;
  for (let suffix = 2; taken.has(id); suffix += 1) id = `${base}-${suffix}`;
  return id;
}

/** `1:2: message` style location for an error, or the message alone. */
export function formatScriptError(error: ScriptError): string {
  if (error.line === undefined) return error.message;
  return `Line ${error.line}${error.column !== undefined ? `, column ${error.column}` : ""}: ${error.message}`;
}

/** The name a script gets when none is typed: its `indicator()` title, else "Script". */
export function defaultScriptName(source: string): string {
  const match = /^\s*(?:indicator|strategy|study)\s*\(\s*(?:title\s*=\s*)?(["'])(.*?)\1/m.exec(source);
  return match?.[2]?.trim().slice(0, 60) || "Script";
}

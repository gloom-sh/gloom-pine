/**
 * Runs one script over a list of bars with PineTS and reads back what it drew.
 * Called from the worker (worker.ts), never on the app's own thread: a script
 * can loop for as long as it likes, and only a worker can be stopped.
 */
import { Indicator, PineTS } from "pinets";
import { resolutionOfTimeframe } from "./bars";
import type { Candle, LineStyle, ScriptError, ScriptInfo, ScriptInput, ScriptLine, ScriptOutput } from "./model";

/** What the runtime asks for when a script calls `request.security()` on another symbol or timeframe. */
export type BarsLoader = (request: { symbol: string; timeframe: string; start?: number; end?: number; limit?: number }) => Promise<Candle[]>;

export interface RunRequest {
  source: string;
  symbol: string;
  /** Pine timeframe of the bars: `D`, `W`, `M`, `60`, `5`. */
  timeframe: string;
  bars: Candle[];
  currency?: string;
}

/** A chart holds ten series: the ticker's price and up to eight of a script's lines. */
export const MAX_LINES = 8;

/** Thrown with a message a person can act on, and the place in the script when there is one. */
export class ScriptFailure extends Error {
  constructor(readonly detail: ScriptError) {
    super(detail.message);
  }
}

const PLOT_STYLES: Record<string, LineStyle> = {
  style_line: "line",
  style_linebr: "line",
  style_stepline: "step",
  style_steplinebr: "step",
  style_stepline_diamond: "step",
  style_histogram: "columns",
  style_columns: "columns",
  style_area: "area",
  style_areabr: "area",
  style_circles: "points",
  style_cross: "points",
};

/** Plot kinds a Gloom chart has no drawing for, by the name a script author knows them by. */
const NOT_DRAWN: Record<string, string> = {
  shape: "plotshape",
  char: "plotchar",
  arrow: "plotarrow",
  bar: "plotbar",
  candle: "plotcandle",
  background: "bgcolor",
  barcolor: "barcolor",
  fill: "fill",
  linefill: "fill",
  label: "labels",
  drawing_line: "lines",
  drawing_box: "boxes",
  drawing_polyline: "polylines",
  table: "tables",
};

function lineId(title: string, index: number, taken: Set<string>): string {
  const base = title.startsWith("#") ? `plot-${index + 1}` : title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || `plot-${index + 1}`;
  let id = base;
  for (let suffix = 2; taken.has(id); suffix += 1) id = `${base}-${suffix}`;
  taken.add(id);
  return id;
}

function lineName(title: string, index: number, style: "plot" | "hline", value: number | null): string {
  if (!title.startsWith("#")) return title.slice(0, 60);
  if (style === "hline" && value !== null) return `Level ${Number(value.toFixed(6))}`;
  return `Plot ${index + 1}`;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Whether a drawing collection (`__labels__`) holds anything on any bar. */
function hasDrawings(data: unknown): boolean {
  if (!Array.isArray(data)) return false;
  return data.some((entry) => Array.isArray(entry?.value) && entry.value.length > 0);
}

interface PlotEntry {
  title?: string;
  options?: { style?: string; display?: string };
  data?: Array<{ time: number; value: unknown }>;
}

/** The lines a finished run drew, in the order the script declared them, with what it drew that a chart cannot. */
export function readPlots(plots: Record<string, PlotEntry>): { lines: Array<ScriptLine & { values: Array<[number, number | null]> }>; notDrawn: string[] } {
  const lines: Array<ScriptLine & { values: Array<[number, number | null]> }> = [];
  const notDrawn = new Set<string>();
  const taken = new Set<string>();
  let index = 0;
  for (const [key, plot] of Object.entries(plots ?? {})) {
    const style = plot?.options?.style;
    if (key.startsWith("__")) {
      if (style && NOT_DRAWN[style] && hasDrawings(plot.data)) notDrawn.add(NOT_DRAWN[style]!);
      continue;
    }
    if (style && NOT_DRAWN[style]) {
      notDrawn.add(NOT_DRAWN[style]!);
      continue;
    }
    if (plot?.options?.display === "none") continue;
    const isHline = style === "hline";
    const drawStyle: LineStyle = isHline ? "line" : PLOT_STYLES[style ?? "style_line"] ?? "line";
    const values = (plot.data ?? []).map((point): [number, number | null] => [point.time, finite(point.value)]);
    const title = plot.title ?? key;
    const firstValue = values.find(([, value]) => value !== null)?.[1] ?? null;
    lines.push({
      id: lineId(title, index, taken),
      name: lineName(title, index, isHline ? "hline" : "plot", firstValue),
      style: drawStyle,
      values,
    });
    index += 1;
  }
  return { lines, notDrawn: [...notDrawn] };
}

function readInputs(indicator: Indicator): ScriptInput[] {
  try {
    return indicator.getInputsMeta().map((input) => ({
      title: input.title ?? input.name ?? input.id,
      type: input.type,
      defval: input.defval,
    }));
  } catch {
    return [];
  }
}

/** The 1-based line of the first place `needle` is written as a word (or called, with `call`), outside comments. */
function lineOf(source: string, needle: string, call = false): number | undefined {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|[^\\w.])${escaped}${call ? "\\s*\\(" : "(?![\\w])"}`);
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const code = lines[index]!.replace(/\/\/.*$/, "");
    if (pattern.test(code)) return index + 1;
  }
  return undefined;
}

/** The first bracket the script opens and never closes, outside strings and comments. */
function unclosedBracket(source: string): { char: string; line: number; column: number } | null {
  const open: Array<{ char: string; line: number; column: number }> = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index]!;
    let quote: string | null = null;
    for (let column = 0; column < text.length; column += 1) {
      const char = text[column]!;
      if (quote) {
        if (char === "\\") column += 1;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === "/" && text[column + 1] === "/") break;
      if (char === "\"" || char === "'") quote = char;
      else if (char === "(" || char === "[" || char === "{") open.push({ char, line: index + 1, column: column + 1 });
      else if (pairs[char] && open.at(-1)?.char === pairs[char]) open.pop();
    }
  }
  return open[0] ?? null;
}

const VERSION_LINE = /^\s*\/\/\s*@version\s*=\s*(\d+)\s*$/im;
const LIBRARY_IMPORT = /^\s*import\s+([\w.-]+\/[\w.-]+(?:\/\d+)?)/m;

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

/**
 * What keeps a script from running before it runs: its version, and libraries.
 * The runtime treats a script with no version line as JavaScript, so a script
 * without one never reaches it.
 */
export function refusal(source: string): ScriptError | null {
  const version = VERSION_LINE.exec(source);
  if (!version) {
    return { message: "Add //@version=6 at the top. Without it the script is Pine Script version 1, which does not run here." };
  }
  const number = Number(version[1]);
  if (number < 5) {
    return { message: `This is Pine Script version ${number}. Convert it to version 5 or 6 to run it here.`, line: lineAt(source, version.index) };
  }
  const library = LIBRARY_IMPORT.exec(source);
  if (library) {
    return { message: `Libraries do not run here, and this script imports ${library[1]}.`, line: lineAt(source, library.index + library[0].indexOf("import")) };
  }
  return null;
}

/** A runtime or compiler error as a person reads it: what is wrong, and where when it can tell. */
export function describeError(error: unknown, source: string): ScriptError {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.replace(/\s+/g, " ").trim();
  const located = /^Failed to transpile Pine Script(?: version \d+)?: (.*?) at (\d+):(\d+)$/.exec(message);
  if (located) {
    if (/^Unexpected token EOF/.test(located[1]!)) {
      const bracket = unclosedBracket(source);
      if (bracket) return { message: `This "${bracket.char}" is never closed.`, line: bracket.line, column: bracket.column };
      return { message: "The script ends too early.", line: Number(located[2]), column: Number(located[3]) };
    }
    return { message: located[1]!, line: Number(located[2]), column: Number(located[3]) };
  }
  const transpile = /^Failed to transpile Pine Script(?: version \d+)?: (.*)$/.exec(message);
  if (transpile) return { message: transpile[1]! };
  const missing = /^([A-Za-z_][\w.]*) is not a function/.exec(message);
  // Only a function the script calls by that name and does not write itself; anything else is the runtime's own.
  const declares = (name: string) => new RegExp(`^\\s*(?:export\\s+)?(?:method\\s+)?${name.replace(/\./g, "\\.")}\\s*\\(.*=>`, "m").test(source);
  const called = missing && !declares(missing[1]!) ? lineOf(source, missing[1]!, true) : undefined;
  if (missing && called) return { message: `${missing[1]}() is not supported.`, line: called };
  const undeclared = /^Undeclared identifier "([^"]+)"/.exec(message);
  if (undeclared) {
    const name = undeclared[1]!;
    return { message: `"${name}" is not defined.`, ...(lineOf(source, name) ? { line: lineOf(source, name) } : {}) };
  }
  if (/^Loop exceeded maximum iterations/.test(message)) {
    return { message: "A loop ran more than 500,000 times on one bar and was stopped." };
  }
  if (/^Unsupported Pine Script version/.test(message)) {
    return { message: message.replace(/\.$/, "") + ". Convert the script to version 5 or 6." };
  }
  // The runtime's own failures, not the script's: say so, and keep its words for a report.
  if (missing || /is not an object \(evaluating|Cannot read propert|is not iterable|dynamic computed member access/.test(message)) {
    return { message: `This script uses something the plugin cannot run yet (${message.replace(/\. \(In .*$/, "").replace(/\.$/, "")}).` };
  }
  return { message: message || "The script failed." };
}

/** The runtime's input data for one symbol: Gloom bars as PineTS klines. */
function provider(request: RunRequest, loadBars: BarsLoader) {
  const main = request.symbol.toUpperCase();
  return {
    async getMarketData(tickerId: string, timeframe: string, limit?: number, sDate?: number, eDate?: number) {
      const symbol = String(tickerId ?? "").replace(/^[A-Z]+:(?=[^:]+$)/i, "").toUpperCase() || main;
      const sameTimeframe = !timeframe || timeframe === request.timeframe
        || (resolutionOfTimeframe(timeframe) ?? timeframe) === (resolutionOfTimeframe(request.timeframe) ?? request.timeframe);
      if ((symbol === main || symbol === "") && sameTimeframe) {
        return request.bars;
      }
      return loadBars({
        symbol,
        timeframe: timeframe || request.timeframe,
        ...(sDate !== undefined ? { start: sDate } : {}),
        ...(eDate !== undefined ? { end: eDate } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
    },
    async getSymbolInfo(tickerId: string) {
      const symbol = String(tickerId ?? main).toUpperCase();
      return {
        ticker: symbol,
        tickerid: symbol,
        root: symbol,
        prefix: "",
        description: symbol,
        currency: request.currency ?? "USD",
        basecurrency: "",
        type: "stock",
        timezone: "America/New_York",
        session: "regular",
        mintick: 0.01,
        pricescale: 100,
        minmove: 1,
        pointvalue: 1,
      };
    },
    configure() {},
  };
}

/** Runs the script over the bars and returns every line it plots, keyed by line id. */
export async function runScript(request: RunRequest, loadBars: BarsLoader): Promise<ScriptOutput> {
  if (!request.source.trim()) throw new ScriptFailure({ message: "The script is empty." });
  const refused = refusal(request.source);
  if (refused) throw new ScriptFailure(refused);
  let indicator: Indicator;
  try {
    indicator = new Indicator(request.source);
  } catch (error) {
    throw new ScriptFailure(describeError(error, request.source));
  }
  const inputs = readInputs(indicator);
  let context: unknown;
  try {
    const pine = new PineTS(provider(request, loadBars) as never, request.symbol, request.timeframe, request.bars.length);
    context = await pine.run(indicator);
  } catch (error) {
    throw new ScriptFailure(describeError(error, request.source));
  }
  const ctx = context as unknown as {
    plots: Record<string, PlotEntry>;
    indicator?: { title?: string; overlay?: boolean };
    strategy?: { config?: { title?: string; overlay?: boolean } };
  };
  const declared = ctx.indicator ?? ctx.strategy?.config;
  const { lines: plotted, notDrawn } = readPlots(ctx.plots);
  // Past eight, the plots that drew something on these bars come first: a script
  // often declares plots its default inputs leave empty before the ones it shows.
  const drawing = new Set(plotted.filter((line) => line.values.some(([, value]) => value !== null)));
  const lines = plotted.length <= MAX_LINES
    ? plotted
    : [...plotted.filter((line) => drawing.has(line)), ...plotted.filter((line) => !drawing.has(line))]
      .slice(0, MAX_LINES)
      .sort((a, b) => plotted.indexOf(a) - plotted.indexOf(b));
  if (plotted.length > MAX_LINES) notDrawn.push(`${plotted.length - MAX_LINES} more plots (a chart shows ${MAX_LINES})`);
  const info: ScriptInfo = {
    title: declared?.title?.trim() || "Script",
    overlay: declared?.overlay === true,
    lines: lines.map(({ id, name, style }) => ({ id, name, style })),
    notDrawn,
    inputs,
    strategy: indicator.getDeclarationType() === "strategy",
  };
  return {
    info,
    // Every plot's values: the lines a chart draws were chosen when the script was checked, on other bars.
    values: Object.fromEntries(plotted.map((line) => [line.id, line.values])),
  };
}

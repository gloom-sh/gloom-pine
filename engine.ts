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
  /** The listing, as Gloom names it (`XSWX` for `NESN:XSWX`); none for a US listing. */
  exchange?: string;
  /** Pine timeframe of the bars: `D`, `W`, `M`, `60`, `5`. */
  timeframe: string;
  bars: Candle[];
  /** `syminfo.currency`. */
  currency?: string;
  /** `syminfo.timezone`: the listing's own, which `time()` and sessions are read in. */
  timezone?: string;
}

/** `NASDAQ:AAPL` as Pine writes a symbol: its prefix, if any, and the symbol. */
function pineSymbol(tickerId: string): { prefix: string; symbol: string } {
  const text = String(tickerId ?? "").trim().toUpperCase();
  const colon = text.indexOf(":");
  return colon > 0 ? { prefix: text.slice(0, colon), symbol: text.slice(colon + 1) } : { prefix: "", symbol: text };
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
  // `fill()` between two plots is drawn (readPlots); one between drawn lines (`linefill`) is not.
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
  options?: { style?: string; display?: string; color?: unknown; plot1?: string; plot2?: string };
  data?: Array<{ time: number; value: unknown; options?: { color?: unknown } }>;
}

const NAMED_COLORS: Record<string, string> = {
  aqua: "#00bcd4", black: "#363a45", blue: "#2962ff", fuchsia: "#e040fb", gray: "#787b86", green: "#4caf50",
  lime: "#00e676", maroon: "#880e4f", navy: "#311b92", olive: "#808000", orange: "#ff9800", purple: "#9c27b0",
  red: "#f23645", silver: "#b2b5be", teal: "#089981", white: "#ffffff", yellow: "#fdd835",
};

/** A colour the runtime gives (`#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`, a name) as `#rrggbb`, its transparency dropped. */
function hexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  const long = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(text);
  if (long) return `#${long[1]}`;
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(text);
  if (rgb) return `#${rgb.slice(1, 4).map((part) => Math.min(255, Number(part)).toString(16).padStart(2, "0")).join("")}`;
  return NAMED_COLORS[text.replace(/^color\./, "")] ?? null;
}

const HLINE_GRAY = "#787b86";

function isUnknownColor(value: unknown): boolean {
  return typeof value === "string" && /^#0{8}$/.test(value.trim());
}

/** Whether a colour shows at all: `na` and a fully transparent colour (`color.new(c, 100)`) do not. */
function shows(value: unknown): boolean {
  if (typeof value !== "string" || !hexColor(value)) return false;
  const text = value.trim().toLowerCase();
  const hexAlpha = /^#[0-9a-f]{6}([0-9a-f]{2})$/.exec(text);
  if (hexAlpha) return hexAlpha[1] !== "00";
  const rgbaAlpha = /^rgba\([^)]*,\s*([\d.]+)\s*\)$/.exec(text);
  return rgbaAlpha ? Number(rgbaAlpha[1]) > 0 : true;
}

/**
 * The colour a script gives a plot over the bars it has a value on: the most
 * common one, whether it changes bar by bar (`na` on some bars counts), and
 * whether it shows at all. A plot given no colour has none here, so the chart
 * picks one.
 */
function plotLook(plot: PlotEntry): { color: string | null; perBar: boolean; hidden: boolean } {
  const given = plot.options?.color;
  const counts = new Map<string, number>();
  for (const point of plot.data ?? []) {
    const color = point.options?.color;
    // Transparent black is what the runtime gives for a colour it could not work out (a gradient of
    // input colours): not a colour the script chose, so the chart picks one.
    if (finite(point.value) === null || isUnknownColor(color)) continue;
    const key = shows(color) ? hexColor(color)! : "none";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (given === undefined || (counts.size === 0 && isUnknownColor(given))) return { color: null, perBar: false, hidden: false };
  if (counts.size === 0) return { color: shows(given) ? hexColor(given) : null, perBar: false, hidden: !shows(given) };
  const visible = [...counts].filter(([key]) => key !== "none").sort((a, b) => b[1] - a[1]);
  return { color: visible[0]?.[0] ?? null, perBar: counts.size > 1, hidden: visible.length === 0 };
}

/**
 * The lines a finished run drew, in the order the script declared them, with
 * what it drew that a chart cannot. A `fill()` between two drawn lines shades
 * from the first to the second; one between anything else is not drawn. A plot
 * the script hides (`color=na`, fully transparent) is not drawn, unless a fill
 * needs it as an edge.
 */
export function readPlots(plots: Record<string, PlotEntry>): { lines: Array<ScriptLine & { values: Array<[number, number | null]> }>; notDrawn: string[] } {
  const notDrawn = new Set<string>();
  const fills: Array<{ from?: string; to?: string; color: string | null }> = [];
  const candidates: Array<{ key: string; plot: PlotEntry; style: LineStyle; isHline: boolean; look: ReturnType<typeof plotLook> }> = [];
  for (const [key, plot] of Object.entries(plots ?? {})) {
    const style = plot?.options?.style;
    if (key.startsWith("__")) {
      if (style && NOT_DRAWN[style] && hasDrawings(plot.data)) notDrawn.add(NOT_DRAWN[style]!);
      continue;
    }
    if (style === "fill") {
      fills.push({ from: plot.options?.plot1, to: plot.options?.plot2, color: plotLook(plot).color });
      continue;
    }
    if (style && NOT_DRAWN[style]) {
      notDrawn.add(NOT_DRAWN[style]!);
      continue;
    }
    if (plot?.options?.display === "none") continue;
    const isHline = style === "hline";
    candidates.push({ key, plot, style: isHline ? "line" : PLOT_STYLES[style ?? "style_line"] ?? "line", isHline, look: plotLook(plot) });
  }
  const keys = new Set(candidates.map((candidate) => candidate.key));
  const drawnFills = fills.filter((fill) => fill.from && fill.to && fill.from !== fill.to && keys.has(fill.from) && keys.has(fill.to));
  // A hidden plot a fill shades to is drawn in the fill's colour: the chart's band needs both edges.
  const edgeColor = new Map<string, string | null>();
  for (const fill of drawnFills) for (const key of [fill.from!, fill.to!]) if (!edgeColor.has(key)) edgeColor.set(key, fill.color);

  const lines: Array<ScriptLine & { values: Array<[number, number | null]> }> = [];
  const byKey = new Map<string, ScriptLine>();
  const taken = new Set<string>();
  let index = 0;
  for (const { key, plot, style, isHline, look } of candidates) {
    if (look.hidden && !edgeColor.has(key)) continue;
    const values = (plot.data ?? []).map((point): [number, number | null] => [point.time, finite(point.value)]);
    const title = plot.title ?? key;
    const firstValue = values.find(([, value]) => value !== null)?.[1] ?? null;
    if (look.perBar && !look.hidden) notDrawn.add("per-bar colors");
    // An hline the script gives no colour is Pine's grey, as everywhere else it is drawn.
    const color = look.hidden ? edgeColor.get(key) : look.color ?? (isHline ? HLINE_GRAY : null);
    const line = {
      id: lineId(title, index, taken),
      name: lineName(title, index, isHline ? "hline" : "plot", firstValue),
      style,
      ...(color ? { color } : {}),
      values,
    };
    lines.push(line);
    byKey.set(key, line);
    index += 1;
  }
  for (const fill of fills) {
    const first = fill.from ? byKey.get(fill.from) : undefined;
    const second = fill.to ? byKey.get(fill.to) : undefined;
    // A line shades to one other line, in its own colour: the edge whose colour is nearer the fill's takes it.
    // A second fill from both edges, or one to a plot not drawn, is not drawn.
    const edges = first && second && first !== second ? [first, second].filter((line) => !line.fill) : [];
    if (edges.length === 0) {
      notDrawn.add("fill");
      continue;
    }
    const [edge] = edges.sort((a, b) => colorDistance(a.color, fill.color) - colorDistance(b.color, fill.color));
    edge!.fill = (edge === first ? second : first)!.id;
  }
  return { lines, notDrawn: [...notDrawn] };
}

/** How far apart two `#rrggbb` colours look, roughly; an unknown one is as far as can be. */
function colorDistance(a: string | undefined, b: string | null): number {
  if (!a || !b) return Number.MAX_SAFE_INTEGER;
  const channels = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  const [x, y] = [channels(a), channels(b)];
  return x.reduce((sum, value, index) => sum + (value - y[index]!) ** 2, 0);
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

/**
 * The runtime's input data: Gloom bars as PineTS klines. The chart's ticker
 * is `XSWX:NESN` to the script, as Pine writes it, and a symbol the script
 * asks for keeps its prefix, so another listing of the same name is not read
 * by mistake.
 */
function provider(request: RunRequest, loadBars: BarsLoader) {
  const main = request.symbol.toUpperCase();
  const exchange = (request.exchange ?? "").toUpperCase();
  return {
    async getMarketData(tickerId: string, timeframe: string, limit?: number, sDate?: number, eDate?: number) {
      const asked = pineSymbol(tickerId);
      const symbol = asked.symbol || main;
      const sameTimeframe = !timeframe || timeframe === request.timeframe
        || (resolutionOfTimeframe(timeframe) ?? timeframe) === (resolutionOfTimeframe(request.timeframe) ?? request.timeframe);
      const isMain = symbol === main && (asked.prefix === "" || asked.prefix === exchange);
      if (isMain && sameTimeframe) return request.bars;
      return loadBars({
        // Gloom writes the listing after the symbol.
        symbol: isMain && exchange ? `${main}:${exchange}` : asked.prefix && !isMain ? `${symbol}:${asked.prefix}` : symbol,
        timeframe: timeframe || request.timeframe,
        ...(sDate !== undefined ? { start: sDate } : {}),
        ...(eDate !== undefined ? { end: eDate } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
    },
    async getSymbolInfo(tickerId: string) {
      const asked = pineSymbol(tickerId || main);
      const symbol = asked.symbol || main;
      const isMain = symbol === main && (asked.prefix === "" || asked.prefix === exchange);
      const prefix = isMain ? exchange : asked.prefix;
      return {
        ticker: symbol,
        tickerid: prefix ? `${prefix}:${symbol}` : symbol,
        root: symbol,
        prefix,
        description: symbol,
        currency: (isMain ? request.currency : undefined) ?? "USD",
        basecurrency: "",
        type: "stock",
        timezone: (isMain ? request.timezone : undefined) ?? "America/New_York",
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
    const tickerId = request.exchange ? `${request.exchange.toUpperCase()}:${request.symbol.toUpperCase()}` : request.symbol;
    const pine = new PineTS(provider(request, loadBars) as never, tickerId, request.timeframe, request.bars.length);
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
  // A fill to a line past the eight is not drawn either.
  const kept = new Set(lines.map((line) => line.id));
  for (const line of lines) {
    if (line.fill && !kept.has(line.fill)) {
      delete line.fill;
      if (!notDrawn.includes("fill")) notDrawn.push("fill");
    }
  }
  const info: ScriptInfo = {
    title: declared?.title?.trim() || "Script",
    overlay: declared?.overlay === true,
    lines: lines.map(({ values: _values, ...line }) => line),
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

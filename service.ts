/**
 * The saved scripts and the series they chart as, in the Bun process: the
 * terminal, the command line, and the process behind the desktop view. The
 * pane reaches it through the `pine-scripts` capability wherever it renders.
 */
import type { CapabilityOperation, PluginCapability } from "gloomberb/capabilities";
import type { LoadedSeriesDefinition, ManualChartResolution, SeriesLoadRequest, SeriesPoint } from "gloomberb/time-series";
import type { GloomPluginContext } from "gloomberb/types/plugin";
import { resolveExchangeTimeZone } from "gloomberb/utils";
import { loadCandles, pineTimeframe, resolutionOfTimeframe, splitTicker } from "./bars";
import type { RunRequest } from "./engine";
import {
  defaultScriptName,
  formatScriptError,
  scriptIdFor,
  seriesIdOf,
  SCRIPTS_CAPABILITY_ID,
  type Candle,
  type PineScript,
  type ScriptCheck,
  type ScriptOutput,
} from "./model";
import { ScriptRunError, ScriptRunner } from "./runner";

const STATE_KEY = "scripts";
const STATE_VERSION = 1;
/** Scripts one profile keeps. */
const MAX_SCRIPTS = 100;
/** The longest script saved, in characters. */
const MAX_SOURCE = 200_000;
/** How long one run's lines are reused for the same ticker, bars and window. */
const RESULT_TTL_MS = 60_000;
const MAX_RESULTS = 32;
/** A chart showing a script loads it again this often, for a bar that is still forming. */
const REFRESH_MS = 5 * 60_000;
const CHECK_BARS = 400;

/** A series label says what the data is; a domain or a source id in a script's name would not pass. */
function seriesLabel(value: string, max: number): string {
  const single = value.replace(/[\r\n\t]+/g, " ").trim()
    .replace(/\b([a-z0-9-]+)\.(com|net|org|io|co|ai|dev|app|gov|edu|info|biz)\b/gi, "$1 $2")
    .replace(/\b(provider|source|feed):/gi, "$1 ");
  return (single || "Script").slice(0, max);
}

/** A random walk to run a script on when it is saved: enough bars for long averages, no network. */
export function checkBars(count = CHECK_BARS, seed = 7): Candle[] {
  let state = seed;
  const random = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  const day = 86_400_000;
  const start = Date.UTC(2020, 0, 1);
  const bars: Candle[] = [];
  let close = 100;
  for (let index = 0; index < count; index += 1) {
    const open = close;
    close = Math.max(1, open * (1 + (random() - 0.5) * 0.04));
    const high = Math.max(open, close) * (1 + random() * 0.01);
    const low = Math.min(open, close) * (1 - random() * 0.01);
    bars.push({ openTime: start + index * day, closeTime: start + (index + 1) * day - 1, open, high, low, close, volume: Math.round(1e6 * (0.5 + random())) });
  }
  return bars;
}

function readScripts(value: unknown): PineScript[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is PineScript => (
    !!entry && typeof entry === "object"
    && typeof (entry as PineScript).id === "string"
    && typeof (entry as PineScript).name === "string"
    && typeof (entry as PineScript).source === "string"
  ));
}

/**
 * One run every chart asking for the same script, ticker and bars shares. It
 * stops when every chart that asked has closed, and not before: a chart that
 * asked without a way to cancel keeps it.
 */
interface SharedRun {
  at: number;
  output: Promise<ScriptOutput>;
  controller: AbortController;
  waiting: number;
  kept: boolean;
}

/** Waits for a shared run, or for this caller's own chart to close, whichever is first. */
function waitFor<T>(output: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return output;
  return new Promise<T>((resolve, reject) => {
    const reason = () => signal.reason ?? new DOMException("Aborted", "AbortError");
    if (signal.aborted) {
      reject(reason());
      return;
    }
    const onAbort = () => reject(reason());
    signal.addEventListener("abort", onAbort, { once: true });
    output.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export interface SaveInput {
  /** Absent for a new script. */
  id?: string;
  name?: string;
  source: string;
}

export class PineService {
  private scripts: PineScript[];
  private readonly registered = new Map<string, { key: string; dispose: () => void }>();
  private readonly results = new Map<string, SharedRun>();
  /** Each ticker's currency, read once. */
  private readonly currencies = new Map<string, Promise<string | undefined>>();
  private disposed = false;

  constructor(
    private readonly ctx: Pick<GloomPluginContext, "persistence" | "registerSeries" | "marketData" | "log">,
    private readonly runner: ScriptRunner = new ScriptRunner(),
  ) {
    this.scripts = readScripts(ctx.persistence.getState(STATE_KEY, { schemaVersion: STATE_VERSION }));
    for (const script of this.scripts) this.register(script);
  }

  list(): PineScript[] {
    return this.scripts.map((script) => ({ ...script }));
  }

  get(id: string): PineScript | null {
    return this.scripts.find((script) => script.id === id) ?? null;
  }

  /** Runs the script on made-up bars: what it draws, its inputs, or the first error. */
  async check(source: string): Promise<ScriptCheck> {
    const checkedAt = Date.now();
    try {
      const bars = checkBars();
      const output = await this.runner.run({ source, symbol: "CHECK", timeframe: "D", bars }, async () => bars);
      return { ok: true, info: output.info, checkedAt };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof ScriptRunError ? error.detail : { message: error instanceof Error ? error.message : String(error) },
        checkedAt,
      };
    }
  }

  /** Saves a script whether or not it runs, so a half-pasted script is not lost; only one that runs is charted. */
  async save(input: SaveInput): Promise<PineScript> {
    const source = typeof input.source === "string" ? input.source.replace(/\r\n?/g, "\n") : "";
    if (source.length > MAX_SOURCE) throw new Error(`Scripts are limited to ${MAX_SOURCE.toLocaleString("en-US")} characters.`);
    const existing = input.id ? this.get(input.id) : null;
    if (input.id && !existing) throw new Error("That script was deleted.");
    if (!existing && this.scripts.length >= MAX_SCRIPTS) throw new Error(`A profile keeps up to ${MAX_SCRIPTS} scripts. Delete one first.`);
    const check = await this.check(source);
    const typedName = input.name?.trim();
    const named = !!typedName || existing?.named === true;
    const title = check.ok && check.info.title !== "Script" ? check.info.title : defaultScriptName(source);
    const name = seriesLabel(typedName || (named ? existing!.name : title), 60);
    const script: PineScript = {
      id: existing?.id ?? scriptIdFor(name, new Set(this.scripts.map((entry) => entry.id))),
      name,
      ...(named ? { named } : {}),
      source,
      updatedAt: Date.now(),
      check,
    };
    this.scripts = existing
      ? this.scripts.map((entry) => (entry.id === script.id ? script : entry))
      : [...this.scripts, script];
    this.persist();
    this.register(script);
    return { ...script };
  }

  rename(id: string, name: string): PineScript {
    const script = this.get(id);
    if (!script) throw new Error("That script was deleted.");
    const next = { ...script, name: seriesLabel(name.trim() || script.name, 60), named: true };
    this.scripts = this.scripts.map((entry) => (entry.id === id ? next : entry));
    this.persist();
    this.register(next);
    return { ...next };
  }

  delete(id: string): void {
    this.scripts = this.scripts.filter((script) => script.id !== id);
    this.persist();
    this.unregister(id);
  }

  dispose(): void {
    this.disposed = true;
    for (const id of [...this.registered.keys()]) this.unregister(id);
    this.results.clear();
    this.runner.dispose();
  }

  private persist(): void {
    this.ctx.persistence.setState(STATE_KEY, this.scripts, { schemaVersion: STATE_VERSION });
  }

  private unregister(id: string): void {
    this.registered.get(id)?.dispose();
    this.registered.delete(id);
  }

  /** Lists the script in the catalog when it runs and draws a line; takes it out when it no longer does. */
  private register(script: PineScript): void {
    if (this.disposed) return;
    const check = script.check;
    const info = check?.ok ? check.info : null;
    if (!info || info.lines.length === 0) {
      this.unregister(script.id);
      return;
    }
    const key = JSON.stringify([script.name, info.overlay, info.lines]);
    if (this.registered.get(script.id)?.key === key) return;
    this.unregister(script.id);
    const multi = info.lines.length > 1;
    const definition: LoadedSeriesDefinition = {
      id: seriesIdOf(script),
      name: script.name,
      // Over the price, the lines are in the ticker's own currency and share its axis.
      unit: info.overlay ? "currency" : "points",
      // Computed on the chart's own bars, whatever their size.
      frequency: "irregular",
      group: "Pine scripts",
      description: info.overlay ? "Your script, drawn over the ticker's price." : "Your script, drawn under the ticker's price.",
      tags: ["pine", "script", "indicator"],
      input: "ticker",
      placement: info.overlay ? "price" : "panel",
      refreshMs: REFRESH_MS,
      ...(multi
        ? {
          lines: info.lines.map((line) => ({
            id: line.id,
            name: seriesLabel(line.name, 60),
            style: line.style,
            ...(line.color ? { color: line.color } : {}),
            ...(line.fill ? { fill: line.fill } : {}),
          })),
        }
        : { style: info.lines[0]!.style, ...(info.lines[0]!.color ? { color: info.lines[0]!.color } : {}) }),
      load: (request) => this.load(script.id, request),
    };
    try {
      this.registered.set(script.id, { key, dispose: this.ctx.registerSeries(definition) });
    } catch (error) {
      this.ctx.log.warn("Script not added to the catalog", { id: script.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** One run of a script for a chart, shared by its lines and kept for a minute. */
  private async load(id: string, request: SeriesLoadRequest) {
    const script = this.get(id);
    if (!script) throw new Error("This script was deleted.");
    const ticker = request.ticker?.trim();
    if (!ticker) throw new Error(`${script.name} needs a ticker.`);
    const resolution: ManualChartResolution = request.resolution ?? "1d";
    const minute = request.start ? Math.floor(request.start.getTime() / 60_000) : "all";
    request.signal?.throwIfAborted();
    const cacheKey = JSON.stringify([id, script.updatedAt, ticker, resolution, minute]);
    const now = Date.now();
    let shared = this.results.get(cacheKey);
    if (!shared || now - shared.at > RESULT_TTL_MS) {
      const controller = new AbortController();
      const output = this.run(script, ticker, resolution, request.start, controller.signal);
      const entry: SharedRun = { at: now, output, controller, waiting: 0, kept: false };
      shared = entry;
      this.results.set(cacheKey, entry);
      output.catch(() => { if (this.results.get(cacheKey) === entry) this.results.delete(cacheKey); });
      while (this.results.size > MAX_RESULTS) this.results.delete(this.results.keys().next().value!);
    }
    const entry = shared;
    if (!request.signal) entry.kept = true;
    else if (!request.signal.aborted) {
      entry.waiting += 1;
      request.signal.addEventListener("abort", () => {
        entry.waiting -= 1;
        if (!entry.kept && entry.waiting === 0) entry.controller.abort(request.signal!.reason);
      }, { once: true });
    }
    const output = await waitFor(entry.output, request.signal);
    const points = (values: Array<[number, number | null]> | undefined): SeriesPoint[] => (values ?? []).map(([time, value]) => ({ date: time, value }));
    const lines = script.check?.ok ? script.check.info.lines : [];
    if (lines.length > 1) {
      return { lines: Object.fromEntries(lines.map((line) => [line.id, points(output.values[line.id])])) };
    }
    return { points: points(output.values[lines[0]?.id ?? ""] ?? Object.values(output.values)[0]) };
  }

  /** The ticker's quote currency, when the app knows it; a script's `syminfo.currency`. */
  private currencyOf(ticker: string): Promise<string | undefined> {
    let currency = this.currencies.get(ticker);
    if (!currency) {
      const { symbol, exchange } = splitTicker(ticker);
      const marketData = this.ctx.marketData;
      currency = Promise.resolve()
        .then(() => (marketData.getQuoteMetadata
          ? marketData.getQuoteMetadata(symbol, exchange || undefined).then((metadata) => metadata?.currency)
          : marketData.getQuote(symbol, exchange || undefined).then((quote) => quote.currency)))
        .then((value) => (typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : undefined))
        .catch(() => {
          // Intentional ignore: without a quote the script reads USD, as it would elsewhere.
          this.currencies.delete(ticker);
          return undefined;
        });
      this.currencies.set(ticker, currency);
    }
    return currency;
  }

  private async run(script: PineScript, ticker: string, resolution: ManualChartResolution, start: Date | undefined, signal: AbortSignal): Promise<ScriptOutput> {
    const marketData = this.ctx.marketData;
    const [bars, currency] = await Promise.all([
      loadCandles(marketData, ticker, resolution, start ? { start } : {}),
      this.currencyOf(ticker),
    ]);
    if (bars.length === 0) throw new Error(`No ${resolution} bars for ${ticker}.`);
    signal.throwIfAborted();
    const { symbol, exchange } = splitTicker(ticker);
    const timezone = exchange ? resolveExchangeTimeZone(exchange) : null;
    const request: RunRequest = {
      source: script.source,
      symbol,
      ...(exchange ? { exchange } : {}),
      timeframe: pineTimeframe(resolution),
      bars,
      ...(currency ? { currency } : {}),
      ...(timezone ? { timezone } : {}),
    };
    try {
      return await this.runner.run(request, async (asked) => {
        const askedResolution = resolutionOfTimeframe(asked.timeframe);
        if (!askedResolution) throw new Error(`Timeframe "${asked.timeframe}" is not available.`);
        const options = asked.start !== undefined ? { start: asked.start } : {};
        // A Pine prefix Gloom does not know as a listing (`BATS:AAPL`) reads the symbol alone; the chart's own listing never does.
        const bare = asked.symbol.toUpperCase() === ticker.toUpperCase() ? asked.symbol : splitTicker(asked.symbol).symbol;
        try {
          const listed = await loadCandles(marketData, asked.symbol, askedResolution, options);
          if (listed.length > 0 || bare === asked.symbol) return listed;
        } catch (error) {
          if (bare === asked.symbol) throw error;
        }
        return loadCandles(marketData, bare, askedResolution, options);
      }, signal);
    } catch (error) {
      if (error instanceof ScriptRunError) throw new Error(`${script.name}: ${formatScriptError(error.detail)}`);
      throw error;
    }
  }
}

function op<I, O>(kind: "read" | "action", handler: (input: I) => Promise<O> | O): CapabilityOperation<I, O> {
  return { kind, rendererSafe: true, handler };
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${name} is required.`);
  return value;
}

/** What the pane calls, in this process or from the desktop view. */
export function scriptsCapability(service: PineService): PluginCapability {
  return {
    id: SCRIPTS_CAPABILITY_ID,
    kind: SCRIPTS_CAPABILITY_ID,
    name: "Pine scripts",
    operations: {
      list: op("read", () => ({ scripts: service.list() })),
      save: op("action", async (input: Partial<SaveInput>) => ({
        script: await service.save({
          source: typeof input?.source === "string" ? input.source : "",
          ...(typeof input?.id === "string" && input.id ? { id: input.id } : {}),
          ...(typeof input?.name === "string" ? { name: input.name } : {}),
        }),
      })),
      rename: op("action", (input: { id?: unknown; name?: unknown }) => ({
        script: service.rename(text(input?.id, "Script"), text(input?.name, "Name")),
      })),
      delete: op("action", (input: { id?: unknown }) => {
        service.delete(text(input?.id, "Script"));
        return { ok: true };
      }),
    },
  };
}

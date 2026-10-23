/**
 * A ticker's bars from Gloom's market data, as the script runtime takes them.
 * Runs where the app reaches its data: the terminal, and the desktop app's
 * Bun process.
 */
import type { DataProvider } from "gloomberb/types/data-provider";
import type { ManualChartResolution, TimeRange } from "gloomberb/time-series";
import type { Candle } from "./model";

const MINUTE = 60_000;
const DAY = 86_400_000;

type BarUnit = "m" | "h" | "d" | "wk" | "mo";

const UNIT_MS: Record<BarUnit, number> = { m: MINUTE, h: 60 * MINUTE, d: DAY, wk: 7 * DAY, mo: 30 * DAY };
/** The longest bar of each unit Gloom builds: a day of minutes or hours, a year of days or weeks, 12 months. */
const UNIT_MAX: Record<BarUnit, number> = { m: 1440, h: 24, d: 365, wk: 52, mo: 12 };

/** The bar sizes sources serve; Gloom builds every other one from them. */
const SOURCE_SIZES: ReadonlySet<string> = new Set<ManualChartResolution>(["1m", "5m", "15m", "30m", "45m", "1h", "1d", "1wk", "1mo"]);

/** A Gloom bar size's count and unit: `4h`, `10m`, `2d`, `1wk`, `3mo`. */
function sizeParts(size: string): { count: number; unit: BarUnit } | null {
  const match = /^([1-9]\d*)(m|h|d|wk|mo)$/.exec(size);
  return match ? { count: Number(match[1]), unit: match[2] as BarUnit } : null;
}

/** A bar size as Gloom writes it: `4h` rather than `240m`; null past the longest bar Gloom builds. */
function gloomSize(count: number, unit: BarUnit): string | null {
  if (!Number.isSafeInteger(count) || count <= 0) return null;
  if (unit === "m" && count % 60 === 0) return gloomSize(count / 60, "h");
  return count <= UNIT_MAX[unit] ? `${count}${unit}` : null;
}

/** Whether sources serve bars of this size, so no app version is needed to build them. */
export function isSourceSize(size: string): size is ManualChartResolution {
  return SOURCE_SIZES.has(size);
}

/** How long one bar of a Gloom bar size is; a month counts as 30 days. */
export function barMs(size: string): number {
  const parts = sizeParts(size);
  return parts ? parts.count * UNIT_MS[parts.unit] : DAY;
}

/** Bars shorter than a day, which exist only while a market trades. */
function isIntraday(size: string): boolean {
  const unit = sizeParts(size)?.unit;
  return unit === "m" || unit === "h";
}

/** A chart's bar size as a script's `timeframe.period` reads it: `5`, `240` for 4h, `D`, `2D`, `W`, `3M`. */
export function pineTimeframe(size: string): string {
  const parts = sizeParts(size);
  if (!parts) return "D";
  if (parts.unit === "m") return String(parts.count);
  if (parts.unit === "h") return String(parts.count * 60);
  const letter = parts.unit === "d" ? "D" : parts.unit === "wk" ? "W" : "M";
  return parts.count === 1 ? letter : `${parts.count}${letter}`;
}

/**
 * The Gloom bar size a script's `request.security()` timeframe names: `240`
 * is `4h`, `2D` is `2d`, `3M` is `3mo`. Null for seconds and ticks, and for
 * bars longer than Gloom builds.
 */
export function barSizeOfTimeframe(timeframe: string): string | null {
  const value = timeframe.trim().toUpperCase();
  const calendar = /^(\d*)([DWM])$/.exec(value);
  if (calendar) {
    const count = calendar[1] ? Number(calendar[1]) : 1;
    return gloomSize(count, calendar[2] === "D" ? "d" : calendar[2] === "W" ? "wk" : "mo");
  }
  const hours = /^(\d+)H$/.exec(value);
  if (hours) return gloomSize(Number(hours[1]) * 60, "m");
  return /^\d+$/.test(value) ? gloomSize(Number(value), "m") : null;
}

/** Bars of one size, and the source bars they are built from: the same for a size sources serve. */
export interface BarRequest {
  size: string;
  source: ManualChartResolution;
}

/** Builds bars of a size from the source's shorter ones, as the app's charts do (`aggregatePriceBars`). */
export type BarAggregator = (points: readonly PriceBar[], size: string, listing: { symbol: string; exchange: string }) => readonly PriceBar[];

/** Bars a run gets before the first one the chart shows, so averages have warmed up there. */
export const WARMUP_BARS = 300;
/**
 * Minute and hour bars exist only while a market trades, so a clock span holds
 * far fewer of them than its length suggests: six times the span of 300 bars
 * reaches back past 300 sessions' bars on a stock that trades a few hours a day.
 */
const INTRADAY_WARMUP_SPAN = 6;
/** How far back a request for every minute or hour bar asks, when the source keeps less it says so. */
const INTRADAY_HORIZON_MS = 730 * DAY;
/** A source that moves its window between two requests is asked this many times. */
const RETENTION_ATTEMPTS = 3;
/** The most bars one run takes: the newest ones. */
export const MAX_BARS = 10_000;

/** The shortest history range that reaches back to `from`. */
function rangeReaching(from: number, now: number): TimeRange {
  const span = now - from;
  const ranges: Array<[TimeRange, number]> = [
    ["1D", DAY], ["1W", 7 * DAY], ["1M", 31 * DAY], ["3M", 92 * DAY], ["6M", 183 * DAY], ["1Y", 366 * DAY], ["5Y", 5 * 366 * DAY],
  ];
  return ranges.find(([, length]) => span <= length)?.[0] ?? "ALL";
}

/**
 * The oldest time a source still answers for at a bar size, from the app's
 * retention error. The error is read by its name and fields: its class is not
 * part of the plugin API.
 */
function retainedStartOf(error: unknown): number | null {
  if (!(error instanceof Error) || error.name !== "HistoryRetentionError") return null;
  const { availableStart, observedAt } = (error as { retention?: { availableStart?: unknown; observedAt?: unknown } }).retention ?? {};
  return typeof availableStart === "number" && Number.isFinite(availableStart)
    && typeof observedAt === "number" && Number.isFinite(observedAt) && availableStart < observedAt
    ? availableStart : null;
}

/** `NESN:XSWX` as the symbol and its listing. */
export function splitTicker(ticker: string): { symbol: string; exchange: string } {
  const colon = ticker.lastIndexOf(":");
  return colon > 0 ? { symbol: ticker.slice(0, colon), exchange: ticker.slice(colon + 1) } : { symbol: ticker, exchange: "" };
}

export interface PriceBar {
  date: Date | string | number;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close: number;
  volume?: number | null;
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Price history points as candles of a bar size, oldest first, one per time, without bars that have no close. */
export function toCandles(points: readonly PriceBar[], size: string): Candle[] {
  const length = barMs(size);
  const byTime = new Map<number, Candle>();
  for (const point of points) {
    const openTime = new Date(point.date).getTime();
    if (!Number.isFinite(openTime) || !finite(point.close)) continue;
    const close = point.close;
    const open = finite(point.open) ? point.open : close;
    const high = finite(point.high) ? Math.max(point.high, open, close) : Math.max(open, close);
    const low = finite(point.low) ? Math.min(point.low, open, close) : Math.min(open, close);
    byTime.set(openTime, { openTime, closeTime: openTime + length - 1, open, high, low, close, volume: finite(point.volume) ? point.volume : 0 });
  }
  const candles = [...byTime.values()].sort((left, right) => left.openTime - right.openTime);
  // A bar closes when the next one opens, for gaps (weekends) as for regular bars.
  for (let index = 0; index < candles.length - 1; index += 1) {
    candles[index]!.closeTime = Math.min(candles[index]!.closeTime, candles[index + 1]!.openTime - 1);
  }
  return candles.slice(-MAX_BARS);
}

/**
 * The bars of one ticker at one bar size, from `WARMUP_BARS` before `start`
 * (or all of them) to now. Minute and hour bars are asked for as a window of
 * dates; when the source keeps only the last weeks or months of them, the run
 * gets the bars it keeps, with fewer warm-up bars than asked for (and, when the
 * chart itself reaches further back, the chart's own notice says where they start).
 * A size the source does not serve (4h) is asked for as the bars it is built
 * from (1h) and built with `aggregate`, the app's own way.
 */
export async function loadCandles(
  marketData: DataProvider,
  ticker: string,
  bars: ManualChartResolution | BarRequest,
  window: { start?: Date | number; warmupBars?: number },
  now = Date.now(),
  aggregate?: BarAggregator,
): Promise<Candle[]> {
  const { size, source: resolution } = typeof bars === "string" ? { size: bars, source: bars } : bars;
  if (size !== resolution && !aggregate) throw new Error(`${size} bars need a newer version of Gloom.`);
  const { symbol, exchange } = splitTicker(ticker);
  const sourceMs = barMs(resolution);
  const unit = sizeParts(size)?.unit;
  const warmup = (window.warmupBars ?? WARMUP_BARS) * barMs(size) * (unit === "d" ? 1.5 : isIntraday(size) ? INTRADAY_WARMUP_SPAN : 1);
  const start = window.start !== undefined ? new Date(window.start).getTime() : null;
  const candlesOf = (points: readonly PriceBar[]) => toCandles(size === resolution ? points : aggregate!(points, size, { symbol, exchange }), size);
  const windowed = isIntraday(resolution) && (marketData.getDetailedPriceHistoryWithMetadata || marketData.getDetailedPriceHistory);
  if (windowed) {
    // The bars from `first` to now. A source that keeps only the last weeks or months of them says
    // where its bars start, and the request is made again from the first whole bar inside.
    const fetchFrom = async (first: number): Promise<Candle[]> => {
      let from = first;
      for (let attempt = 1; ; attempt += 1) {
        try {
          const points = marketData.getDetailedPriceHistoryWithMetadata
            ? (await marketData.getDetailedPriceHistoryWithMetadata(symbol, exchange, new Date(from), new Date(now), resolution)).points
            : await marketData.getDetailedPriceHistory!(symbol, exchange, new Date(from), new Date(now), resolution);
          return candlesOf(points);
        } catch (error) {
          const kept = retainedStartOf(error);
          // One whole bar inside the source's window, which moves on while the request is on its way.
          const next = kept === null ? null : Math.ceil(kept / sourceMs) * sourceMs + sourceMs;
          if (next === null || next <= from || next >= now || attempt >= RETENTION_ATTEMPTS) throw error;
          from = next;
        }
      }
    };
    // A source can also answer nothing for a window that spans too many days for one request (minute bars:
    // about a week). Asking again with less warm-up and, last, from the chart's first bar tells that from a ticker with no bars.
    const firsts = start === null
      ? [now - INTRADAY_HORIZON_MS, now - 30 * DAY, now - 7 * DAY]
      : [1, 0.5, 0.25, 0].map((share) => start - warmup * share);
    let candles: Candle[] = [];
    for (const first of firsts) {
      candles = await fetchFrom(first);
      if (candles.length > 0) break;
    }
    return candles;
  }
  const range = start === null ? "ALL" : rangeReaching(start - warmup, now);
  let points: readonly PriceBar[];
  if (marketData.getPriceHistoryForResolutionWithMetadata) {
    points = (await marketData.getPriceHistoryForResolutionWithMetadata(symbol, exchange, range, resolution)).points;
  } else if (marketData.getPriceHistoryForResolution) {
    points = await marketData.getPriceHistoryForResolution(symbol, exchange, range, resolution);
  } else {
    points = await marketData.getPriceHistory(symbol, exchange, range);
  }
  // Bars after the window's end stay: a chart clips what it does not show.
  return candlesOf(points);
}

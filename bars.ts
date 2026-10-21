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

const BAR_MS: Record<ManualChartResolution, number> = {
  "1m": MINUTE,
  "5m": 5 * MINUTE,
  "15m": 15 * MINUTE,
  "30m": 30 * MINUTE,
  "45m": 45 * MINUTE,
  "1h": 60 * MINUTE,
  "1d": DAY,
  "1wk": 7 * DAY,
  "1mo": 30 * DAY,
};

const PINE_TIMEFRAMES: Record<ManualChartResolution, string> = {
  "1m": "1",
  "5m": "5",
  "15m": "15",
  "30m": "30",
  "45m": "45",
  "1h": "60",
  "1d": "D",
  "1wk": "W",
  "1mo": "M",
};

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

/** A chart's bar size as a script's `timeframe.period` reads it. */
export function pineTimeframe(resolution: ManualChartResolution): string {
  return PINE_TIMEFRAMES[resolution];
}

/** The bar size a script's `request.security()` timeframe names, when Gloom serves it. */
export function resolutionOfTimeframe(timeframe: string): ManualChartResolution | null {
  const value = timeframe.trim().toUpperCase();
  const daily = /^(\d*)([DWM])$/.exec(value);
  if (daily) {
    if (daily[1] && daily[1] !== "1") return null;
    return daily[2] === "D" ? "1d" : daily[2] === "W" ? "1wk" : "1mo";
  }
  const minutes = /^\d+$/.test(value) ? Number(value) : NaN;
  const match = (Object.entries(PINE_TIMEFRAMES) as Array<[ManualChartResolution, string]>)
    .find(([, pine]) => pine === String(minutes));
  return match?.[0] ?? null;
}

/** The shortest history range that reaches back to `from`. */
function rangeReaching(from: number, now: number): TimeRange {
  const span = now - from;
  const ranges: Array<[TimeRange, number]> = [
    ["1D", DAY], ["1W", 7 * DAY], ["1M", 31 * DAY], ["3M", 92 * DAY], ["6M", 183 * DAY], ["1Y", 366 * DAY], ["5Y", 5 * 366 * DAY],
  ];
  return ranges.find(([, length]) => span <= length)?.[0] ?? "ALL";
}

const INTRADAY: ReadonlySet<ManualChartResolution> = new Set(["1m", "5m", "15m", "30m", "45m", "1h"]);

/** Whether bars of this size are minute or hour bars, which sources keep for a limited time only. */
function isIntraday(resolution: ManualChartResolution): boolean {
  return INTRADAY.has(resolution);
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

interface PriceBar {
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

/** Price history points as candles, oldest first, one per time, without bars that have no close. */
export function toCandles(points: readonly PriceBar[], resolution: ManualChartResolution): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const point of points) {
    const openTime = new Date(point.date).getTime();
    if (!Number.isFinite(openTime) || !finite(point.close)) continue;
    const close = point.close;
    const open = finite(point.open) ? point.open : close;
    const high = finite(point.high) ? Math.max(point.high, open, close) : Math.max(open, close);
    const low = finite(point.low) ? Math.min(point.low, open, close) : Math.min(open, close);
    byTime.set(openTime, { openTime, closeTime: openTime + BAR_MS[resolution] - 1, open, high, low, close, volume: finite(point.volume) ? point.volume : 0 });
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
 */
export async function loadCandles(
  marketData: DataProvider,
  ticker: string,
  resolution: ManualChartResolution,
  window: { start?: Date | number; warmupBars?: number },
  now = Date.now(),
): Promise<Candle[]> {
  const { symbol, exchange } = splitTicker(ticker);
  const barMs = BAR_MS[resolution];
  const warmup = (window.warmupBars ?? WARMUP_BARS) * barMs * (resolution === "1d" ? 1.5 : isIntraday(resolution) ? INTRADAY_WARMUP_SPAN : 1);
  const start = window.start !== undefined ? new Date(window.start).getTime() : null;
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
          return toCandles(points, resolution);
        } catch (error) {
          const kept = retainedStartOf(error);
          // One whole bar inside the source's window, which moves on while the request is on its way.
          const next = kept === null ? null : Math.ceil(kept / barMs) * barMs + barMs;
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
  return toCandles(points, resolution);
}

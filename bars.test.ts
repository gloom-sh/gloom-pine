import { describe, expect, test } from "bun:test";
import type { DataProvider } from "gloomberb/types/data-provider";
import { loadCandles } from "./bars";

const MINUTE = 60_000;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 20, 18, 0, 0);

/** The app's retention error, as the source raises it: by name, with the window it keeps. */
function retentionError(keptDays: number) {
  return Object.assign(new Error("Requested history precedes the source retention window"), {
    name: "HistoryRetentionError",
    retention: { availableStart: NOW - keptDays * DAY, observedAt: NOW },
  });
}

/** A source with bars (five-minute ones unless `stepMinutes` says) for `keptDays` days; older starts raise the retention error, windows over `maxSpanDays` answer nothing. */
function source(options: { keptDays: number; maxSpanDays?: number; stepMinutes?: number }) {
  const calls: Array<{ from: number; to: number; size: string }> = [];
  const marketData = {
    async getDetailedPriceHistoryWithMetadata(_symbol: string, _exchange: string, from: Date, to: Date, size: string) {
      calls.push({ from: from.getTime(), to: to.getTime(), size });
      if (from.getTime() < NOW - options.keptDays * DAY) throw retentionError(options.keptDays);
      if (options.maxSpanDays && to.getTime() - from.getTime() > options.maxSpanDays * DAY) return { points: [], resolution: "5m" };
      const points = [];
      for (let time = Math.max(from.getTime(), NOW - options.keptDays * DAY); time < to.getTime(); time += (options.stepMinutes ?? 5) * MINUTE) {
        points.push({ date: new Date(time), open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });
      }
      return { points, resolution: "5m" };
    },
  };
  return { marketData: marketData as unknown as DataProvider, calls };
}

describe("loadCandles", () => {
  test("minute bars from before what the source keeps are loaded from where it keeps them", async () => {
    const { marketData, calls } = source({ keptDays: 60 });
    const candles = await loadCandles(marketData, "ES=F", "5m", { start: new Date(NOW - 90 * DAY) }, NOW);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.from).toBeGreaterThan(NOW - 60 * DAY);
    expect(calls[1]!.from).toBeLessThan(NOW - 60 * DAY + 10 * MINUTE);
    expect(candles.length).toBeGreaterThan(1000);
  });

  test("warm-up bars cut short by what the source keeps still leave the chart's bars whole", async () => {
    const { marketData, calls } = source({ keptDays: 60, stepMinutes: 60 });
    // The chart starts inside the retained bars; 300 hourly bars of warm-up reach back past them.
    const start = NOW - 30 * DAY;
    const candles = await loadCandles(marketData, "ES=F", "1h", { start: new Date(start) }, NOW);
    expect(calls).toHaveLength(2);
    expect(candles.some((candle) => candle.openTime < start)).toBe(true);
    expect(candles.filter((candle) => candle.openTime >= start)).toHaveLength(30 * 24);
  });

  test("a window too long for one request is asked again with less warm-up", async () => {
    const { marketData, calls } = source({ keptDays: 30, maxSpanDays: 8 });
    const start = NOW - 7 * DAY;
    const candles = await loadCandles(marketData, "ES=F", "1m", { start: new Date(start) }, NOW);
    // 300 bars of warm-up reach back 30 hours at one minute; half of that fits.
    expect(calls.map((call) => Math.round((start - call.from) / MINUTE))).toEqual([1800, 900]);
    expect(candles.length).toBeGreaterThan(0);
  });

  test("an error that is not about retention is not retried", async () => {
    const marketData = { async getDetailedPriceHistoryWithMetadata() { throw new Error("rate limited"); } } as unknown as DataProvider;
    await expect(loadCandles(marketData, "ES=F", "5m", { start: new Date(NOW - DAY) }, NOW)).rejects.toThrow("rate limited");
  });
});

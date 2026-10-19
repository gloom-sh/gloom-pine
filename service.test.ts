import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { validateSeriesDefinition, type LoadedSeriesDefinition, type SeriesLinesLoadResult } from "gloomberb/time-series";
import { PineService, checkBars } from "./service";

const example = (name: string) => readFileSync(new URL(`./examples/${name}.pine`, import.meta.url), "utf8");

function fakeContext() {
  const state = new Map<string, unknown>();
  const series = new Map<string, LoadedSeriesDefinition>();
  const historyCalls: Array<{ ticker: string; range: string; resolution: string }> = [];
  const bars = checkBars(600, 3);
  const ctx = {
    persistence: {
      getState: (key: string) => state.get(key) ?? null,
      setState: (key: string, value: unknown) => { state.set(key, structuredClone(value)); },
    },
    registerSeries(definition: LoadedSeriesDefinition) {
      validateSeriesDefinition(definition);
      if (series.has(definition.id)) throw new Error(`taken: ${definition.id}`);
      series.set(definition.id, definition);
      return () => { series.delete(definition.id); };
    },
    marketData: {
      async getPriceHistory() { return []; },
      async getPriceHistoryForResolutionWithMetadata(ticker: string, _exchange: string, range: string, resolution: string) {
        historyCalls.push({ ticker, range, resolution });
        return { points: bars.map((bar) => ({ date: new Date(bar.openTime), open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume })) };
      },
    },
    log: { warn() {}, info() {}, error() {}, debug() {} },
  };
  return { ctx: ctx as never, state, series, historyCalls };
}

let services: PineService[] = [];
afterEach(() => {
  for (const service of services) service.dispose();
  services = [];
});

function serviceFor(ctx: never) {
  const service = new PineService(ctx);
  services.push(service);
  return service;
}

describe("PineService", () => {
  test("lists a saved script in the catalog where it draws, and charts each of its lines from one run", async () => {
    const { ctx, series, historyCalls } = fakeContext();
    const service = serviceFor(ctx);

    const rsi = await service.save({ source: example("rsi-bands") });
    expect(rsi.name).toBe("RSI with bands");
    expect(rsi.check?.ok).toBe(true);
    const definition = series.get(`pine:${rsi.id}`)!;
    expect(definition.placement).toBe("panel");
    expect(definition.lines?.map((line) => line.name)).toEqual(["RSI", "Overbought", "Oversold"]);

    const result = await definition.load({ ticker: "AAPL", resolution: "1d", start: new Date(Date.now() - 365 * 86_400_000) }) as SeriesLinesLoadResult;
    const values = result.lines!.rsi!.map((point) => point.value).filter((value): value is number => value !== null);
    expect(values.length).toBeGreaterThan(500);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThanOrEqual(100);
    expect(result.lines!.overbought!.at(-1)!.value).toBe(70);
    // A second line of the same chart reuses the run.
    await definition.load({ ticker: "AAPL", resolution: "1d", start: new Date(Date.now() - 365 * 86_400_000) });
    expect(historyCalls).toEqual([{ ticker: "AAPL", range: "5Y", resolution: "1d" }]);

    const cross = await service.save({ source: example("ma-cross") });
    const overlay = series.get(`pine:${cross.id}`)!;
    expect(overlay.placement).toBe("price");
    expect(overlay.unit).toBe("currency");
    expect(cross.check?.ok && cross.check.info.notDrawn).toEqual(["plotshape"]);
  });

  test("keeps a script that does not run, says where it fails, and lists it once it is fixed", async () => {
    const { ctx, series } = fakeContext();
    const service = serviceFor(ctx);

    const broken = await service.save({ source: "//@version=6\nindicator(\"Broken\")\nx = close\nplot(ta.foobar(x, 3))\n" });
    expect(broken.check).toMatchObject({ ok: false, error: { message: "ta.foobar() is not supported.", line: 4 } });
    expect(series.size).toBe(0);

    // The compiler stops at the end of the script; the error points at the bracket left open.
    const syntax = await service.save({ id: broken.id, source: "//@version=6\nindicator(\"Broken\")\nplot(close // (\n" });
    expect(syntax.check).toMatchObject({ ok: false, error: { message: "This \"(\" is never closed.", line: 3, column: 5 } });

    await service.save({ id: broken.id, source: example("z-score") });
    expect([...series.keys()]).toEqual([`pine:${broken.id}`]);
  });

  test("brings saved scripts back after a restart", async () => {
    const { ctx, series } = fakeContext();
    const first = serviceFor(ctx);
    const script = await first.save({ source: example("bollinger") });
    first.dispose();
    expect(series.size).toBe(0);

    const second = serviceFor(ctx);
    expect(second.list().map((entry) => entry.id)).toEqual([script.id]);
    expect(series.get(`pine:${script.id}`)?.lines?.map((line) => line.id)).toEqual(["basis", "upper", "lower"]);
  });

  test("a renamed script keeps its name when its title changes", async () => {
    const { ctx } = fakeContext();
    const service = serviceFor(ctx);
    const script = await service.save({ source: example("z-score") });
    service.rename(script.id, "My z");
    const saved = await service.save({ id: script.id, source: example("z-score").replace("\"Z-score\"", "\"Other\"") });
    expect(saved.name).toBe("My z");
  });
});

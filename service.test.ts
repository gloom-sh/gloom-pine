import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { validateSeriesDefinition, type LoadedSeriesDefinition, type SeriesLinesLoadResult } from "gloomberb/time-series";
import { ScriptRunner } from "./runner";
import { PineService, checkBars } from "./service";

const example = (name: string) => readFileSync(new URL(`./examples/${name}.pine`, import.meta.url), "utf8");

function fakeContext(currency = "USD") {
  const state = new Map<string, unknown>();
  const series = new Map<string, LoadedSeriesDefinition>();
  const historyCalls: Array<{ ticker: string; exchange: string; range: string; resolution: string }> = [];
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
      async getQuoteMetadata(symbol: string) { return { symbol, currency, source: {} }; },
      async getPriceHistoryForResolutionWithMetadata(ticker: string, exchange: string, range: string, resolution: string) {
        historyCalls.push({ ticker, exchange, range, resolution });
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
    expect(historyCalls).toEqual([{ ticker: "AAPL", exchange: "", range: "5Y", resolution: "1d" }]);

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
    // Each line in the script's colour; the band between the outer two takes the edge nearer the fill's blue.
    expect(series.get(`pine:${script.id}`)?.lines?.map(({ id, color, fill }) => ({ id, color, fill }))).toEqual([
      { id: "basis", color: "#2962ff", fill: undefined },
      { id: "upper", color: "#f23645", fill: undefined },
      { id: "lower", color: "#089981", fill: "upper" },
    ]);
  });

  test("a script reads the listing it runs on: its currency, its time zone, and the same listing from request.security", async () => {
    const { ctx, series, historyCalls } = fakeContext("CHF");
    const service = serviceFor(ctx);
    const script = await service.save({ source: `//@version=6
indicator("Listing")
plot(syminfo.currency == "CHF" ? 1 : 0, "Currency")
plot(syminfo.timezone == "Europe/Zurich" ? 1 : 0, "Zone")
plot(syminfo.tickerid == "XSWX:NESN" ? 1 : 0, "Id")
plot(request.security(syminfo.tickerid, "W", close), "Weekly")` });
    historyCalls.length = 0;
    const result = await series.get(`pine:${script.id}`)!.load({ ticker: "NESN:XSWX", resolution: "1d" }) as SeriesLinesLoadResult;
    const last = (id: string) => result.lines![id]!.at(-1)!.value;
    expect([last("currency"), last("zone"), last("id")]).toEqual([1, 1, 1]);
    expect(historyCalls.map(({ ticker, exchange, resolution }) => `${ticker}:${exchange} ${resolution}`)).toEqual(["NESN:XSWX 1d", "NESN:XSWX 1wk"]);
  });

  test("a run two charts share stops when both have closed, not when one has", async () => {
    const real = new ScriptRunner();
    const runs: AbortSignal[] = [];
    const runner = {
      run: (request: { symbol: string }, loadBars: never, signal?: AbortSignal) => request.symbol === "CHECK"
        ? real.run(request as never, loadBars)
        : new Promise((_, reject) => {
          runs.push(signal!);
          signal!.addEventListener("abort", () => reject(signal!.reason));
        }),
      dispose: () => real.dispose(),
    };
    const { ctx, series } = fakeContext();
    const service = new PineService(ctx, runner as never);
    services.push(service);
    const script = await service.save({ source: example("rsi-bands") });
    const definition = series.get(`pine:${script.id}`)!;
    const first = new AbortController();
    const second = new AbortController();
    const one = Promise.resolve(definition.load({ ticker: "AAPL", resolution: "1d", signal: first.signal })).catch((error: unknown) => error);
    const two = Promise.resolve(definition.load({ ticker: "AAPL", resolution: "1d", signal: second.signal })).catch((error: unknown) => error);
    while (runs.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    first.abort("closed");
    expect(await one).toBe("closed");
    expect(runs.map((signal) => signal.aborted)).toEqual([false]);
    second.abort("closed");
    expect(await two).toBe("closed");
    expect(runs.map((signal) => signal.aborted)).toEqual([true]);
    // The next chart starts over rather than reading the stopped run.
    void Promise.resolve(definition.load({ ticker: "AAPL", resolution: "1d" })).catch(() => {});
    while (runs.length === 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(runs).toHaveLength(2);
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

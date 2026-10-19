import { afterAll, expect, test } from "bun:test";
import type { Candle } from "./model";
import { ScriptRunError, ScriptRunner } from "./runner";

const DAY = 86_400_000;

function bars(count: number): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + 10 * Math.sin(index / 9) + index * 0.03;
    const openTime = Date.UTC(2024, 0, 1) + index * DAY;
    return { openTime, closeTime: openTime + DAY - 1, open: close - 0.4, high: close + 1, low: close - 1, close, volume: 1_000 + index };
  });
}

const runner = new ScriptRunner({ timeoutMs: 1_500 });
afterAll(() => runner.dispose());

const noBars = async () => [];

test("a script that never ends is stopped and the next run still works", async () => {
  const hang = `//@version=6
indicator("Hang")
float s = 0
for i = 0 to 400000
    for j = 0 to 400000
        s += 1
plot(s)`;
  const started = Date.now();
  const error = await runner.run({ source: hang, symbol: "TEST", timeframe: "D", bars: bars(50) }, noBars).catch((caught) => caught);
  expect(error).toBeInstanceOf(ScriptRunError);
  expect((error as ScriptRunError).message).toContain("was stopped");
  expect(Date.now() - started).toBeLessThan(5_000);

  const output = await runner.run({
    source: `//@version=6\nindicator("SMA", overlay=true)\nplot(ta.sma(close, 3), "SMA 3")`,
    symbol: "TEST", timeframe: "D", bars: bars(10),
  }, noBars);
  const values = output.values["sma-3"]!;
  const closes = bars(10).map((bar) => bar.close);
  expect(values[9]![1]).toBeCloseTo((closes[7]! + closes[8]! + closes[9]!) / 3, 9);
  expect(output.info.overlay).toBe(true);
});

test("time spent waiting for another symbol's bars does not count against the script", async () => {
  const slowBars = async () => {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    return bars(30);
  };
  const output = await runner.run({
    source: `//@version=5\nindicator("Pair")\nplot(close / request.security("OTHER", "D", close), "Ratio")`,
    symbol: "TEST", timeframe: "D", bars: bars(30),
  }, slowBars);
  expect(output.values.ratio!.at(-1)![1]).toBeCloseTo(1, 9);
});

test("a script without a version line is refused, not run as JavaScript", async () => {
  // The runtime reads a source with no version line as JavaScript.
  const error = await runner.run({ source: `indicator("JS")\nplot(close)`, symbol: "TEST", timeframe: "D", bars: bars(10) }, noBars)
    .catch((caught) => caught);
  expect(error).toBeInstanceOf(ScriptRunError);
  expect((error as ScriptRunError).message).toContain("//@version=6");
});

import { afterAll, expect, test } from "bun:test";
import { runScript } from "./engine";
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

const SMA = `//@version=6\nindicator("SMA", overlay=true)\nplot(ta.sma(close, 3), "SMA 3")`;
const HANG = `//@version=6
indicator("Hang")
float s = 0
for i = 0 to 400000
    for j = 0 to 400000
        s += 1
plot(s)`;

test("a script cannot reach the JavaScript it is turned into", async () => {
  const head = `//@version=5\nindicator("Probe")\n`;
  const refused: Array<[string, RegExp]> = [
    ["x = close.constructor", /reserved property "constructor"/],
    [`s = "a"\nf = s.constructor`, /reserved property "constructor"/],
    ["type T\n    float constructor = 1", /reserved property "constructor"/],
    ["a = array.new_float(1)\nc = a.context", /reserved property "context"/],
    ["x = globalThis", /"globalThis" is not defined/],
    ["x = Bun", /"Bun" is not defined/],
    ["x = process", /"process" is not defined/],
    ["x = this", /"this" is not available/],
    ["(() => { globalThis.ESCAPED = 1 })()", /./],
    [`a = array.from(1)\nc = a["constructor"]\nF = c["constructor"]\ng = F("globalThis.ESCAPED = 1")\ng()`, /./],
  ];
  for (const [body, message] of refused) {
    const error = await runScript({ source: `${head}${body}\nplot(close)`, symbol: "TEST", timeframe: "D", bars: bars(20) }, noBars)
      .then(() => null, (caught) => caught);
    expect({ body, message: error?.message ?? "ran" }).toEqual({ body, message: expect.stringMatching(message) });
  }
  // Text that looks like code stays text.
  for (const body of [
    `s = "\\"); globalThis.ESCAPED = 1; (\\""`,
    "s = '`; globalThis.ESCAPED = 1; `'",
    `n = input.int(14, title="x\\"); globalThis.ESCAPED = 1; //")`,
  ]) {
    await runScript({ source: `${head}${body}\nplot(close)`, symbol: "TEST", timeframe: "D", bars: bars(20) }, noBars);
  }
  expect((globalThis as { ESCAPED?: unknown }).ESCAPED).toBeUndefined();
});

test("a script worker has no files, processes, network or environment once it has loaded", async () => {
  // The real worker module, answering a run with what is still in its reach.
  const probe = `import ${JSON.stringify(new URL("./worker.ts", import.meta.url).pathname)};
const bun = globalThis.Bun;
const reach = {
  globals: ["fetch", "WebSocket", "EventSource", "Worker", "require", "process", "eval"].filter((name) => globalThis[name] !== undefined),
  bun: ["spawn", "spawnSync", "$", "file", "write", "mmap", "connect", "listen", "serve", "udpSocket", "FFI", "sql", "s3", "redis"].filter((name) => bun[name] !== undefined),
  frozen: Object.isFrozen(bun),
  compilers: [function () {}, async function () {}, function* () {}, async function* () {}].filter((fn) => fn.constructor !== undefined).length,
  env: Object.keys(bun.env).length,
};
self.onmessage = (event) => self.postMessage({ type: "failed", runId: event.data.runId, error: { message: JSON.stringify(reach) } });`;
  const url = new URL(URL.createObjectURL(new Blob([probe], { type: "application/typescript" })));
  const probing = new ScriptRunner({ workerUrl: url });
  const error = await probing.run({ source: SMA, symbol: "TEST", timeframe: "D", bars: bars(5) }, noBars).catch((caught) => caught);
  probing.dispose();
  expect(JSON.parse((error as ScriptRunError).message)).toEqual({ globals: [], bun: [], frozen: true, compilers: 0, env: 0 });
});

test("a script that keeps growing is stopped, and the next run still works", async () => {
  const small = new ScriptRunner({ timeoutMs: 30_000, maxMemoryMb: 128 });
  const grow = `//@version=6
indicator("Grow")
var a = array.new_float(0)
for i = 0 to 50000
    array.push(a, i)
plot(array.size(a))`;
  const error = await small.run({ source: grow, symbol: "TEST", timeframe: "D", bars: bars(400) }, noBars).catch((caught) => caught);
  expect((error as ScriptRunError).message).toBe("The script used more than 128 MB of memory and was stopped.");
  const output = await small.run({ source: SMA, symbol: "TEST", timeframe: "D", bars: bars(10) }, noBars);
  expect(output.values["sma-3"]).toHaveLength(10);
  small.dispose();
});

test("runs take turns, and a chart closed while its run waits or runs stops it", async () => {
  const turns = new ScriptRunner({ timeoutMs: 20_000 });
  const running = new AbortController();
  const waiting = new AbortController();
  const started = Date.now();
  const hang = turns.run({ source: HANG, symbol: "TEST", timeframe: "D", bars: bars(50) }, noBars, running.signal).catch((caught) => caught);
  const queued = turns.run({ source: SMA, symbol: "TEST", timeframe: "D", bars: bars(10) }, noBars, waiting.signal).catch((caught) => caught);
  const after = turns.run({ source: SMA, symbol: "TEST", timeframe: "D", bars: bars(10) }, noBars);
  waiting.abort("closed while waiting");
  expect(await queued).toBe("closed while waiting");
  await new Promise((resolve) => setTimeout(resolve, 300));
  running.abort("closed");
  expect(await hang).toBe("closed");
  expect(Date.now() - started).toBeLessThan(5_000);
  expect((await after).values["sma-3"]).toHaveLength(10);
  turns.dispose();
});

test("lines past what the app takes for one script are named, and the ones that drew come first", async () => {
  const plots = Array.from({ length: 12 }, (_, index) => `plot(${index === 0 ? "na" : `close + ${index}`}, "Line ${index + 1}")`).join("\n");
  const source = `//@version=6\nindicator("Many", overlay=true)\n${plots}`;
  const limited = await runner.run({ source, symbol: "TEST", timeframe: "D", bars: bars(30), maxLines: 5 }, noBars);
  // The first plot has no values on these bars, so it is the first to go.
  expect(limited.info.lines.map((line) => line.name)).toEqual(["Line 2", "Line 3", "Line 4", "Line 5", "Line 6"]);
  expect(limited.info.notDrawn).toEqual(["7 more plots (a chart shows 5)"]);
  const all = await runner.run({ source, symbol: "TEST", timeframe: "D", bars: bars(30) }, noBars);
  expect(all.info.lines).toHaveLength(12);
});

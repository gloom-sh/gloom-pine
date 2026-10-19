/**
 * The chart a script opens on: the ticker's candles with the script's lines
 * over them (`overlay=true`) or in a panel of their own under them: the
 * chart the data catalog opens for the script, built here from what the
 * pane already has, in the terminal and in the desktop view alike.
 */
import { CHART_SPEC_VERSION, type ChartSeriesSpec, type ChartSpec } from "gloomberb/time-series";
import { SERIES_NAMESPACE, type PineScript, type ScriptInfo } from "./model";

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** `AAPL`, `NESN:SWX` as the chart names the instrument. */
function instrumentOf(ticker: string): { symbol: string; exchange?: string } {
  const colon = ticker.lastIndexOf(":");
  return colon > 0 ? { symbol: ticker.slice(0, colon), exchange: ticker.slice(colon + 1) } : { symbol: ticker };
}

export function scriptChartSpec(script: Pick<PineScript, "id" | "name">, info: Pick<ScriptInfo, "overlay" | "lines">, rawTicker: string): ChartSpec {
  const ticker = rawTicker.trim().toUpperCase();
  const instrument = instrumentOf(ticker);
  const priceId = `${slug(instrument.symbol)}-market-ohlcv-1`;
  const panelId = info.overlay ? "main" : "panel-2";
  const encoded = encodeURIComponent(ticker);
  const lines: ChartSeriesSpec[] = info.lines.map((line, index) => ({
    id: `${SERIES_NAMESPACE}-${script.id}-${line.id}-${slug(ticker)}-${index + 2}`,
    source: {
      kind: "capability",
      capabilityId: SERIES_NAMESPACE,
      seriesId: info.lines.length > 1 ? `${script.id}~${line.id}/${encoded}` : `${script.id}/${encoded}`,
    },
    label: info.lines.length > 1 ? `${ticker} · ${script.name} · ${line.name}` : `${ticker} · ${script.name}`,
    transform: "raw",
    axis: "auto",
    panelId,
    // A line filled to another draws as a band, as the data catalog draws it.
    style: line.fill ? "band" : line.style,
    interpolation: line.style === "step" && !line.fill ? "step-after" : "none",
  }));
  return {
    version: CHART_SPEC_VERSION,
    // CAT's range for the same chart, so the pane and CAT open the same thing.
    viewport: { range: "5Y", resolution: "auto" },
    panels: [
      { id: "main" },
      { id: "volume", label: "Volume", height: 0.24 },
      ...(info.overlay ? [] : [{ id: panelId, label: script.name, height: 0.3 }]),
    ],
    series: [
      {
        id: priceId,
        source: { kind: "security", instrument, fieldId: "market.ohlcv", period: "auto" },
        transform: "raw",
        axis: "auto",
        panelId: "main",
        style: "candles",
        interpolation: "none",
      },
      ...lines,
    ],
    studies: [{
      id: `builtin:volume:${priceId}`,
      kind: "volume",
      inputSeriesIds: [priceId],
      parameters: {},
      panelId: "volume",
      axis: "auto",
    }],
  } as ChartSpec;
}

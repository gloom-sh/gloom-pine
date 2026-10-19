import type { Candle, ScriptError, ScriptOutput } from "./model";
import type { RunRequest } from "./engine";

/** Messages between the app's thread (runner.ts) and a script worker (worker.ts). */
export type ToWorker =
  | { type: "run"; runId: number; request: RunRequest }
  | { type: "bars"; requestId: number; bars?: Candle[]; error?: string };

export type FromWorker =
  | { type: "bars"; runId: number; requestId: number; symbol: string; timeframe: string; start?: number; end?: number; limit?: number }
  | { type: "done"; runId: number; output: ScriptOutput }
  | { type: "failed"; runId: number; error: ScriptError };

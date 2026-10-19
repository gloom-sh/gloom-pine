/**
 * Runs scripts in workers with a time limit. A run that goes over its limit
 * has its worker terminated, which stops any loop, however it was written;
 * the app's own thread only ever waits on a message.
 */
import type { Candle, ScriptError, ScriptOutput } from "./model";
import type { RunRequest } from "./engine";
import type { FromWorker, ToWorker } from "./protocol";

/** Bars for a `request.security()` call on another symbol or timeframe. */
export type RunnerBarsLoader = (request: { symbol: string; timeframe: string; start?: number; end?: number; limit?: number }) => Promise<Candle[]>;

export class ScriptRunError extends Error {
  constructor(readonly detail: ScriptError) {
    super(detail.message);
  }
}

export interface RunnerOptions {
  /** Script time a run may use, not counting waits for bars. */
  timeoutMs?: number;
  /** Wall time a run may take in all, waits included. */
  maxWallMs?: number;
  /** Where the worker module is; defaults to worker.ts next to this file. */
  workerUrl?: URL;
  createWorker?: (url: URL) => Worker;
}

export const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_WALL_MS = 60_000;

let nextRunId = 1;

export class ScriptRunner {
  private idle: Worker | null = null;
  private readonly live = new Set<Worker>();
  private readonly timeoutMs: number;
  private readonly maxWallMs: number;
  private readonly workerUrl: URL;
  private readonly createWorker: (url: URL) => Worker;
  private disposed = false;

  constructor(options: RunnerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxWallMs = options.maxWallMs ?? DEFAULT_MAX_WALL_MS;
    this.workerUrl = options.workerUrl ?? new URL("./worker.ts", import.meta.url);
    this.createWorker = options.createWorker ?? ((url) => new Worker(url.href));
  }

  private take(): Worker {
    const worker = this.idle ?? this.createWorker(this.workerUrl);
    this.idle = null;
    this.live.add(worker);
    return worker;
  }

  private release(worker: Worker, healthy: boolean): void {
    this.live.delete(worker);
    if (healthy && !this.disposed && !this.idle) {
      this.idle = worker;
      return;
    }
    worker.terminate();
  }

  run(request: RunRequest, loadBars: RunnerBarsLoader, signal?: AbortSignal): Promise<ScriptOutput> {
    if (this.disposed) return Promise.reject(new ScriptRunError({ message: "Scripts are switched off." }));
    const worker = this.take();
    const runId = nextRunId++;
    const seconds = Math.round(this.timeoutMs / 1000);
    return new Promise<ScriptOutput>((resolve, reject) => {
      let settled = false;
      let budgetTimer: ReturnType<typeof setTimeout> | null = null;
      let budgetLeft = this.timeoutMs;
      let budgetStarted = 0;
      let waits = 0;
      const wallTimer = setTimeout(() => finish(false, () => reject(new ScriptRunError({
        message: `The script waited on data for over ${Math.round(this.maxWallMs / 1000)} seconds and was stopped.`,
      }))), this.maxWallMs);

      const startBudget = () => {
        budgetStarted = Date.now();
        budgetTimer = setTimeout(() => finish(false, () => reject(new ScriptRunError({
          message: `The script ran for over ${seconds} seconds on ${request.bars.length.toLocaleString("en-US")} bars and was stopped.`,
        }))), Math.max(0, budgetLeft));
      };
      const pauseBudget = () => {
        if (!budgetTimer) return;
        clearTimeout(budgetTimer);
        budgetTimer = null;
        budgetLeft -= Date.now() - budgetStarted;
      };
      const onAbort = () => finish(false, () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError")));
      const finish = (healthy: boolean, settle: () => void) => {
        if (settled) return;
        settled = true;
        pauseBudget();
        clearTimeout(wallTimer);
        signal?.removeEventListener("abort", onAbort);
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        this.release(worker, healthy);
        settle();
      };
      const onError = (event: ErrorEvent) => {
        finish(false, () => reject(new ScriptRunError({ message: event.message || "The script stopped unexpectedly." })));
      };
      const onMessage = (event: MessageEvent<FromWorker>) => {
        const message = event.data;
        if (message.runId !== runId) return;
        if (message.type === "done") finish(true, () => resolve(message.output));
        else if (message.type === "failed") finish(true, () => reject(new ScriptRunError(message.error)));
        else if (message.type === "bars") {
          waits += 1;
          pauseBudget();
          loadBars(message).then(
            (bars) => worker.postMessage({ type: "bars", requestId: message.requestId, bars } satisfies ToWorker),
            (error) => worker.postMessage({ type: "bars", requestId: message.requestId, error: error instanceof Error ? error.message : String(error) } satisfies ToWorker),
          ).finally(() => {
            waits -= 1;
            if (!settled && waits === 0) startBudget();
          });
        }
      };
      if (signal?.aborted) {
        finish(true, () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")));
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      startBudget();
      worker.postMessage({ type: "run", runId, request } satisfies ToWorker);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.idle?.terminate();
    this.idle = null;
    for (const worker of this.live) worker.terminate();
    this.live.clear();
  }
}

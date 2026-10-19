/**
 * Runs scripts in workers, one at a time, with a time and a memory limit. A
 * run that goes over either has its worker terminated, which stops any loop
 * and frees what it held, however it was written; the app's own thread only
 * ever waits on a message. Runs past the first wait their turn.
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
  /** Memory a run may add to the process, in MB, before it is stopped. */
  maxMemoryMb?: number;
  /** Where the worker module is; defaults to worker.ts next to this file. */
  workerUrl?: URL;
  createWorker?: (url: URL) => Worker;
}

export const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_WALL_MS = 60_000;
/** Well over what a script on a few thousand bars takes, well under what would hurt the app. */
const DEFAULT_MAX_MEMORY_MB = 1_024;
/** How often a run's memory is read. */
const MEMORY_EVERY_MS = 100;

let nextRunId = 1;

/** A timer that does not keep the process alive by itself: a command line run exits when its work is done. */
function unrefd<T extends ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>(timer: T): T {
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

function aborted(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException("Aborted", "AbortError");
}

export class ScriptRunner {
  private idle: Worker | null = null;
  private readonly live = new Set<Worker>();
  /** Runs waiting for the one before them to end. */
  private readonly queue: Array<() => void> = [];
  private busy = false;
  private readonly timeoutMs: number;
  private readonly maxWallMs: number;
  private readonly maxMemoryBytes: number;
  private readonly workerUrl: URL;
  private readonly createWorker: (url: URL) => Worker;
  private disposed = false;

  constructor(options: RunnerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxWallMs = options.maxWallMs ?? DEFAULT_MAX_WALL_MS;
    this.maxMemoryBytes = (options.maxMemoryMb ?? DEFAULT_MAX_MEMORY_MB) * 1_048_576;
    this.workerUrl = options.workerUrl ?? new URL("./worker.ts", import.meta.url);
    // An empty environment: nothing the app was started with (keys, tokens) is in reach of a script.
    this.createWorker = options.createWorker ?? ((url) => new Worker(url.href, { env: {} }));
  }

  private take(): Worker {
    const worker = this.idle ?? this.createWorker(this.workerUrl);
    this.idle = null;
    (worker as { ref?: () => void }).ref?.();
    this.live.add(worker);
    return worker;
  }

  private release(worker: Worker, healthy: boolean): void {
    this.live.delete(worker);
    if (healthy && !this.disposed && !this.idle) {
      // Kept for the next run, without keeping the process alive.
      (worker as { unref?: () => void }).unref?.();
      this.idle = worker;
      return;
    }
    worker.terminate();
  }

  /** Waits for the run before to end; a run whose chart closes while it waits leaves the line. */
  private turn(signal: AbortSignal | undefined): Promise<void> {
    if (!this.busy) {
      this.busy = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const start = () => {
        signal?.removeEventListener("abort", leave);
        resolve();
      };
      const leave = () => {
        const index = this.queue.indexOf(start);
        if (index >= 0) this.queue.splice(index, 1);
        reject(aborted(signal));
      };
      this.queue.push(start);
      signal?.addEventListener("abort", leave, { once: true });
    });
  }

  private next(): void {
    const start = this.queue.shift();
    if (start) start();
    else this.busy = false;
  }

  async run(request: RunRequest, loadBars: RunnerBarsLoader, signal?: AbortSignal): Promise<ScriptOutput> {
    if (this.disposed) throw new ScriptRunError({ message: "Scripts are switched off." });
    if (signal?.aborted) throw aborted(signal);
    await this.turn(signal);
    try {
      if (this.disposed) throw new ScriptRunError({ message: "Scripts are switched off." });
      return await this.runNow(request, loadBars, signal);
    } finally {
      this.next();
    }
  }

  private runNow(request: RunRequest, loadBars: RunnerBarsLoader, signal?: AbortSignal): Promise<ScriptOutput> {
    const worker = this.take();
    const runId = nextRunId++;
    const seconds = Math.round(this.timeoutMs / 1000);
    return new Promise<ScriptOutput>((resolve, reject) => {
      let settled = false;
      let budgetTimer: ReturnType<typeof setTimeout> | null = null;
      let budgetLeft = this.timeoutMs;
      let budgetStarted = 0;
      let waits = 0;
      const wallTimer = unrefd(setTimeout(() => finish(false, () => reject(new ScriptRunError({
        message: `The script waited on data for over ${Math.round(this.maxWallMs / 1000)} seconds and was stopped.`,
      }))), this.maxWallMs));
      // One run at a time, so what the process gains while it runs is the run's.
      const baseline = process.memoryUsage.rss();
      const memoryTimer = unrefd(setInterval(() => {
        if (process.memoryUsage.rss() - baseline <= this.maxMemoryBytes) return;
        finish(false, () => reject(new ScriptRunError({
          message: `The script used more than ${Math.round(this.maxMemoryBytes / 1_048_576).toLocaleString("en-US")} MB of memory and was stopped.`,
        })));
      }, MEMORY_EVERY_MS));

      const startBudget = () => {
        budgetStarted = Date.now();
        budgetTimer = unrefd(setTimeout(() => finish(false, () => reject(new ScriptRunError({
          message: `The script ran for over ${seconds} seconds on ${request.bars.length.toLocaleString("en-US")} bars and was stopped.`,
        }))), Math.max(0, budgetLeft)));
      };
      const pauseBudget = () => {
        if (!budgetTimer) return;
        clearTimeout(budgetTimer);
        budgetTimer = null;
        budgetLeft -= Date.now() - budgetStarted;
      };
      const onAbort = () => finish(false, () => reject(aborted(signal)));
      const finish = (healthy: boolean, settle: () => void) => {
        if (settled) return;
        settled = true;
        pauseBudget();
        clearTimeout(wallTimer);
        clearInterval(memoryTimer);
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
        finish(true, () => reject(aborted(signal)));
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
    // Runs still waiting start, see the runner is off, and end.
    for (const start of this.queue.splice(0)) start();
    this.idle?.terminate();
    this.idle = null;
    for (const worker of this.live) worker.terminate();
    this.live.clear();
  }
}

/**
 * A script worker: runs one script at a time off the app's thread, so a
 * script that never ends, or grows without end, is stopped by terminating the
 * worker (runner.ts) and never freezes the app. It asks the app for bars and
 * has no other way out.
 */
import { describeError, runScript, ScriptFailure } from "./engine";
import type { Candle } from "./model";
import type { FromWorker, ToWorker } from "./protocol";
import { hardenWorker } from "./worker-guard";

declare const self: Worker;

// After the imports above: from here on nothing in this worker reaches files, processes or the network.
hardenWorker();

let nextRequestId = 1;
const pendingBars = new Map<number, { resolve: (bars: Candle[]) => void; reject: (error: Error) => void }>();

function post(message: FromWorker): void {
  self.postMessage(message);
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  if (message.type === "bars") {
    const pending = pendingBars.get(message.requestId);
    if (!pending) return;
    pendingBars.delete(message.requestId);
    if (message.error !== undefined) pending.reject(new Error(message.error));
    else pending.resolve(message.bars ?? []);
    return;
  }
  if (message.type !== "run") return;
  const { runId, request } = message;
  runScript(request, ({ symbol, timeframe, start, end, limit }) => new Promise<Candle[]>((resolve, reject) => {
    const requestId = nextRequestId++;
    pendingBars.set(requestId, { resolve, reject });
    post({
      type: "bars", runId, requestId, symbol, timeframe,
      ...(start !== undefined ? { start } : {}),
      ...(end !== undefined ? { end } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  })).then(
    (output) => post({ type: "done", runId, output }),
    (error) => post({ type: "failed", runId, error: error instanceof ScriptFailure ? error.detail : describeError(error, request.source) }),
  );
};

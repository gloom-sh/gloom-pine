/**
 * What a script worker takes away from itself before it runs anything: the
 * calls that reach files, processes, the network, native code or other
 * modules. The runtime turns a script into JavaScript, and it refuses the
 * ways out it knows of; this is the wall behind that, for one it does not.
 *
 * Runs after the worker's static imports, which need these to load.
 */

/** Bun's calls that read or write files, start processes, open sockets or load native code. */
const BUN_MEMBERS = [
  "$", "spawn", "spawnSync", "file", "write", "mmap", "connect", "listen", "serve", "udpSocket", "fetch", "dns",
  "dlopen", "FFI", "plugin", "build", "openInEditor", "WebView", "Terminal", "s3", "S3Client", "sql", "SQL",
  "postgres", "redis", "RedisClient", "secrets", "cron", "env", "stdin", "stdout", "stderr", "embeddedFiles",
  "FileSystemRouter", "Glob", "Archive", "unsafe", "generateHeapSnapshot",
];

/**
 * Globals that reach the network, start workers or load modules. `process` is
 * last: with it gone, Bun 1.3 cannot resolve a module imported later, and
 * every other step has to be done by then.
 */
const GLOBALS = ["fetch", "WebSocket", "EventSource", "XMLHttpRequest", "Worker", "SharedWorker", "require", "process"];

function remove(target: object, name: string): void {
  try {
    Reflect.deleteProperty(target, name);
  } catch {
    // Intentional ignore: a member that cannot be deleted is overwritten below.
  }
  if ((target as Record<string, unknown>)[name] === undefined) return;
  try {
    Object.defineProperty(target, name, { value: undefined, writable: false, configurable: false });
  } catch {
    try {
      (target as Record<string, unknown>)[name] = undefined;
    } catch {
      // Intentional ignore: a read-only member stays, and the test lists which.
    }
  }
}

export function hardenWorker(): void {
  // From any function, `.constructor` is the one that compiles text into code.
  for (const sample of [function () {}, async function () {}, function* () {}, async function* () {}]) {
    Object.defineProperty(Object.getPrototypeOf(sample), "constructor", { value: undefined, writable: false, configurable: false });
  }
  remove(globalThis, "eval");
  const bun = (globalThis as { Bun?: object }).Bun;
  if (bun) {
    for (const name of BUN_MEMBERS) remove(bun, name);
    Object.freeze(bun);
  }
  for (const name of GLOBALS) remove(globalThis, name);
}


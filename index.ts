import { createPinePlugin } from "./plugin";
import { PineService, scriptsCapability } from "./service";

/**
 * The Bun entry: the terminal, the command line, and the process behind the
 * desktop view. Scripts are kept and run here, each run in a worker with a
 * time limit, and every saved script is a series in the data catalog.
 */
let service: PineService | null = null;

export const pinePlugin = createPinePlugin({
  setup(ctx) {
    service?.dispose();
    service = new PineService(ctx);
    ctx.registerCapability(scriptsCapability(service));
  },
  dispose() {
    service?.dispose();
    service = null;
  },
});

export default pinePlugin;

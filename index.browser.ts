import { createPinePlugin } from "./plugin";

/**
 * The desktop view's entry: the pane alone. The view is a browser context
 * and never loads the script runtime; the pane lists, saves and charts
 * scripts through the Bun process's `pine-scripts` capability.
 */
export const pinePlugin = createPinePlugin();

export default pinePlugin;

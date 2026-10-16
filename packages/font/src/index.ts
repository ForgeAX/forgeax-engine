// @forgeax/engine-font - runtime-safe font asset contribution.
//
// Build-time baking lives behind the explicit Node-only `./cli-font` and
// `./font-importer` subpaths. Keeping the main entry free of the CLI's
// `node:buffer`/WASM graph prevents App bundles from pulling the producer
// toolchain into the browser runtime.
export { fontContribution } from './runtime/font-decoder.js';

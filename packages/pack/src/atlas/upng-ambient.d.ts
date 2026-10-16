// Ambient declaration for `upng-js` (PNG decoder/encoder) used by the
// `forgeax asset atlas` subcommand (run-atlas.ts) and by
// its hermetic CLI integration tests under `__tests__/`. The package
// ships without bundled `.d.ts`; consumer sites cast through local
// interfaces to match the subset they use.
//
// Mirrors `packages/image/src/image-decoders.d.ts` so the `import('upng-js')`
// site in run-atlas.ts type-resolves under tsc -b without an `any` escape
// hatch leak. The pack package keeps a private declaration here rather
// than reaching into engine-image (`@forgeax/engine-image` would create a
// circular dep: image already depends on pack via @forgeax/engine-pack).

declare module 'upng-js';

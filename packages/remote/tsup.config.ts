import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

// Penta-entry bundle layout:
//   - src/index.ts  -> dist/index.mjs   thin re-export facade for `import
//                                       { InspectorError } from '@forgeax/engine-remote'`
//                                       (charter proposition 1).
//   - src/errors.ts -> dist/errors.mjs  ./errors sub-path; lets callers import
//                                       the closed InspectorErrorCode union
//                                       without pulling the ws / vm runtime
//                                       surface.
//   - src/server.ts -> dist/server.mjs  ./server sub-path; in-process
//                                       WebSocket server consumed by
//                                       engine.startConsole via dynamic
//                                       import (D-P4 / AC-22).
//   - src/execute.ts-> dist/execute.mjs ./execute sub-path; ws-free eval core
//                                       (executeScript) reused by the browser
//                                       DevKit live bridge. A browser cannot
//                                       bind a Node WS server, so createApp
//                                       dials a loopback relay and runs
//                                       executeScript directly in the page
//                                       realm. This entry carries NO ws import.
//   - src/introspect.ts -> dist/introspect.mjs ./introspect sub-path; browser-safe
//                                       projection shared by the relay's eval script
//
// External pins keep dynamic imports + node built-ins from being bundled
// (AC-09 / AC-22 + plan-strategy D-P4 bundle physical isolation).
export default defineConfig({
  ...baseTsupConfig,
  entry: [
    'src/index.ts',
    'src/errors.ts',
    'src/server.ts',
    'src/execute.ts',
    'src/introspect.ts',
  ],
  // Shared chunks keep one RemoteError class across entries, so `instanceof`
  // holds when a script throws an error built from another sub-path.
  splitting: true,
  external: ['@forgeax/engine-runtime', '@forgeax/engine-ecs', '@forgeax/engine-gltf', '@forgeax/engine-image', '@forgeax/engine-pack', 'ws', 'node:vm', 'node:util'],
});

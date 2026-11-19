import { expect, it } from 'vitest';
import { assertPlayerModule } from '../plugin-programs.js';

it('admits the portable program compiler while retaining Node and authoring rejection', () => {
  for (const id of [
    '/sdk/packages/shader-compiler/dist/program.mjs',
    '@forgeax/engine-shader-compiler/program',
    '/sdk/node_modules/@forgeax/engine-shader-compiler/dist/program.mjs',
    '/sdk/packages/naga/dist/index.mjs',
    '@forgeax/engine-naga',
  ])
    expect(() => assertPlayerModule(id, 'player.js')).not.toThrow();
  for (const id of [
    'node:fs/promises',
    '__vite-browser-external:node:crypto',
    '/sdk/packages/shader-compiler/dist/index.mjs',
    '@forgeax/engine-shader-compiler',
    '/sdk/packages/shader-compiler/src/compiler-fingerprint.ts',
    '/sdk/packages/vfx-compiler/dist/index.mjs',
    '/sdk/packages/devkit/dist/index.mjs',
  ])
    expect(() => assertPlayerModule(id, 'player.js')).toThrow(/leaked into the player/);
});

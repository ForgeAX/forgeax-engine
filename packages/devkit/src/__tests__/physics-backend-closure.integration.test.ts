import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'vite';
import { expect, it } from 'vitest';

it.each([
  '3d',
  '2d',
  'components',
  'none',
])('keeps the %s production entry within its physics boundary', async (selection) => {
  const root = resolve(import.meta.dirname, '../../../..');
  const cache = resolve(root, 'node_modules/.cache');
  await mkdir(cache, { recursive: true });
  const temporary = await mkdtemp(resolve(cache, 'forgeax-physics-closure-'));
  try {
    const entry = resolve(temporary, 'entry.mjs');
    const source =
      selection === 'none'
        ? 'console.log(1);'
        : selection === 'components'
          ? "import { physicsComponentsPlugin } from '@forgeax/engine/physics'; console.log(physicsComponentsPlugin());"
          : `import physics from '@forgeax/engine/physics-rapier${selection}'; console.log(physics);`;
    await writeFile(entry, source);
    const modules = new Set<string>();
    await build({
      root,
      configFile: false,
      logLevel: 'error',
      plugins: [
        {
          name: 'physics-closure',
          moduleParsed(info) {
            modules.add(info.id);
          },
        },
      ],
      build: { target: 'esnext', write: false, rollupOptions: { input: entry } },
    });
    for (const dimension of ['3d', '2d']) {
      expect([...modules].some((id) => id.includes(`/physics-rapier${dimension}/`))).toBe(
        selection === dimension,
      );
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

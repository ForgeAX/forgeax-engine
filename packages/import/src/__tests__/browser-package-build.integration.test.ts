import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);

it('bundles glTF and mesh field production through the published browser entry', async () => {
  // Keep Vite's real production build outside the instrumented Vitest server.
  // The original five-second case budget and every browser-entry oracle remain.
  const { stdout } = await execute(
    process.execPath,
    [fileURLToPath(new URL('browser-package-build.fixture.mjs', import.meta.url))],
    { encoding: 'utf8', timeout: 4500, maxBuffer: 2 * 1024 * 1024 },
  );
  const { modules, exports, imports } = JSON.parse(stdout) as {
    modules: string[];
    exports: string[];
    imports: string[];
  };
  expect(exports).toEqual(
    expect.arrayContaining([
      'gltfImporter',
      'cookMeshDistanceFieldProduct',
      'encodeMeshDistanceFieldProduct',
    ]),
  );
  expect(modules.some((id) => id.endsWith('/packages/import/dist/browser.mjs'))).toBe(true);
  expect(modules.some((id) => id.endsWith('/packages/import/dist/index.mjs'))).toBe(false);
  expect(modules.some((id) => id.includes('browser-external'))).toBe(false);
  expect(imports).toEqual([]);
});

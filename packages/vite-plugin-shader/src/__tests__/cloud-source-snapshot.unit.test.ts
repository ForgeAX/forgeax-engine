import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  loadCloudDensityModules,
  loadCloudRendererModules,
} from '../engine-inputs/load-engine-shader-entries.js';

it('uses the supplied source reader for cloud density and renderer imports', async () => {
  const paths = new Set<string>();
  const readText = async (path: string) => {
    paths.add(path);
    return `${await readFile(path, 'utf8')}\n// captured cloud source`;
  };
  const current = await loadCloudDensityModules();
  const captured = await loadCloudDensityModules(readText);
  expect(captured.identity).not.toBe(current.identity);
  expect(captured.imports['forgeax_cloud::medium']).toContain('// captured cloud source');
  const renderer = await loadCloudRendererModules(readText);
  expect(renderer.imports['forgeax_view::common']).toContain('// captured cloud source');
  expect([...paths].some((path) => path.endsWith('/cloud/medium.wgsl'))).toBe(true);
  expect(renderer.sourcePaths).toContain(captured.sourcePaths[0]);
});

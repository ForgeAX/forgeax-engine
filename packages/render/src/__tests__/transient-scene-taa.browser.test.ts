import { readShaderManifestPublication } from '@forgeax/engine-shader';
import { expect, it } from 'vitest';
import { verifyTransientSceneTaa } from './transient-scene-taa.fixture';

it.each([
  'depth24plus',
  'depth24plus-stencil8',
] as const)('keeps scene native commands visible before the published TAA resolve with %s', async (depthFormat) => {
  const response = await fetch('/shaders/manifest.json');
  expect(response.ok).toBe(true);
  const manifest = (await readShaderManifestPublication(await response.json())) as {
    entries: { wgsl: string }[];
  };
  const entries = manifest.entries.filter((entry) => entry.wgsl.includes('fn fs_taa_resolve('));
  expect(entries).toHaveLength(1);
  const source = entries[0]?.wgsl;
  if (source === undefined) throw Error('Missing published TAA shader');
  await verifyTransientSceneTaa(source, depthFormat);
}, 60_000);

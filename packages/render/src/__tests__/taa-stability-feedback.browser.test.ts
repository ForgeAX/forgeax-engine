import { readShaderManifestPublication } from '@forgeax/engine-shader';
import { beforeAll, expect, it } from 'vitest';
import { verifyTaaStabilityFeedback } from './taa-stability-feedback';

let publishedSource: string;

beforeAll(async () => {
  const response = await fetch('/shaders/manifest.json');
  expect(response.ok).toBe(true);
  const manifest = (await readShaderManifestPublication(await response.json())) as {
    entries: { wgsl: string }[];
  };
  const entries = manifest.entries.filter((entry) => entry.wgsl.includes('fn fs_taa_resolve('));
  expect(entries).toHaveLength(1);
  const entry = entries[0];
  if (!entry) throw new Error('Missing published TAA shader');
  publishedSource = entry.wgsl;
});

it.each([
  'feedback',
  'secondary-motion',
  'clipping-recovery',
] as const)('preserves HDR feedback and recovery through browser shader publication (%s)', async (scenario) => {
  await verifyTaaStabilityFeedback(publishedSource, scenario);
});

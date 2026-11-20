import { expect, it } from 'vitest';
import { browserShaderEntries } from './browser-shader-entries.fixture';
import { verifyTransientSceneTaa } from './transient-scene-taa.fixture';

it.each([
  'depth24plus',
  'depth24plus-stencil8',
] as const)('keeps scene native commands visible before the published TAA resolve with %s', async (depthFormat) => {
  const entries = (await browserShaderEntries(['forgeax_view::taa_resolve'])).filter((entry) =>
    entry.wgsl.includes('fn fs_taa_resolve('),
  );
  expect(entries).toHaveLength(1);
  const source = entries[0]?.wgsl;
  if (source === undefined) throw Error('Missing published TAA shader');
  await verifyTransientSceneTaa(source, depthFormat);
}, 60_000);

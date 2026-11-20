import { beforeAll, expect, it } from 'vitest';
import { browserShaderEntries } from './browser-shader-entries.fixture';
import { verifyTaaStabilityFeedback } from './taa-stability-feedback';

let publishedSource: string;

beforeAll(async () => {
  const entries = (await browserShaderEntries(['forgeax_view::taa_resolve'])).filter((entry) =>
    entry.wgsl.includes('fn fs_taa_resolve('),
  );
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

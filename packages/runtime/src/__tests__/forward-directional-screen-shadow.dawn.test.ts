import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildEngineShaderTemplateManifest } from '@forgeax/engine-vite-plugin-shader';
import { it } from 'vitest';
import { verifyForwardScreenShadow } from './forward-directional-screen-shadow.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

it.each([
  'automatic',
  'direct',
] as const)('projects Forward sun and punctual visibility for %s geometry', {
  timeout: 180_000,
}, async (lane) => {
  const evidence = process.env.FORGEAX_FORWARD_SHADOW_EVIDENCE;
  if (evidence !== undefined) mkdirSync(evidence, { recursive: true });
  await verifyForwardScreenShadow(lane, {
    shaderManifestUrl: shaderManifestUrl(
      await buildEngineShaderTemplateManifest({ pointShadows: true }),
    ),
    ...(evidence === undefined
      ? {}
      : { writeEvidence: (name, bytes) => writeFileSync(join(evidence, name), bytes) }),
  });
});

it('preserves a bounded Spot shadow without the point-shadow publication', {
  timeout: 180_000,
}, async () => {
  await verifyForwardScreenShadow('automatic', {
    pointShadows: false,
    shaderManifestUrl: shaderManifestUrl(await buildEngineShaderTemplateManifest()),
  });
});

const benchmarkDirectory = process.env.FORGEAX_FORWARD_SHADOW_BENCHMARK;
it.skipIf(benchmarkDirectory === undefined)(
  'measures 1080p Forward shadow projection on Dawn',
  {
    timeout: 240_000,
  },
  async () => {
    if (benchmarkDirectory === undefined) throw new Error('missing benchmark output directory');
    mkdirSync(benchmarkDirectory, { recursive: true });
    await verifyForwardScreenShadow('automatic', {
      benchmark: true,
      shaderManifestUrl: shaderManifestUrl(
        await buildEngineShaderTemplateManifest({ pointShadows: true }),
      ),
      writeEvidence: (name, bytes) => writeFileSync(join(benchmarkDirectory, name), bytes),
    });
  },
);

import { it } from 'vitest';
import { particleDepthLayouts, verifyFeatureDepthMaterial } from './feature-depth-material.fixture';

const lightweight = process.env.FORGEAX_DAWN_LIGHTWEIGHT === '1';

it('samples depth written by a vertex-only prepared graphics pass', async () => {
  await verifyFeatureDepthMaterial({
    ...particleDepthLayouts[0],
    view: false,
    missing: 'none',
    writeDepth: true,
  });
}, 120_000);

const completeCases = particleDepthLayouts.flatMap((layout) =>
  [false, true].flatMap((view) =>
    (['none', 'material', 'depth'] as const).map((missing) => ({ ...layout, view, missing })),
  ),
);
const lightweightCases = [
  { ...particleDepthLayouts[0], view: false, missing: 'none' as const },
  { ...particleDepthLayouts[0], view: true, missing: 'material' as const },
  { ...particleDepthLayouts[1], view: false, missing: 'depth' as const },
  { ...particleDepthLayouts[1], view: true, missing: 'none' as const },
  { ...particleDepthLayouts[2], view: false, missing: 'material' as const },
  { ...particleDepthLayouts[2], view: true, missing: 'depth' as const },
];

it.each(lightweight ? lightweightCases : completeCases)(
  'combines depth/material/particle input: $name view=$view missing=$missing',
  verifyFeatureDepthMaterial,
  120_000,
);

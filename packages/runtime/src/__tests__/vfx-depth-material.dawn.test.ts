import { it } from 'vitest';
import { particleDepthLayouts, verifyFeatureDepthMaterial } from './feature-depth-material.fixture';

// Separate from the synthetic layout suite so each renderer/manifest batch
// has a bounded process lifetime under the Dawn runner's file isolation.
const layouts = [
  { ...particleDepthLayouts[0], particleKind: 'billboard' },
  ...(['ribbon', 'trail', 'beam'] as const).map((particleKind) => ({
    ...particleDepthLayouts[1],
    particleKind,
  })),
  { ...particleDepthLayouts[2], particleKind: 'mesh' },
] as const;
const lightweight = process.env.FORGEAX_DAWN_LIGHTWEIGHT === '1';
const completeMaterialCases = layouts.flatMap((layout) =>
  (['none', 'material', 'depth'] as const).map((missing) => ({ ...layout, view: true, missing })),
);
const lightweightMaterialCases = layouts.flatMap((layout, index) => {
  const missing =
    index === 0 || index === 2
      ? (['none', 'material'] as const)
      : index === 1
        ? (['none', 'depth'] as const)
        : (['none'] as const);
  return missing.map((value) => ({ ...layout, view: true, missing: value }));
});

it.each(lightweight ? lightweightMaterialCases : completeMaterialCases)(
  'cooks and submits $particleKind with material/depth/input: missing=$missing',
  verifyFeatureDepthMaterial,
  120_000,
);
it.each(
  (lightweight ? layouts.filter((layout) => layout.particleKind === 'beam') : layouts).map(
    (layout) => ({ ...layout, view: true, missing: 'none' as const, inputLane: 3 }),
  ),
)(
  'renders sparse material lane 3 through cooked $particleKind instances',
  verifyFeatureDepthMaterial,
  120_000,
);
it.each(
  (lightweight ? layouts.filter((layout) => layout.particleKind === 'mesh') : layouts).map(
    (layout) => ({
      ...layout,
      view: true,
      missing: 'none' as const,
      inputLane: 3,
      allInputs: true,
    }),
  ),
)(
  'reads all four distinct material lanes through cooked $particleKind instances',
  verifyFeatureDepthMaterial,
  120_000,
);

it('cooks and draws a Player MeshFilter with material/depth inputs and real pixel readback', async () => {
  if ((await navigator.gpu.requestAdapter()) === null) throw new Error('Dawn adapter unavailable');
  await verifyFeatureDepthMaterial({
    ...particleDepthLayouts[2],
    particleKind: 'mesh',
    view: true,
    missing: 'none',
    playerMesh: true,
  });
}, 120_000);

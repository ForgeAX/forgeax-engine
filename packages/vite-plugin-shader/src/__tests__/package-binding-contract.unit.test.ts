import { expect, it } from 'vitest';
import { loadPackageMaterialShaderEntries } from '../engine-inputs/load-engine-shader-entries';

it('loads the VFX owner declarations for depth, View-only and Standard programs', async () => {
  const entries = await loadPackageMaterialShaderEntries('@forgeax/engine-vfx-render');
  for (const [name, bindings, sceneDepth] of [
    ['billboard', 'view-and-scene-depth', 'before-pass'],
    ['billboard-inputs', 'view-and-scene-depth', 'before-pass'],
    ['ribbon', 'view-only', undefined],
    ['trail', 'view-only', undefined],
    ['beam', 'view-only', undefined],
    ['mesh', 'render-material', undefined],
    ['mesh-shadow', 'view-only', undefined],
  ] as const) {
    const entry = entries.find(
      (candidate) => candidate.reservedIdentifier === `forgeax::vfx-render.particles.${name}`,
    );
    expect(entry?.program?.bindings).toBe(bindings);
    expect(entry?.program?.sceneDepth).toBe(sceneDepth);
  }
});

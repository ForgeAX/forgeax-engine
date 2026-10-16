import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STANDARD_PBR_ARTIFACT_RECEIPT } from '@forgeax/engine-shader';
import { describe, expect, it } from 'vitest';
import {
  projectStandardSurfacePasses,
  type StandardSurfaceProjectionOptions,
} from '../assembly/material/surface-projection';

function shaderSource(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../shader/src/${name}`, import.meta.url)),
    'utf8',
  );
}

const standard: StandardSurfaceProjectionOptions = {
  surfaceModule: 'game_3d::rusted_iron_surface',
  values: {},
  geometryVariant: 'rigid',
  lightingLane: 'direct',
  alphaClip: true,
};

describe('Surface adjacent regressions', () => {
  it('retains the default Standard pass family and provenance', () => {
    const passes = projectStandardSurfacePasses(standard);
    expect(passes.map((pass) => pass.name)).toEqual(['forward', 'deferred', 'shadow-caster']);
    expect(
      passes.every((pass) => pass.program.moduleSlots?.surface === standard.surfaceModule),
    ).toBe(true);
    expect(
      passes.every(
        (pass) =>
          (pass.renderState?.tags as Readonly<Record<string, string>> | undefined)?.SurfaceKind ===
          'standard',
      ),
    ).toBe(true);
  });

  it('keeps explicit full-custom pass ownership closed', () => {
    const passes = projectStandardSurfacePasses({
      ...standard,
      surfaceKind: 'full-custom',
      declaredPasses: ['forward'],
    });
    expect(passes.map((pass) => pass.name)).toEqual(['forward']);
    expect(
      (passes[0]?.renderState?.tags as Readonly<Record<string, string>> | undefined)?.SurfaceKind,
    ).toBe('full-custom');
  });

  it('keeps skinning and GPU-driven siblings on their own shader owners', () => {
    const skinned = shaderSource('default-standard-pbr-skin.wgsl');
    expect(skinned).toContain('skinIndex');
    expect(skinned).toContain('skinWeight');
    expect(STANDARD_PBR_ARTIFACT_RECEIPT.directEntry).toBe('vs_main');
    expect(STANDARD_PBR_ARTIFACT_RECEIPT.sceneIndexEntry).toBe('vs_scene_index');
    expect(STANDARD_PBR_ARTIFACT_RECEIPT.resourceSlots.every((slot) => slot.group === 1)).toBe(
      true,
    );
  });
});

import { definePack, type PackOutput } from '@forgeax/engine-pack/source';
import { createBuiltinMaterialAsset } from '@forgeax/engine-shader';
import { ok, type VfxForceField } from '@forgeax/engine-types';
import type { ParticleEffectSourceV3 } from '@forgeax/engine-vfx';
import { createVfxVectorFieldTexture } from '@forgeax/engine-vfx-compiler';
import { FIELD_PACKAGE, fieldGuid } from '../src/field-guids.ts';

const identityTransform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const affineTransform = [0, 2, 0, 0, -1, 0, 0, 0, 0, 0, 0.5, 0, 0.125, -0.25, 0, 1];
const fieldKinds = ['radial', 'vortex'] as const;
const resolutions = [8, 16, 32] as const;

function vectorField(
  key: string,
  strength = 1,
  sampling: 'nearest' | 'trilinear' = 'trilinear',
): VfxForceField {
  return {
    kind: 'vector',
    texture: fieldGuid(key),
    sampling,
    transform: identityTransform,
    strength,
    attenuation: 0,
  };
}

function fieldEffect(
  key: string,
  forceFields: readonly VfxForceField[] | undefined,
  capacity = 256,
  space: 'world' | 'local' = 'world',
  count = capacity >= 10_000 ? Math.max(4, Math.ceil(capacity / 65_536)) : 1,
): PackOutput {
  const scene = key === 'affine-spatial' ? 'affine-spatial-' : ['sphere', 'box'].includes(key) ? 'boundary-' : '';
  const module = 'fields-' + scene + (forceFields ? 'on' : 'off') + '.vfx.wgsl';
  const source: ParticleEffectSourceV3 = {
    schemaVersion: 3,
    emitters: Array.from({ length: count }, (_, index) => {
      const slots = capacity === 1_000_000
        ? Math.min(65_536, capacity - index * 65_536)
        : Math.floor(capacity / count) + (index < capacity % count ? 1 : 0);
      return {
        id: 'field-' + index,
        capacity: slots,
        backend: { required: 'gpu' },
        space,
        bounds: { kind: 'aabb', min: [-4, -4, -4], max: [4, 4, 4] },
        simulationWhenCulled: 'continue',
        schedule: { rate: 0, bursts: [{ time: 0, count: slots }] },
        ...(forceFields === undefined ? {} : { forceFields }),
        program: { module },
        renderers: [{ kind: 'billboard', capacity: slots, material: fieldGuid('material/particle') }],
      };
    }),
  };
  return { kind: 'particle-effect', source };
}

function addFieldEffects(assets: Record<string, PackOutput>): void {
  const analyticField = { transform: identityTransform, strength: 0.5, attenuation: 1 };
  assets['effect/off'] = fieldEffect('off', undefined);
  assets['effect/constant'] = fieldEffect('constant', [vectorField('field/constant/8')]);
  assets['effect/zero'] = fieldEffect('zero', [vectorField('field/constant/8', 0)]);
  for (const kind of ['sphere', 'box'] as const) {
    assets['effect/' + kind] = fieldEffect(kind, [{ ...analyticField, kind }]);
  }
  for (const kind of fieldKinds) {
    for (const resolution of resolutions) {
      const field = 'field/' + kind + '/' + resolution;
      for (const sampling of ['nearest', 'trilinear'] as const) {
        const key = kind + '/' + resolution + '/' + sampling;
        assets['effect/' + key] = fieldEffect(key, [vectorField(field, 1, sampling)]);
      }
    }
  }
  const transformedField = { ...vectorField('field/constant/8'), transform: affineTransform };
  assets['effect/transformed'] = fieldEffect('transformed', [transformedField]);
  assets['effect/affine-spatial'] = fieldEffect('affine-spatial', [
    { ...vectorField('field/radial/16'), transform: affineTransform },
  ]);
  assets['effect/local'] = fieldEffect('local', [transformedField], 256, 'local');
  assets['effect/vortex/16/reversed'] = fieldEffect('vortex/16/reversed', [
    vectorField('field/vortex/16', -1),
  ]);
  assets['effect/shared'] = fieldEffect('shared', [vectorField('field/constant/8')], 512, 'world', 2);
  assets['effect/zero-vector'] = fieldEffect('zero-vector', [vectorField('field/zero/8')]);
  for (const capacity of [10_000, 100_000, 1_000_000]) {
    const key = 'benchmark/' + capacity;
    assets['effect/' + key + '/off'] = fieldEffect(key + '/off', undefined, capacity);
    assets['effect/' + key + '/on'] = fieldEffect(key + '/on', [
      vectorField('field/vortex/16'),
      { ...analyticField, kind: 'sphere' },
    ], capacity);
  }
}

export default definePack({
  schemaVersion: '2.0.0',
  packageId: FIELD_PACKAGE,
  name: 'Saved particle vector fields',
  build() {
    const assets: Record<string, PackOutput> = { 'material/particle': createBuiltinMaterialAsset('unlit') };
    const zero = createVfxVectorFieldTexture({
      resolution: [8, 8, 8],
      field: { kind: 'constant', value: [0, 0, 0] },
    });
    if (!zero.ok) return zero;
    assets['field/zero/8'] = zero.value;
    for (const resolution of resolutions) {
      for (const kind of ['constant', ...fieldKinds] as const) {
        const texture = createVfxVectorFieldTexture({
          resolution: [resolution, resolution, resolution],
          field: kind === 'constant' ? { kind, value: [0.5, 0.25, -0.125] } : { kind, magnitude: 1 },
        });
        if (!texture.ok) return texture;
        assets['field/' + kind + '/' + resolution] = texture.value;
      }
    }
    addFieldEffects(assets);
    return ok(assets);
  },
});

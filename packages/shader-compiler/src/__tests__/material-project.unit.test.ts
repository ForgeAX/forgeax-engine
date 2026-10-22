import type { MaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { projectMaterial } from '../material/project.js';
import {
  DEFAULT_MATERIAL_VARIANT_CONTEXT,
  lowerMaterialVariantContext,
} from '../material/variant-context.js';

const material: MaterialAsset = {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      program: { module: 'game::paint', moduleSlots: { lighting: 'game::pbr' } },
      renderState: { blend: 'opaque', cull: 'back' },
    },
  ],
  parameters: [
    { name: 'baseColor', type: 'color' },
    { name: 'roughness', type: 'f32' },
    { name: 'normalTexture', type: 'texture' },
  ],
  values: {
    baseColor: [0.8, 0.2, 0.1, 1],
    roughness: 0.35,
    normalTexture: {
      texture: 'normal-guid' as never,
      sampler: 'linear-guid' as never,
      coordinates: { set: 1, transform: { offset: [0.1, 0.2], scale: [2, 2], rotation: 0.5 } },
    },
  },
};

describe('MaterialAsset runtime and module projection', () => {
  it('keeps every material value in the runtime projection', () => {
    const result = projectMaterial(material, {
      material: 'leaf',
      mode: 'development',
      sourceClosure: { 'game::paint': 'hash-paint' },
      vertexInputs: [{ location: 0, format: 'float32x3' }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.runtimeValues).toEqual(material.values);
    expect(result.value.staticSelection).toMatchObject({
      moduleSlots: { lighting: 'game::pbr' },
      pipelineState: { blend: 'opaque', cull: 'back' },
      sourceClosure: { 'game::paint': 'hash-paint' },
      vertexInputs: [{ location: 0, format: 'float32x3' }],
    });
  });

  it('returns a structured missing-cook error in production mode', () => {
    const result = projectMaterial(material, { material: 'leaf', mode: 'production' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    {
      expect(result.error.code).toBe('material-specialization-not-cooked');
      const detail = result.error.detail as {
        material: string;
        staticSelection: readonly unknown[];
      };
      expect(detail.material).toBe('leaf');
      expect(detail.staticSelection.length).toBeGreaterThan(0);
    }
  });

  it('characterizes runtime and module-slot projections separately', () => {
    const result = projectMaterial(material, {
      material: 'owner-overlap',
      mode: 'development',
      sourceClosure: { 'game::paint': 'hash-paint' },
      vertexInputs: [{ location: 0, format: 'float32x3' }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.runtimeValues).toEqual(material.values);
    expect(result.value.staticSelection.moduleSlots).toEqual({ lighting: 'game::pbr' });
  });

  it('lowers the producer-owned variant context to private selectors', () => {
    const context = DEFAULT_MATERIAL_VARIANT_CONTEXT;
    expect(lowerMaterialVariantContext(context)).toEqual({
      STORAGE_BUFFER_AVAILABLE: true,
      ATMOSPHERE_AVAILABLE: false,
      CLUSTER_FORWARD_AVAILABLE: true,
      PROBE_BLEND_AVAILABLE: true,
      EXTENDED_LIGHTING_AVAILABLE: true,
      PROJECTOR_AVAILABLE: true,
      WEBGL2_COMPAT: false,
      PER_INSTANCE_REGION: false,
      SKINNING_DISABLED: true,
      TERRAIN_GEOMETRY_AVAILABLE: false,
      POINT_SHADOW_AVAILABLE: false,
      MATERIAL_VALIDATION_ENABLED: false,
      VISIBLE_SURFACE_AVAILABLE: false,
    });
    expect(
      lowerMaterialVariantContext({ ...context, capability: 'storage-buffer-atmosphere' }),
    ).toMatchObject({ STORAGE_BUFFER_AVAILABLE: true, ATMOSPHERE_AVAILABLE: true });
    expect(
      lowerMaterialVariantContext({ ...context, capability: 'uniform-fallback' }),
    ).toMatchObject({
      CLUSTER_FORWARD_AVAILABLE: true,
      PROBE_BLEND_AVAILABLE: false,
      EXTENDED_LIGHTING_AVAILABLE: false,
      PROJECTOR_AVAILABLE: false,
    });
    expect(lowerMaterialVariantContext({ ...context, pipeline: 'deferred' })).toEqual(
      lowerMaterialVariantContext(context),
    );
  });
});

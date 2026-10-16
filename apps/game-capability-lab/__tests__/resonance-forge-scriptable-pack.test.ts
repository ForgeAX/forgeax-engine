import { quat } from '@forgeax/engine-math';
import type { PackBuildContextWithoutParameters, PackOutputMap } from '@forgeax/engine-pack/source';
import type {
  Asset,
  MaterialAsset,
  MeshAsset,
  ParticleEffectAsset,
  SceneAsset,
} from '@forgeax/engine-types';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import scriptablePack from '../assets/resonance-forge.pack';
import { createResonanceFormation, resonancePose } from '../assets/procedural/resonance-blueprint';

function assetAt<TKind extends Asset['kind']>(
  assets: PackOutputMap,
  sourceKey: string,
  kind: TKind,
): Extract<Asset, { readonly kind: TKind }> {
  const asset = assets[sourceKey];
  if (asset?.kind !== kind || 'execution' in asset) {
    throw new Error(`expected ${sourceKey} to be a ${kind} asset`);
  }
  return asset as Extract<Asset, { readonly kind: TKind }>;
}

describe('Resonance Forge ScriptablePack dogfood', () => {
  it('builds all ordinary output kinds and keeps the external VFX payload cooked', async () => {
    const particle: ParticleEffectAsset = {
      kind: 'particle-effect',
      schemaVersion: 3,
      programFingerprint: 'resonance-test',
      emitters: [{ id: 'charge', capacity: 8 }],
      program: {
        format: 'forgeax-vfx-program-4',
        fingerprint: 'resonance-test',
        emitters: [],
      },
    };
    const context: PackBuildContextWithoutParameters = {
      packageId: scriptablePack.packageId,
      async readByGuid<TAsset extends import('@forgeax/engine-pack/source').PackOutput>() {
        return ok(particle as TAsset);
      },
    };
    const built = await scriptablePack.build(context);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(Object.keys(built.value)).toHaveLength(16);
    const materials = Object.values(built.value).filter(
      (asset): asset is MaterialAsset => asset.kind === 'material',
    );
    const meshes = Object.values(built.value).filter(
      (asset): asset is MeshAsset => asset.kind === 'mesh',
    );
    const scenes = Object.values(built.value).filter(
      (asset): asset is SceneAsset => asset.kind === 'scene',
    );
    expect(materials).toHaveLength(4);
    expect(materials.every((material) => material.passes?.length === 2)).toBe(true);
    expect(
      materials.every((material) =>
        material.passes?.every(
          (pass) =>
            pass.program.moduleSlots?.surface ===
            'forgeax_material::default_standard_surface',
        ),
      ),
    ).toBe(true);
    expect(meshes).toHaveLength(5);
    expect(scenes).toHaveLength(1);
    expect(meshes.reduce((vertices, mesh) => vertices + mesh.vertices.length / 12, 0)).toBeGreaterThan(3_000);
    expect(meshes.every((mesh) => mesh.materialSlots.length > 0 && mesh.aabb?.length === 6)).toBe(true);
    expect(assetAt(built.value, 'geometry/outer-ring', 'mesh').materialSlots).toHaveLength(2);
    expect(assetAt(built.value, 'geometry/inner-ring', 'mesh').submeshes).toHaveLength(2);
    const scene = assetAt(built.value, 'scene/formation', 'scene');
    const sceneEntities = Object.entries(scene.entities);
    expect(sceneEntities).toHaveLength(28);
    expect(sceneEntities.map(([key]) => key)).toEqual(
      Array.from({ length: 28 }, (_, localId) => `node-${localId}`),
    );
    expect(
      sceneEntities.every(
        ([, entity]) =>
          typeof entity.components.MeshFilter?.assetHandle === 'string' &&
          Array.isArray(entity.components.MeshRenderer?.materials),
      ),
    ).toBe(true);
    expect(assetAt(built.value, 'texture/resonance-atlas', 'texture').kind).toBe('texture');
    expect(assetAt(built.value, 'sampler/resonance', 'sampler').kind).toBe('sampler');
    expect(assetAt(built.value, 'animation/clip', 'animation-clip').kind).toBe('animation-clip');
    expect(assetAt(built.value, 'animation/graph', 'animation-graph').nodes[0]?.type).toBe('clip');
    expect(assetAt(built.value, 'audio/diagnostic', 'audio').kind).toBe('audio');
    expect(built.value['vfx/charge']).toBe(particle);
  });

  it('drives 28 deterministic nodes across all generated mesh roles', () => {
    const formation = createResonanceFormation();
    expect(formation).toHaveLength(28);
    expect(new Set(formation.map((node) => node.role))).toEqual(
      new Set(['outer-ring', 'inner-ring', 'pylon', 'orb', 'anchor']),
    );

    const rotation = quat.create();
    const initial = formation.map((node) => resonancePose(node, 0, rotation).position);
    const advanced = formation.map((node) => resonancePose(node, 2.5, rotation).position);
    expect(advanced).not.toEqual(initial);
    expect(advanced.every((position) => position.every(Number.isFinite))).toBe(true);
  });
});

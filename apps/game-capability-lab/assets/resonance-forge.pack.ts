import {
  createCapsuleGeometry,
  createConeGeometry,
  createSphereGeometry,
  createTorusGeometry,
} from '@forgeax/engine-geometry';
import { quat } from '@forgeax/engine-math';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Name, Transform } from '@forgeax/engine-scene';
import type {
  AnimationClip,
  AnimationGraph,
  AudioClipAsset,
  AssetGuid as AssetGuidType,
  ParticleEffectAsset,
  SamplerAsset,
  SceneAsset,
  TextureAsset,
} from '@forgeax/engine-types';
import { AssetError, err, ok } from '@forgeax/engine-types';
import {
  bindMaterialSlots,
  createResonanceFormation,
  resonanceMaterial,
  resonancePose,
  type ResonanceRole,
} from './procedural/resonance-blueprint.ts';

const PACKAGE_NAME = 'Resonance Forge' as const;

const PACKAGE_ID = definePackageId('019fb264-1000-7000-8000-000000000000');

function assetGuid(sourceKey: string): AssetGuidType {
  return AssetGuid.derive(PACKAGE_ID, sourceKey);
}

const CHARGE_VFX_SOURCE_GUID = AssetGuid.derive(
  definePackageId('019fb264-1000-7000-8000-000000000020'),
  'vfx/charge',
);

function guidText(value: AssetGuidType): string {
  return AssetGuid.format(value);
}

function visualFor(role: ResonanceRole): {
  readonly mesh: string;
  readonly materials: readonly string[];
} {
  switch (role) {
    case 'outer-ring':
      return {
        mesh: guidText(assetGuid('geometry/outer-ring')),
        materials: [
          guidText(assetGuid('material/void-alloy')),
          guidText(assetGuid('material/ion-cyan')),
        ],
      };
    case 'inner-ring':
      return {
        mesh: guidText(assetGuid('geometry/inner-ring')),
        materials: [
          guidText(assetGuid('material/plasma-violet')),
          guidText(assetGuid('material/solar-gold')),
        ],
      };
    case 'pylon':
      return {
        mesh: guidText(assetGuid('geometry/pylon')),
        materials: [guidText(assetGuid('material/void-alloy'))],
      };
    case 'orb':
      return {
        mesh: guidText(assetGuid('geometry/orb')),
        materials: [guidText(assetGuid('material/plasma-violet'))],
      };
    case 'anchor':
      return {
        mesh: guidText(assetGuid('geometry/anchor')),
        materials: [guidText(assetGuid('material/solar-gold'))],
      };
  }
}

function createResonanceScene(): SceneAsset {
  const rotation = quat.create();
  return {
    kind: 'scene',
    entities: Object.fromEntries(createResonanceFormation().map((node, localId) => {
      const pose = resonancePose(node, 0, rotation);
      const visual = visualFor(node.role);
      return [`node-${localId}`, {
        components: {
          Name: { value: `Resonance ${node.role} ${node.index + 1}/${node.count}` },
          Transform: {
            pos: [...pose.position],
            quat: [rotation[0] ?? 0, rotation[1] ?? 0, rotation[2] ?? 0, rotation[3] ?? 1],
            scale: [...pose.scale],
          },
          MeshFilter: { assetHandle: visual.mesh },
          MeshRenderer: { materials: visual.materials },
        },
      }];
    })),
  };
}

const scriptablePack = definePack({
  schemaVersion: '2.0.0',
  packageId: PACKAGE_ID,
  name: PACKAGE_NAME,
  sceneComponents: [Name, Transform, MeshFilter, MeshRenderer],
  async build({ readByGuid }) {
    const outer = createTorusGeometry(3.4, 0.16, 16, 96);
    if (!outer.ok) return outer;
    const inner = createTorusGeometry(1.85, 0.1, 12, 72);
    if (!inner.ok) return inner;
    const pylon = createConeGeometry(0.34, 2.4, 24, 3);
    if (!pylon.ok) return pylon;
    const orb = createSphereGeometry(0.28, 24, 16);
    if (!orb.ok) return orb;
    const anchor = createCapsuleGeometry(0.18, 1.25, 8, 20);
    if (!anchor.ok) return anchor;

    const chargeVfx = await readByGuid<ParticleEffectAsset>(CHARGE_VFX_SOURCE_GUID);
    if (!chargeVfx.ok) {
      return err(
        new AssetError({
          code: 'asset-fetch-failed',
          expected: 'the declared charge particle-effect source asset',
          hint: 'ensure charge-vfx-effect.pack.json is included in the Pack roots',
          detail: { sourcePath: 'charge-vfx-effect.pack.json' },
        }),
      );
    }

    return ok({
      'material/void-alloy': resonanceMaterial([0.025, 0.035, 0.075, 1], [0.01, 0.02, 0.06], 1.2, 0.92, 0.16),
      'material/ion-cyan': resonanceMaterial([0.02, 0.42, 0.62, 1], [0.01, 0.65, 1], 7.5, 0.2, 0.22),
      'material/plasma-violet': resonanceMaterial([0.36, 0.04, 0.62, 1], [0.68, 0.03, 1], 8.5, 0.12, 0.18),
      'material/solar-gold': resonanceMaterial([0.88, 0.38, 0.035, 1], [1, 0.22, 0.015], 6.2, 0.65, 0.2),
      'geometry/outer-ring': bindMaterialSlots(outer.value, [
        { name: 'Void Frame', sourceKey: 'void-frame', material: assetGuid('material/void-alloy') },
        { name: 'Ion Conduit', sourceKey: 'ion-conduit', material: assetGuid('material/ion-cyan') },
      ]),
      'geometry/inner-ring': bindMaterialSlots(inner.value, [
        { name: 'Plasma Coil', sourceKey: 'plasma-coil', material: assetGuid('material/plasma-violet') },
        { name: 'Solar Contacts', sourceKey: 'solar-contacts', material: assetGuid('material/solar-gold') },
      ]),
      'geometry/pylon': bindMaterialSlots(pylon.value, [
        { name: 'Pylon Shell', sourceKey: 'pylon-shell', material: assetGuid('material/void-alloy') },
      ]),
      'geometry/orb': bindMaterialSlots(orb.value, [
        { name: 'Orb Plasma', sourceKey: 'orb-plasma', material: assetGuid('material/plasma-violet') },
      ]),
      'geometry/anchor': bindMaterialSlots(anchor.value, [
        { name: 'Anchor Energy', sourceKey: 'anchor-energy', material: assetGuid('material/solar-gold') },
      ]),
      'scene/formation': createResonanceScene(),
      'texture/resonance-atlas': {
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
        format: 'rgba8unorm-srgb',
        data: new Uint8Array([255, 255, 255, 255]),
        colorSpace: 'srgb',
        mips: { kind: 'none' },
      } satisfies TextureAsset,
      'sampler/resonance': {
        kind: 'sampler',
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'nearest',
      } satisfies SamplerAsset,
      'animation/clip': {
        kind: 'animation-clip',
        duration: 1,
        channels: [],
      } satisfies AnimationClip,
      'animation/graph': {
        kind: 'animation-graph',
        nodes: [{ type: 'clip', clip: guidText(assetGuid('animation/clip')), weight: 1 }],
        root: 0,
      } satisfies AnimationGraph,
      'audio/diagnostic': {
        kind: 'audio',
        sourceKey: 'resonance-forge/diagnostic-tone',
        mediaType: 'audio/wav',
        bytes: new Uint8Array([82, 73, 70, 70]),
      } satisfies AudioClipAsset,
      'vfx/charge': chargeVfx.value,
    });
  },
});

export default scriptablePack;

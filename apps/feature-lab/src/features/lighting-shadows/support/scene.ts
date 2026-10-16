import type { EntityHandle, World } from '@forgeax/engine/ecs';
import { createBoxGeometry, packInterleavedVertexAttributes } from '@forgeax/engine/geometry';
import { Materials, MeshFilter, MeshRenderer, PointLight, SpotLight } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import { Skin } from '@forgeax/engine/skinning';
import type { EquirectAsset, MaterialAsset } from '@forgeax/engine/types';
import type { Vec3 } from '../../../lab/stage';

/** A 64x32 procedural HDR sky: saturated blue zenith, white horizon band, orange ground (linear rgba32float). */
export function proceduralEquirect(): EquirectAsset {
  const width = 64;
  const height = 32;
  const texels = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const t = y / (height - 1);
    const rgb: Vec3 = t < 0.45 ? [0.05, 0.25, 1.5] : t < 0.55 ? [2, 2, 2] : [1.5, 0.35, 0.02];
    for (let x = 0; x < width; x++) texels.set([...rgb, 1], (y * width + x) * 4);
  }
  return {
    kind: 'equirect',
    width,
    height,
    format: 'rgba32float',
    data: new Uint8Array(texels.buffer),
    colorSpace: 'linear',
  };
}

export function spawnPointLight(
  world: World,
  pos: Vec3,
  color: Vec3,
  intensity: number,
  range = 8,
  ...extra: readonly { readonly component: unknown; readonly data?: unknown }[]
): EntityHandle {
  return world
    .spawn(
      { component: Transform, data: { pos } },
      { component: PointLight, data: { color, intensity, range } as never },
      ...(extra as never[]),
    )
    .unwrap() as EntityHandle;
}

export function spawnSpotLight(
  world: World,
  pos: Vec3,
  direction: Vec3,
  color: Vec3,
  data: Record<string, unknown> = {},
): EntityHandle {
  return world
    .spawn(
      { component: Transform, data: { pos } },
      {
        component: SpotLight,
        data: {
          direction,
          color,
          intensity: 60,
          range: 14,
          innerConeDeg: 18,
          outerConeDeg: 26,
          ...data,
        } as never,
      },
    )
    .unwrap() as EntityHandle;
}

interface PassShape {
  readonly renderState?: { readonly tags?: Readonly<Record<string, string>> };
  readonly program: { readonly module: string };
}

function skinnedVariant(material: MaterialAsset, caster: boolean): MaterialAsset {
  const passes = ((material as { passes?: readonly PassShape[] }).passes ?? [])
    .filter((pass) => caster || pass.renderState?.tags?.LightMode !== 'ShadowCaster')
    .map((pass) => ({
      ...pass,
      program: {
        ...pass.program,
        module:
          pass.program.module === 'forgeax_material::standard'
            ? 'forgeax::pbr-skin'
            : pass.program.module,
      },
    }));
  return { ...material, passes } as unknown as MaterialAsset;
}

export interface SkinnedCharacter {
  readonly entity: EntityHandle;
  readonly casterMaterial: ReturnType<World['allocSharedRef']>;
  readonly hiddenMaterial: ReturnType<World['allocSharedRef']>;
}

/**
 * A 1.6 m single-joint skinned box "character" whose skeleton carries one
 * authored shadow capsule; copied from the runtime capsule-shadow fixture so no
 * private asset is needed.
 */
export function spawnSkinnedCharacter(
  world: World,
  pos: Vec3,
  color: readonly [number, number, number, number],
): SkinnedCharacter {
  const box = createBoxGeometry(0.4, 1.6, 0.4).unwrap();
  const position = box.attributes.position as Float32Array;
  const count = position.length / 3;
  const attributes = {
    ...box.attributes,
    skinIndex: new Uint16Array(count * 4),
    skinWeight: Float32Array.from({ length: count * 4 }, (_, index) => (index % 4 === 0 ? 1 : 0)),
  };
  const mesh = world.allocSharedRef('MeshAsset', {
    ...box,
    attributes,
    vertices: packInterleavedVertexAttributes(attributes, count).unwrap().vertices,
  });
  const body = Materials.standard({ baseColor: color, metallic: 0, roughness: 0.6 });
  const casterMaterial = world.allocSharedRef('MaterialAsset', skinnedVariant(body, true));
  const hiddenMaterial = world.allocSharedRef('MaterialAsset', skinnedVariant(body, false));
  const inverseBindMatrices = new Float32Array(16);
  for (const lane of [0, 5, 10, 15]) inverseBindMatrices[lane] = 1;
  const skeleton = world.allocSharedRef('SkeletonAsset', {
    kind: 'skeleton',
    jointCount: 1,
    inverseBindMatrices,
    bounds: new Float32Array([-0.3, -0.9, -0.3, 0.3, 0.9, 0.3]),
    shadowCapsules: {
      joints: new Uint16Array([0]),
      shapes: new Float32Array([0, -0.58, 0, 0, 0.58, 0, 0.22]),
    },
  });
  const joint = world
    .spawn({ component: Transform, data: { pos: [pos[0], pos[1] + 0.8, pos[2]] } })
    .unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } as never },
      { component: MeshRenderer, data: { materials: [casterMaterial] } as never },
      { component: Skin, data: { skeleton, joints: new Uint32Array([joint as number]) } as never },
    )
    .unwrap() as EntityHandle;
  return { entity, casterMaterial, hiddenMaterial };
}

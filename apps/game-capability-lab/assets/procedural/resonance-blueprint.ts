import { AssetGuid } from '@forgeax/engine-pack/guid';
import { quat, type Quat } from '@forgeax/engine-math';
import { Materials } from '@forgeax/engine-render';
import type {
  AssetGuid as AssetGuidType,
  MaterialAsset,
  MaterialPass,
  MeshAsset,
} from '@forgeax/engine-types';

export type ResonanceRole = 'outer-ring' | 'inner-ring' | 'pylon' | 'orb' | 'anchor';

export interface ResonanceNode {
  readonly role: ResonanceRole;
  readonly index: number;
  readonly count: number;
}

export interface ResonancePose {
  readonly position: readonly [number, number, number];
  readonly scale: readonly [number, number, number];
}

export const RESONANCE_ROLE_COUNTS: Readonly<Record<ResonanceRole, number>> = {
  'outer-ring': 1,
  'inner-ring': 1,
  pylon: 12,
  orb: 8,
  anchor: 6,
};

const CENTER = [0, 3.4, -7] as const;

export function createResonanceFormation(): readonly ResonanceNode[] {
  return (Object.entries(RESONANCE_ROLE_COUNTS) as [ResonanceRole, number][]).flatMap(
    ([role, count]) => Array.from({ length: count }, (_, index) => ({ role, index, count })),
  );
}

export function resonancePose(node: ResonanceNode, elapsed: number, rotation: Quat): ResonancePose {
  const phase = (node.index / node.count) * Math.PI * 2;
  switch (node.role) {
    case 'outer-ring':
      quat.fromEuler(rotation, elapsed * 0.09, elapsed * 0.16, elapsed * 0.24, 'XYZ');
      return { position: CENTER, scale: [1, 1, 1] };
    case 'inner-ring':
      quat.fromEuler(
        rotation,
        Math.PI * 0.5 + elapsed * 0.21,
        elapsed * -0.13,
        elapsed * -0.32,
        'XYZ',
      );
      return { position: CENTER, scale: [1, 1, 1] };
    case 'pylon': {
      const angle = phase + elapsed * 0.08;
      quat.fromEuler(rotation, 0, -angle, 0, 'XYZ');
      return {
        position: [
          CENTER[0] + Math.cos(angle) * 4.65,
          1.25 + Math.sin(elapsed * 1.2 + phase) * 0.12,
          CENTER[2] + Math.sin(angle) * 4.65,
        ],
        scale: [0.72, 1, 0.72],
      };
    }
    case 'orb': {
      const angle = phase - elapsed * 0.42;
      quat.fromEuler(rotation, elapsed * 0.7 + phase, angle, elapsed * 0.25, 'XYZ');
      return {
        position: [
          CENTER[0] + Math.cos(angle) * 2.55,
          CENTER[1] + Math.sin(phase * 2 + elapsed * 0.85) * 1.35,
          CENTER[2] + Math.sin(angle) * 2.55,
        ],
        scale: [0.75, 0.75, 0.75],
      };
    }
    case 'anchor': {
      const angle = phase + elapsed * 0.15;
      quat.fromEuler(rotation, Math.PI * 0.5, -angle, phase + elapsed * 0.4, 'XYZ');
      return {
        position: [
          CENTER[0] + Math.cos(angle) * 3.35,
          CENTER[1] + Math.sin(elapsed * 0.65 + phase) * 0.55,
          CENTER[2] + Math.sin(angle) * 3.35,
        ],
        scale: [0.65, 0.65, 0.65],
      };
    }
  }
}

export function guid(value: string): AssetGuidType {
  const parsed = AssetGuid.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

export function resonanceMaterial(
  baseColor: readonly [number, number, number, number],
  emissive: readonly [number, number, number],
  emissiveIntensity: number,
  metallic: number,
  roughness: number,
): MaterialAsset {
  const projected = Materials.standard({
    baseColor,
    emissive,
    emissiveIntensity,
    metallic,
    roughness,
    queue: 2000,
  }) as Extract<MaterialAsset, { readonly parent?: never }>;
  // Resonance intentionally uses only its Forward + ShadowCaster lanes. The
  // Standard factory remains the sole producer of the Surface module slot.
  return {
    ...projected,
    ...(projected.passes === undefined
      ? {}
      : {
          passes: projected.passes.filter((pass) => pass.name !== 'deferred') as [
            MaterialPass,
            ...MaterialPass[],
          ],
        }),
  };
}

export function bindMaterialSlots(
  mesh: MeshAsset,
  slots: readonly { readonly name: string; readonly sourceKey: string; readonly material: AssetGuidType }[],
): MeshAsset {
  if (slots.length === 0) throw new TypeError('a generated mesh requires at least one material slot');
  if (slots.length === 1) {
    const slot = slots[0];
    if (slot === undefined) throw new TypeError('material slot declaration is unavailable');
    return {
      ...mesh,
      submeshes: mesh.submeshes.map((submesh) => ({ ...submesh, materialSlot: 0 })),
      materialSlots: [
        { slotName: slot.name, sourceKey: slot.sourceKey, defaultMaterial: slot.material },
      ],
    };
  }
  const indexCount = mesh.indices?.length ?? 0;
  const split = Math.floor(indexCount / 6) * 3;
  return {
    ...mesh,
    submeshes: [
      {
        topology: 'triangle-list',
        indexOffset: 0,
        indexCount: split,
        vertexCount: mesh.vertices.length / 12,
        materialSlot: 0,
      },
      {
        topology: 'triangle-list',
        indexOffset: split,
        indexCount: indexCount - split,
        vertexCount: mesh.vertices.length / 12,
        materialSlot: 1,
      },
    ],
    materialSlots: slots.map((slot) => ({
      slotName: slot.name,
      sourceKey: slot.sourceKey,
      defaultMaterial: slot.material,
    })),
  };
}

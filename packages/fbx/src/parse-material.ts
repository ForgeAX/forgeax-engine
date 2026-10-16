// parse-material.ts — FBX JSON POD to MaterialPod bridge (t40).
//
// Material mapping priority (plan-strategy §D-3):
//  1. StingrayPBS → channels mapped directly (baseColor/metallic/roughness)
//  2. Phong        → Family A formula: roughness = 1 - sqrt(shininess/100)
//                    baseColor = diffuse, metallic = 0
//  3. Lambert      → same formula as Phong (max_gloss=100 default)
//  4. Fallback     → default grey PBR: baseColor=[0.5,0.5,0.5], metal=0, rough=0.5

import type { MaterialPod } from '@forgeax/engine-types';

/** JSON shape emitted by binding.cc WriteMaterials for a single material. */
export interface FbxRawMaterial {
  readonly name?: string;
  readonly kind: 'stingray-pbs' | 'phong' | 'lambert' | 'fallback';
  readonly baseColor?: readonly [number, number, number];
  readonly diffuse?: readonly [number, number, number];
  readonly shininess?: number;
  readonly specular?: readonly [number, number, number];
  readonly stingrayProps?: {
    readonly baseColor?: readonly [number, number, number];
    readonly metallic?: number;
    readonly roughness?: number;
    readonly emissive?: readonly [number, number, number];
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Family A formula: roughness = 1 - sqrt(shininess / maxGloss), clamped [0, 1]. */
function phongRoughness(shininess: number, maxGloss = 100): number {
  return clamp(1 - Math.sqrt(shininess / maxGloss), 0, 1);
}

/**
 * Parse a single FBX raw material JSON node into a MaterialPod.
 *
 * The caller (fbx-importer.ts) iterates the top-level `materials` array
 * from the C++ binding JSON output.
 */
export function parseMaterial(raw: FbxRawMaterial, sourceIndex: number): MaterialPod {
  void sourceIndex; // reserved for future cross-referencing

  switch (raw.kind) {
    case 'stingray-pbs': {
      const sp = raw.stingrayProps ?? {};
      return {
        ...(raw.name !== undefined && { name: raw.name }),
        baseColorFactor: [
          sp.baseColor?.[0] ?? 0.5,
          sp.baseColor?.[1] ?? 0.5,
          sp.baseColor?.[2] ?? 0.5,
          1,
        ],
        metallicFactor: sp.metallic ?? 0,
        roughnessFactor: sp.roughness ?? 0.5,
      };
    }

    case 'phong': {
      const d = raw.diffuse ?? raw.baseColor ?? [0.5, 0.5, 0.5];
      const gloss = raw.shininess ?? 100;
      return {
        ...(raw.name !== undefined && { name: raw.name }),
        baseColorFactor: [d[0] ?? 0.5, d[1] ?? 0.5, d[2] ?? 0.5, 1],
        metallicFactor: 0,
        roughnessFactor: phongRoughness(gloss),
      };
    }

    case 'lambert': {
      const d = raw.diffuse ?? raw.baseColor ?? [0.5, 0.5, 0.5];
      return {
        ...(raw.name !== undefined && { name: raw.name }),
        baseColorFactor: [d[0] ?? 0.5, d[1] ?? 0.5, d[2] ?? 0.5, 1],
        metallicFactor: 0,
        roughnessFactor: 0.5, // lambert has no specular → default roughness
      };
    }

    default: {
      // fallback: no recognized material type
      return {
        baseColorFactor: [0.5, 0.5, 0.5, 1],
        metallicFactor: 0,
        roughnessFactor: 0.5,
      };
    }
  }
}

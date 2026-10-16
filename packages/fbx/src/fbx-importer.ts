// fbx-importer.ts — TS wrapper around the ufbx WASM parser.

import {
  type ImportContext,
  type Importer,
  type ImportResult,
  readConservativeAnimatedBounds,
  type SkeletonPod,
} from '@forgeax/engine-types';
import { deriveFbxAnimatedBounds } from './animated-bounds';
import { fbxErr } from './errors.js';
import { parseFbxLodGroup } from './lod/parse-lod-group.js';
import {
  type FbxRawAnimDoc,
  parseAnimationClips,
  resolveAnimationTargetIds,
} from './parse-animation-clip.js';
import { type FbxRawMaterial, parseMaterial } from './parse-material.js';
import { type FbxRawDocument, type FbxRawMesh, parseMesh } from './parse-mesh.js';
import { type FbxRawLodGroup, type FbxRawNodes, parseScene } from './parse-scene.js';
import { type FbxRawSkeletonDoc, parseSkeleton } from './parse-skeleton.js';
import { type FbxRawSkinDoc, parseSkin } from './parse-skin.js';
import { parseTextures } from './parse-texture.js';
import { deriveFbxShadowCapsules } from './shadow-capsules';
import { toAssetPack } from './to-asset-pack.js';
import { initFbxWasm, parseFbx } from './wasm.js';

export interface FbxSourceKeyOutput {
  readonly kind: string;
  readonly name?: string;
}

export type FbxSourceKeyResult =
  | { readonly ok: true; readonly keys: readonly string[] }
  | {
      readonly ok: false;
      readonly code: 'missing-source-key' | 'duplicate-source-key' | 'ambiguous-source-key';
    };

/** Derive FBX output identity from producer semantics, never from sourceIndex. */
export function sourceKeyForFbxOutput(output: FbxSourceKeyOutput): string | undefined {
  const kind = output.kind.trim();
  if (kind.length === 0) return undefined;
  const name = output.name?.trim();
  return name === undefined || name.length === 0 ? `fbx:${kind}` : `fbx:${kind}:${name}`;
}

export function deriveFbxSourceKeys(outputs: readonly FbxSourceKeyOutput[]): FbxSourceKeyResult {
  const keys = outputs.map(sourceKeyForFbxOutput);
  if (keys.some((key) => key === undefined)) return { ok: false, code: 'missing-source-key' };
  const seen = new Set<string>();
  for (const [index, key] of keys.entries()) {
    if (key === undefined) continue;
    if (seen.has(key)) {
      return {
        ok: false,
        code: outputs[index]?.name === undefined ? 'ambiguous-source-key' : 'duplicate-source-key',
      };
    }
    seen.add(key);
  }
  return { ok: true, keys: keys as string[] };
}

/**
 * Apply the explicit sidecar producer row when an FBX source cannot carry
 * ForgeaX extras. Missing or malformed rows preserve the parsed raw value (or
 * no bounds), so the renderer never receives a guessed bind-pose AABB.
 */
export function applyFbxImportSettingsBounds(
  skeleton: SkeletonPod,
  importSettings: Readonly<Record<string, unknown>>,
): SkeletonPod {
  const bounds = readConservativeAnimatedBounds(importSettings, 0);
  return bounds === undefined ? skeleton : { ...skeleton, bounds };
}

export const fbxImporter: Importer = {
  key: 'fbx',

  async import(ctx: ImportContext): Promise<ImportResult> {
    // ufbx WASM path: read raw FBX bytes via the import context (browser +
    // Node both resolve through readSource), then parse in-memory. No native
    // addon / SDK build step (the WASM module self-loads its .wasm).
    const read = await ctx.readSource();
    if (!read.ok) {
      const wrapper = new Error(`fbx-source-unreadable: ${ctx.source}`);
      (wrapper as { cause?: unknown }).cause = read.error;
      throw wrapper;
    }

    await initFbxWasm();
    const jsonStr = parseFbx(read.value);
    const doc = JSON.parse(jsonStr) as FbxRawDocument &
      FbxRawSkeletonDoc &
      FbxRawSkinDoc &
      FbxRawAnimDoc;

    // NURBS / patch fail-fast: the bridge emits an error envelope for
    // unsupported surface types (charter P3 explicit failure).
    const maybeError = doc as unknown as {
      error?: { code: string; meshType: string; meshName: string };
    };
    if (maybeError.error?.code === 'fbx-mesh-type-unsupported') {
      const e = fbxErr('fbx-mesh-type-unsupported', {
        meshType: maybeError.error.meshType as 'nurbs' | 'patch',
        meshName: maybeError.error.meshName,
      });
      // The Importer interface returns Promise<ImportedAsset[]> (not Result),
      // so structural FbxError cannot flow through the import-runner's typed
      // error return. Throw a plain Error with the code in the message so
      // AI users can grep import-internal-error.detail.reason for the
      // 'fbx-mesh-type-unsupported' substring; the structural error rides on
      // `.cause`.
      const wrapper = new Error(`${e.code}: ${e.expected}`);
      (wrapper as { cause?: unknown }).cause = e;
      throw wrapper;
    }

    const rawMeshes: readonly FbxRawMesh[] = doc.meshes ?? [];
    const meshes = rawMeshes.map((raw, i) => parseMesh(raw, i));

    const scene = parseScene(doc as unknown as FbxRawNodes);
    const rawLodGroups =
      (doc as unknown as { lodGroups?: readonly FbxRawLodGroup[] }).lodGroups ?? [];
    const lodGroups = [];
    for (const rawGroup of rawLodGroups) {
      const parsed = parseFbxLodGroup(rawGroup);
      if (!parsed.ok) {
        const wrapper = new Error(`${parsed.error.code}: ${parsed.error.expected}`);
        (wrapper as { cause?: unknown }).cause = parsed.error;
        throw wrapper;
      }
      lodGroups.push(parsed.value);
    }

    const texturesModule = doc as unknown as { textures?: readonly unknown[] };
    const textures = parseTextures({ textures: texturesModule.textures as never });

    const materialDocs =
      (doc as unknown as { materials?: readonly FbxRawMaterial[] }).materials ?? [];
    const materials =
      materialDocs.length > 0
        ? materialDocs.map((raw, i) => parseMaterial(raw, i))
        : [parseMaterial({ kind: 'fallback' }, 0)];

    const authoredSkeleton = applyFbxImportSettingsBounds(parseSkeleton(doc), ctx.importSettings);
    const skin = parseSkin(doc);
    const animationTargets = resolveAnimationTargetIds(
      (doc as unknown as FbxRawNodes).nodes ?? [],
      doc.clips ?? [],
    );
    if (!animationTargets.ok) {
      const wrapper = new Error(
        `${animationTargets.error.code}: ${animationTargets.error.expected}`,
      );
      (wrapper as { cause?: unknown }).cause = animationTargets.error;
      throw wrapper;
    }
    const animationClips = parseAnimationClips(doc);
    const skeleton = deriveFbxShadowCapsules(
      deriveFbxAnimatedBounds(authoredSkeleton, doc as typeof doc & FbxRawNodes, animationClips),
      doc,
    );
    const standardMaterialGuid =
      typeof ctx.importSettings?.standardMaterialGuid === 'string'
        ? ctx.importSettings.standardMaterialGuid
        : undefined;

    return {
      ok: true,
      value: {
        assets: toAssetPack({
          meshCollision: ctx.importSettings.meshCollision,
          meshes,
          scene,
          materials,
          textures,
          skeleton,
          skin,
          animationClips,
          subAssets: ctx.subAssets,
          ...(standardMaterialGuid === undefined ? {} : { standardMaterialGuid }),
          ...(ctx.sourceOverrides === undefined ? {} : { sourceOverrides: ctx.sourceOverrides }),
          ...(lodGroups.length === 0 ? {} : { lodGroups }),
        }),
        sourceDependencies: [],
      },
    };
  },
};

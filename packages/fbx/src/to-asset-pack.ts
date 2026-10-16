import { packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { cookMeshCollision } from '@forgeax/engine-import';
// to-asset-pack.ts — aggregate parsed sub-assets into ImportedAsset[] (t31).
//
// GUID import-stable iron law: GUIDs come from `ctx.subAssets[]` (the external
// meta), never minted here. Each parsed POD is matched to its declared GUID by
// (kind, sourceIndex); a parsed asset that no sub-asset declares is dropped so
// the produced set stays a subset of the declared set (mirrors gltfImporter).
// The import-runner then validates produced == declared and rejects mismatches.

import { deriveAnimationTargetId } from '@forgeax/engine-animation/target-id';
import { packMeshBin } from '@forgeax/engine-import/mesh-bin';
import { box3 } from '@forgeax/engine-math';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type {
  AnimationClipPod,
  AssetGuid as AssetGuidType,
  AssetRef,
  ImportedAsset,
  MaterialAsset,
  MaterialPod,
  MeshAsset,
  MeshLodLevel,
  MeshMaterialSlot,
  MeshMaterialSlotTopologyEntry,
  MeshPod,
  SceneAsset,
  ScenePod,
  SkeletonPod,
  SkinPod,
  SourceOverrideMap,
  TexturePod,
} from '@forgeax/engine-types';
import {
  IMPORT_ERROR_HINTS,
  ImportError,
  reconcileMeshMaterialSlotTopology,
  resolveMeshMaterialSlotDefaultGuid,
  standardMaterialParameters,
  standardSurfaceParameters,
} from '@forgeax/engine-types';
import type { FbxLodGroupPod } from './lod/parse-lod-group.js';
import { projectFbxLodMeta } from './lod/project-meta.js';
import { buildFbxNodePaths } from './parse-scene.js';

type SubAsset = {
  readonly guid: string;
  readonly sourceIndex: number;
  readonly kind: string;
  readonly sourceKey?: string;
};

/** Resolve the meta-declared GUID for a parsed (kind, sourceIndex) pair. */
function makeGuidResolver(
  subAssets: readonly SubAsset[],
): (kind: string, sourceIndex: number) => string | undefined {
  const byKey = new Map<string, string>();
  for (const sub of subAssets) byKey.set(`${sub.kind}:${sub.sourceIndex}`, sub.guid);
  return (kind, sourceIndex) => byKey.get(`${kind}:${sourceIndex}`);
}

export function buildMeshAsset(
  pod: MeshPod,
  guid: string,
  influences?: readonly { jointIndices: Uint16Array; jointWeights: Float32Array }[],
  materialContext: {
    readonly guidByIndex?: ReadonlyMap<number, string>;
    readonly nameByIndex?: ReadonlyMap<number, string>;
    readonly sourceKeyByIndex?: ReadonlyMap<number, string>;
    readonly previousMaterialSlots?: readonly MeshMaterialSlotTopologyEntry[];
    readonly materialSlotDefaultOverrides?: Readonly<Record<string, string | null>>;
    readonly meshSourceKey?: string;
    readonly lods?: readonly MeshLodLevel[];
    readonly meshCollision?: unknown;
  } = {},
): ImportedAsset {
  const vc = pod.vertices.length / 3;
  const n = pod.attributes.NORMAL as Float32Array | undefined;
  // feat-20260629-multi-uv-set-support m1-w6: scan all TEXCOORD_n sets
  // (n in [0,7]) from MeshPod.attributes. TEXCOORD_0 -> uv (set 0),
  // TEXCOORD_n for n>=1 -> uvN attribute. >8 sets truncated per D-6.
  // uvSetCount = max(n) + 1 (not count of keys) so sparse sets (TEXCOORD_0+TEXCOORD_2
  // without TEXCOORD_1) still get correct interleaved stride with zero-filled gap.
  let uvSetCount = 1; // always at least 1 (uv slot in interleaved)
  for (const key of Object.keys(pod.attributes)) {
    if (key.startsWith('TEXCOORD_')) {
      const n = Number(key.slice('TEXCOORD_'.length));
      if (Number.isFinite(n) && n >= 0 && n <= 7) {
        uvSetCount = Math.max(uvSetCount, n + 1);
      }
    }
  }

  const u = pod.attributes.TEXCOORD_0 as Float32Array | undefined;

  const skinned = influences !== undefined && influences.length === vc && vc > 0;
  const skinIndexAttr = skinned ? new Uint16Array(vc * 4) : undefined;
  const skinWeightAttr = skinned ? new Float32Array(vc * 4) : undefined;
  if (skinIndexAttr !== undefined && skinWeightAttr !== undefined) {
    for (let i = 0; i < vc; i++) {
      for (let lane = 0; lane < 4; lane++) {
        skinIndexAttr[i * 4 + lane] = influences?.[i]?.jointIndices[lane] ?? 0;
        skinWeightAttr[i * 4 + lane] = influences?.[i]?.jointWeights[lane] ?? 0;
      }
    }
  }

  // Keep source UV presence sparse; only the portable vertex layout fills gaps.
  const extraUvAttrs: Record<string, Float32Array> = {};
  for (let k = 1; k < uvSetCount; k++) {
    const source = pod.attributes[`TEXCOORD_${k}`] as Float32Array | undefined;
    if (source !== undefined) {
      extraUvAttrs[`uv${k}`] = Float32Array.from({ length: vc * 2 }, (_, i) => source[i] ?? 0);
    }
  }

  const attributes: MeshAsset['attributes'] = {
    position: pod.vertices,
    normal: n ?? new Float32Array(vc * 3).fill(0),
    uv: u ?? new Float32Array(vc * 2).fill(0),
    tangent: new Float32Array(vc * 4).fill(0).map((_, i) => (i % 4 === 0 || i % 4 === 3 ? 1 : 0)),
    ...(skinIndexAttr ? { skinIndex: skinIndexAttr } : {}),
    ...(skinWeightAttr ? { skinWeight: skinWeightAttr } : {}),
    ...extraUvAttrs,
  };

  const wireAttributes = { ...attributes } as Record<string, Float32Array | Uint16Array>;
  for (let k = 1; k < uvSetCount; k++) {
    wireAttributes[`uv${k}`] ??= new Float32Array(vc * 2);
  }
  const packed = packInterleavedVertexAttributes(wireAttributes, vc);
  if (!packed.ok) throw packed.error;

  const materialSlots: MeshMaterialSlot[] = [];
  const slotByMaterial = new Map<number | null, number>();
  const usedNames = new Set<string>();
  const uniqueName = (raw: string): string => {
    const base = raw.trim() || 'Material';
    let candidate = base;
    let suffix = 2;
    while (usedNames.has(candidate)) candidate = `${base}_${suffix++}`;
    usedNames.add(candidate);
    return candidate;
  };
  const materialSlotFor = (materialIndex: number | null): number => {
    const existing = slotByMaterial.get(materialIndex);
    if (existing !== undefined) return existing;
    const guidString =
      materialIndex === null ? undefined : materialContext.guidByIndex?.get(materialIndex);
    const parsed = guidString === undefined ? undefined : AssetGuid.parse(guidString);
    const slotIndex = materialSlots.length;
    materialSlots.push({
      slotName: uniqueName(
        materialIndex === null
          ? 'Default'
          : (materialContext.nameByIndex?.get(materialIndex) ?? `Material_${materialIndex}`),
      ),
      sourceKey:
        materialIndex === null
          ? 'fbx:default'
          : (materialContext.sourceKeyByIndex?.get(materialIndex) ??
            `fbx:material:${materialIndex}`),
      ...(parsed?.ok ? { defaultMaterial: parsed.value } : {}),
    });
    slotByMaterial.set(materialIndex, slotIndex);
    return slotIndex;
  };
  const currentMesh: MeshAsset = {
    kind: 'mesh',
    vertices: packed.value.vertices,
    ...(pod.indices ? { indices: pod.indices } : {}),
    aabb: box3.fromPositions(box3.create(), pod.vertices),
    attributes,
    ...(pod.morphTargets === undefined
      ? {}
      : {
          morphTargets: pod.morphTargets.map((target) => ({
            ...(target.position === undefined
              ? {}
              : { position: new Float32Array(target.position) }),
            ...(target.normal === undefined ? {} : { normal: new Float32Array(target.normal) }),
            ...(target.tangent === undefined ? {} : { tangent: new Float32Array(target.tangent) }),
          })),
        }),
    ...(pod.morphWeights === undefined ? {} : { morphWeights: new Float32Array(pod.morphWeights) }),
    submeshes: pod.submeshes.map((sm) => ({
      indexOffset: sm.indexOffset,
      indexCount: sm.indexCount,
      vertexCount: vc,
      topology: sm.topology,
      materialSlot: materialSlotFor(sm.materialIndex),
    })),
    materialSlots,
    ...(materialContext.lods === undefined ? {} : { lods: materialContext.lods }),
  };

  const reconciled = reconcileMeshMaterialSlotTopology(
    currentMesh.materialSlots.map((slot) => ({
      slotName: slot.slotName,
      ...(slot.sourceKey === undefined ? {} : { sourceKey: slot.sourceKey }),
      ...(slot.defaultMaterial === undefined
        ? {}
        : { defaultMaterialGuid: AssetGuid.format(slot.defaultMaterial) }),
    })),
    materialContext.previousMaterialSlots,
  );
  if (!reconciled.ok) {
    throw new ImportError({
      code: 'mesh-material-slot-topology-change',
      expected: `unambiguous material slot identity for mesh ${guid}`,
      hint: IMPORT_ERROR_HINTS['mesh-material-slot-topology-change'],
      detail: {
        meshGuid: guid,
        ...(materialContext.meshSourceKey === undefined
          ? {}
          : { meshSourceKey: materialContext.meshSourceKey }),
        previousIndices: reconciled.error.previousIndices,
        nextIndices: reconciled.error.nextIndices,
      },
    });
  }
  const sourceMesh: MeshAsset = {
    ...currentMesh,
    submeshes: currentMesh.submeshes.map((submesh) => ({
      ...submesh,
      materialSlot: reconciled.currentToStableSlot[submesh.materialSlot] as number,
    })),
    materialSlots: reconciled.slots.map((slot, stableIndex) => {
      const active = reconciled.currentToStableSlot.includes(stableIndex);
      const effectiveDefault = resolveMeshMaterialSlotDefaultGuid(
        slot,
        active
          ? materialContext.materialSlotDefaultOverrides?.[slot.sourceKey ?? slot.slotName]
          : undefined,
      );
      const parsed = effectiveDefault === undefined ? undefined : AssetGuid.parse(effectiveDefault);
      return {
        slotName: slot.slotName,
        ...(slot.sourceKey === undefined ? {} : { sourceKey: slot.sourceKey }),
        ...(active && parsed?.ok ? { defaultMaterial: parsed.value } : {}),
      };
    }),
  };

  const mesh = cookMeshCollision(sourceMesh, materialContext.meshCollision).unwrap();

  const wireMesh: MeshAsset = { ...mesh, attributes: wireAttributes };

  const refs: AssetRef[] = [];
  const seenRefs = new Set<string>();
  for (let slotIndex = 0; slotIndex < mesh.materialSlots.length; slotIndex++) {
    const defaultMaterial = mesh.materialSlots[slotIndex]?.defaultMaterial;
    const materialGuid =
      defaultMaterial === undefined ? undefined : AssetGuid.format(defaultMaterial);
    if (materialGuid !== undefined && !seenRefs.has(materialGuid.toLowerCase())) {
      seenRefs.add(materialGuid.toLowerCase());
      refs.push({
        guid: materialGuid,
        sourceField: { fieldName: 'materialSlots', arrayIndex: slotIndex },
      });
    }
  }
  for (const [lodIndex, level] of (mesh.lods ?? []).entries()) {
    const lodGuid = AssetGuid.format(level.mesh);
    if (!seenRefs.has(lodGuid.toLowerCase())) {
      seenRefs.add(lodGuid.toLowerCase());
      refs.push({ guid: lodGuid, sourceField: { fieldName: 'lods', arrayIndex: lodIndex } });
    }
  }

  return {
    guid,
    kind: 'mesh',
    ...(pod.name !== undefined ? { name: pod.name } : {}),
    payload: mesh,
    refs,
    artifacts: {
      body: {
        mediaType: 'application/x-forgeax-mesh',
        assetCodec: { name: 'mesh-binary', version: '5' },
        bytes: (() => {
          const packed = packMeshBin(
            wireMesh as never,
            materialContext.meshSourceKey ?? 'fbx://mesh',
            refs.map((ref) => ref.guid),
          );
          if (!packed.ok) {
            throw new ImportError({
              code: 'import-internal-error',
              expected: 'mesh-bin v5 producer to accept the canonical FBX mesh projection',
              hint: 're-cook the FBX source with its Meta sidecar after fixing the mesh payload',
              detail: { reason: `${packed.error.code}: ${packed.error.actual}` },
            });
          }
          return packed.value;
        })(),
      },
    },
  };
}

function buildMaterialAsset(
  pod: MaterialPod,
  guid: string,
  skinned = false,
  standardMaterialGuid?: string,
): ImportedAsset {
  // A material consumed by a skinned mesh must select the pbr-skin shader so the
  // runtime PSO chain (LayoutKind 'pbr-skin' + 18-float vertex layout + joint
  // palette) is exercised; the render-system fail-fasts otherwise (mirror of
  // gltfImporter's `skinned` routing).
  const values = {
    baseColor: pod.baseColorFactor as readonly [number, number, number, number],
    metallic: pod.metallicFactor,
    roughness: pod.roughnessFactor,
  };
  // A Meta-declared Standard root is an inheritance edge, not a second
  // material contract. Parent-bearing children publish only their authored
  // values and parent GUID; the MaterialTable resolver supplies the root
  // passes, parameters, and surface module. Leaf FBX materials keep the
  // historical standalone pass for sources without a canonical root.
  const mat: MaterialAsset =
    standardMaterialGuid === undefined
      ? {
          kind: 'material',
          colorSpace: 'linear',
          parameters: standardSurfaceParameters(
            standardMaterialParameters(new Set(Object.keys(values))),
          ),
          passes: [
            {
              name: 'Forward',
              program: {
                module: skinned ? 'forgeax::pbr-skin' : 'forgeax::default-standard-pbr',
              },
              renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
            },
          ],
          values,
        }
      : {
          kind: 'material',
          parent: standardMaterialGuid as unknown as AssetGuidType,
          values,
        };
  return {
    guid,
    kind: 'material',
    ...(pod.name !== undefined ? { name: pod.name } : {}),
    payload: mat,
    refs:
      standardMaterialGuid === undefined
        ? []
        : [{ guid: standardMaterialGuid, sourceField: { fieldName: 'parent' } }],
    artifacts: {},
  };
}

interface SceneBuildContext {
  /** mesh sourceIndex -> MeshFilter.assetHandle (a scene refs[] index). */
  readonly meshHandleByIndex: ReadonlyMap<number, number>;
  /** mesh sourceIndex carrying the skin deformer; null when the scene has no skin. */
  readonly skinnedMeshIndex: number | null;
  /** Skin.skeleton handle (a scene refs[] index); undefined when no skeleton. */
  readonly skeletonHandle: number | undefined;
  /** Scene refs[]: [mesh..., skeleton..., skin...] GUIDs. */
  readonly refs: readonly string[];
  /**
   * Skin GUIDs (inline strings) injected into the SceneAsset payload and the
   * scene envelope's refs[] so the runtime recursive loadByGuid walk pulls each
   * SkinAsset on the browser-async pack-fetch path. Mirrors gltf-importer:
   * stored as GUID strings (the on-disk round-trip + parseScenePayload's
   * resolveSkinGuids accept both shapes).
   */
  readonly skinGuids: readonly string[];
  readonly animationTargetIds: ReadonlySet<string>;
  readonly morphWeightsByMeshIndex: ReadonlyMap<
    number,
    { readonly targetCount: number; readonly weights?: Float32Array }
  >;
}

function buildSceneAsset(pod: ScenePod, guid: string, ctx: SceneBuildContext): ImportedAsset {
  // ChildOf wiring: ScenePod.children[] holds flattened-array indices; invert to
  // a parent map so each entity emits ChildOf { parent } (localId === array idx).
  const parentOf = new Map<number, number>();
  for (let i = 0; i < pod.entities.length; i++) {
    const e = pod.entities[i];
    if (!e) continue;
    for (const childIdx of e.children ?? []) parentOf.set(childIdx, i);
  }
  const targetIdByEntity = new Map<number, string>();
  const nodePaths = buildFbxNodePaths(pod.entities);
  for (let index = 0; index < nodePaths.length; index++) {
    const path = nodePaths[index];
    if (path === undefined || !path.ok) continue;
    const targetId = deriveAnimationTargetId(path.value);
    if (ctx.animationTargetIds.has(targetId)) targetIdByEntity.set(index, targetId);
  }

  const legacyEntities = pod.entities.map((e, idx) => {
    const components: Record<string, Record<string, unknown>> = {
      Transform: {
        pos: [e.transform.translation[0], e.transform.translation[1], e.transform.translation[2]],
        // Quaternion component order [x, y, z, w] (E6).
        quat: [
          e.transform.rotation[0],
          e.transform.rotation[1],
          e.transform.rotation[2],
          e.transform.rotation[3],
        ],
        scale: [e.transform.scale[0], e.transform.scale[1], e.transform.scale[2]],
      },
    };

    // Name is required for postSpawnResolveJoints to match SkinAsset.jointPaths
    // against the spawned subtree (the skeleton joint resolution path).
    if (e.name) components.Name = { value: e.name };
    const targetId = targetIdByEntity.get(idx);
    if (targetId !== undefined) components.AnimationTargetId = { value: targetId };

    const parent = parentOf.get(idx);
    if (parent !== undefined) components.ChildOf = { parent };

    if (e.meshIndex !== null) {
      const meshHandle = ctx.meshHandleByIndex.get(e.meshIndex);
      if (meshHandle !== undefined) components.MeshFilter = { assetHandle: meshHandle };

      components.MeshRenderer = { materials: [] };
      const morph = ctx.morphWeightsByMeshIndex.get(e.meshIndex);
      if (morph !== undefined && morph.targetCount > 0) {
        const weights = morph.weights ?? new Float32Array(morph.targetCount);
        if (weights.length !== morph.targetCount) {
          throw new Error('fbxScene: MorphWeights length does not match morph targets');
        }
        components.MorphWeights = { weights: Array.from(weights) };
      }
      // Skinned mesh node carries Skin { skeleton: <handle> }; instantiate
      // resolves the handle and postSpawnResolveJoints fills Skin.joints[].
      if (ctx.skinnedMeshIndex === e.meshIndex && ctx.skeletonHandle !== undefined) {
        components.Skin = { skeleton: ctx.skeletonHandle };
      }
    }

    return { index: idx, components };
  });

  const entities: Record<string, { readonly components: Record<string, Record<string, unknown>> }> =
    {};
  for (const entity of legacyEntities) {
    const components = { ...entity.components };
    const childOf = components.ChildOf;
    if (childOf !== undefined && typeof childOf.parent === 'number') {
      components.ChildOf = { ...childOf, parent: `node-${childOf.parent}` };
    }
    entities[`node-${entity.index}`] = { components };
  }

  const scene: SceneAsset = {
    kind: 'scene',
    entities,
    ...(ctx.skinGuids.length > 0 ? { skinGuids: ctx.skinGuids } : {}),
  } as SceneAsset;

  return {
    guid,
    kind: 'scene',
    ...(pod.name !== undefined ? { name: pod.name } : {}),
    payload: scene,
    refs: ctx.refs.map((guid) => ({ guid })),
    artifacts: {},
  };
}

// M3: TextureAsset requires decoded pixel data — deferred to M4.
// TexturePod.filePath is preserved for diagnostics during M3.
function buildTextureNote(_pod: TexturePod, _guid: string): ImportedAsset {
  // Produce a minimal placeholder; real texture import (decode + upload)
  // lands with M4 material parsing.
  return {
    guid: _guid,
    kind: 'texture',
    ...(_pod.name !== undefined ? { name: _pod.name } : {}),
    payload: {} as never,
    refs: [],
    artifacts: {},
  };
}

export function toAssetPack(params: {
  readonly meshes: readonly MeshPod[];
  readonly meshCollision?: unknown;
  readonly scene: ScenePod;
  readonly materials: readonly MaterialPod[];
  readonly textures: readonly TexturePod[];
  readonly skeleton: SkeletonPod;
  readonly skin: SkinPod;
  readonly animationClips: readonly AnimationClipPod[];
  readonly subAssets: readonly SubAsset[];
  /** Meta-owned canonical Standard root for imported material inheritance. */
  readonly standardMaterialGuid?: string;
  readonly sourceOverrides?: SourceOverrideMap;
  readonly lodGroups?: readonly FbxLodGroupPod[];
}): readonly ImportedAsset[] {
  const assets: ImportedAsset[] = [];
  const guidOf = makeGuidResolver(params.subAssets);
  const materialGuidByIndex = new Map<number, string>();
  const materialNameByIndex = new Map<number, string>();
  const materialSourceKeyByIndex = new Map<number, string>();
  for (let materialIndex = 0; materialIndex < params.materials.length; materialIndex++) {
    const materialGuid = guidOf('material', materialIndex);
    if (materialGuid !== undefined) materialGuidByIndex.set(materialIndex, materialGuid);
    const materialSourceKey = params.subAssets.find(
      (entry) => entry.kind === 'material' && entry.sourceIndex === materialIndex,
    )?.sourceKey;
    if (materialSourceKey !== undefined) {
      materialSourceKeyByIndex.set(materialIndex, materialSourceKey);
    }
    const materialName = params.materials[materialIndex]?.name;
    if (materialName !== undefined) materialNameByIndex.set(materialIndex, materialName);
  }

  // The skin deforms the (single) first mesh. Only material slots actually used
  // by that mesh are promoted to the pbr-skin shader; other FBX meshes may share
  // the document material table but remain rigid and must keep Standard PBR.
  const hasSkin = params.skin.vertexCount > 0;
  const skinnedMeshSourceIndex = hasSkin ? (params.meshes[0]?.sourceIndex ?? null) : null;
  const skinnedMaterialIndices = new Set<number>();
  if (skinnedMeshSourceIndex !== null) {
    const skinnedMesh = params.meshes.find((mesh) => mesh.sourceIndex === skinnedMeshSourceIndex);
    for (const submesh of skinnedMesh?.submeshes ?? []) {
      if (submesh.materialIndex !== null) skinnedMaterialIndices.add(submesh.materialIndex);
    }
  }

  const lodsByRootMesh = new Map<number, readonly MeshLodLevel[]>();
  for (const group of params.lodGroups ?? []) {
    const [rootMeshIndex, ...lowerMeshIndices] = group.childMeshIndices;
    if (rootMeshIndex === undefined || lowerMeshIndices.length === 0) continue;
    const rootDeclaration = params.subAssets.find(
      (entry) => entry.kind === 'mesh' && entry.sourceIndex === rootMeshIndex,
    );
    if (rootDeclaration?.sourceKey === undefined) continue;
    const levels = lowerMeshIndices.flatMap((sourceIndex) => {
      const declaration = params.subAssets.find(
        (entry) => entry.kind === 'mesh' && entry.sourceIndex === sourceIndex,
      );
      if (declaration?.guid === undefined || declaration.sourceKey === undefined) return [];
      return [{ sourceKey: declaration.sourceKey, guid: declaration.guid }];
    });
    if (levels.length !== lowerMeshIndices.length) continue;
    const previousRaw = params.sourceOverrides?.[rootDeclaration.sourceKey]?.lods;
    const previous = Array.isArray(previousRaw)
      ? previousRaw.flatMap((entry) => {
          if (entry === null || typeof entry !== 'object') return [];
          const value = entry as Record<string, unknown>;
          return typeof value.sourceKey === 'string' && typeof value.meshGuid === 'string'
            ? [
                {
                  sourceKey: value.sourceKey,
                  guid: value.meshGuid,
                  ...(typeof value.screenCoverage === 'number'
                    ? { screenCoverage: value.screenCoverage }
                    : {}),
                },
              ]
            : [];
        })
      : undefined;
    const projected = projectFbxLodMeta({
      rootSourceKey: rootDeclaration.sourceKey,
      levels,
      ...(previous === undefined ? {} : { previous }),
    });
    if (!projected.ok) {
      throw new ImportError({
        code: 'mesh-lod-contract-invalid',
        expected: 'FBX LODGroup child meshes to form a valid decreasing coverage sequence',
        hint: IMPORT_ERROR_HINTS['mesh-lod-contract-invalid'],
        detail: { reason: projected.error.reason },
      });
    }
    const parsed = projected.value.lods.flatMap((level) => {
      const guid = AssetGuid.parse(level.guid);
      return guid.ok && Number.isFinite(level.screenCoverage)
        ? [{ mesh: guid.value, screenCoverage: level.screenCoverage }]
        : [];
    });
    lodsByRootMesh.set(rootMeshIndex, parsed);
  }

  for (const mesh of params.meshes) {
    const meshDeclaration = params.subAssets.find(
      (entry) => entry.kind === 'mesh' && entry.sourceIndex === mesh.sourceIndex,
    );
    const guid = meshDeclaration?.guid;
    if (guid === undefined) continue;
    const previousRaw =
      meshDeclaration?.sourceKey === undefined
        ? undefined
        : params.sourceOverrides?.[meshDeclaration.sourceKey]?.materialSlots;
    const previousMaterialSlots = Array.isArray(previousRaw)
      ? previousRaw.filter(
          (slot): slot is MeshMaterialSlotTopologyEntry =>
            slot !== null &&
            typeof slot === 'object' &&
            !Array.isArray(slot) &&
            typeof (slot as { slotName?: unknown }).slotName === 'string',
        )
      : undefined;
    const authoredRaw =
      meshDeclaration?.sourceKey === undefined
        ? undefined
        : params.sourceOverrides?.[meshDeclaration.sourceKey]?.materialSlotDefaultOverrides;
    const materialSlotDefaultOverrides =
      authoredRaw !== null && typeof authoredRaw === 'object' && !Array.isArray(authoredRaw)
        ? Object.fromEntries(
            Object.entries(authoredRaw).filter(
              (entry): entry is [string, string | null] =>
                typeof entry[1] === 'string' || entry[1] === null,
            ),
          )
        : undefined;
    const inf = mesh.sourceIndex === skinnedMeshSourceIndex ? params.skin.influences : undefined;
    const meshLods = lodsByRootMesh.get(mesh.sourceIndex);
    assets.push(
      buildMeshAsset(mesh, guid, inf, {
        meshCollision: params.meshCollision,
        guidByIndex: materialGuidByIndex,
        nameByIndex: materialNameByIndex,
        sourceKeyByIndex: materialSourceKeyByIndex,
        ...(previousMaterialSlots === undefined ? {} : { previousMaterialSlots }),
        ...(materialSlotDefaultOverrides === undefined ? {} : { materialSlotDefaultOverrides }),
        ...(meshDeclaration?.sourceKey === undefined
          ? {}
          : { meshSourceKey: meshDeclaration.sourceKey }),
        ...(meshLods === undefined ? {} : { lods: meshLods }),
      }),
    );
  }

  for (let i = 0; i < params.materials.length; i++) {
    const mat = params.materials[i];
    if (!mat) continue;
    const guid = guidOf('material', i);
    const materialIsSkinned = skinnedMaterialIndices.has(i);
    if (guid !== undefined) {
      assets.push(buildMaterialAsset(mat, guid, materialIsSkinned, params.standardMaterialGuid));
    }
  }

  for (const tex of params.textures) {
    const guid = guidOf('texture', tex.sourceIndex);
    if (guid !== undefined) assets.push(buildTextureNote(tex, guid));
  }

  // Scene refs[] ordering (mirror of gltfImporter): only direct scene
  // dependencies live here. Mesh defaults belong to MeshAsset refs and
  // textures belong to MaterialAsset refs, so the scene concatenates
  //   [mesh GUIDs..., skeleton GUIDs..., skin GUIDs...]
  // each section in declared sourceIndex order. Build the section -> refs-index
  // maps here so buildSceneAsset can stamp the right indices.
  const declaredByKind = (kind: string): string[] =>
    params.subAssets
      .filter((s) => s.kind === kind)
      .slice()
      .sort((a, b) => a.sourceIndex - b.sourceIndex)
      .map((s) => s.guid);

  const meshGuids = declaredByKind('mesh');
  const skeletonGuids = declaredByKind('skeleton');
  const skinGuids = declaredByKind('skin');
  const sceneRefs = [...meshGuids, ...skeletonGuids, ...skinGuids];

  // mesh sourceIndex -> scene refs[] index (mesh section starts at 0).
  const meshHandleByIndex = new Map<number, number>();
  params.subAssets
    .filter((s) => s.kind === 'mesh')
    .forEach((s) => {
      const idx = meshGuids.indexOf(s.guid);
      if (idx >= 0) meshHandleByIndex.set(s.sourceIndex, idx);
    });
  // skeleton handle = first skeleton's scene refs[] index.
  const skeletonRefBase = meshGuids.length;
  const skeletonHandle = skeletonGuids.length > 0 ? skeletonRefBase : undefined;
  // Single-mesh fixtures: the skin deforms the (only) mesh node.
  const skinnedMeshIndex =
    params.skin.vertexCount > 0 ? (params.meshes[0]?.sourceIndex ?? null) : null;

  // Skeleton asset (t48). refs[] empty (skeleton is leaf data). The runtime
  // SkeletonAsset POD is { inverseBindMatrices, jointCount } — joint paths live
  // on the parallel SkinAsset (mirror of gltfImporter's emit policy). The native
  // binding derives the skeleton from the skin's clusters, so jointCount /
  // inverseBindMatrices already align 1:1 with the skin's jointPaths and the
  // per-vertex skinIndex influences (runtime requires
  // SkeletonAsset.jointCount === Skin.joints.length).
  const skeletonGuid = guidOf('skeleton', 0);
  if (params.skeleton.jointCount > 0 && skeletonGuid !== undefined) {
    const { bounds, shadowCapsules } = params.skeleton;
    assets.push({
      guid: skeletonGuid,
      kind: 'skeleton',
      payload: {
        kind: 'skeleton',
        inverseBindMatrices: params.skeleton.inverseBindMatrices,
        jointCount: params.skeleton.jointCount,
        ...(bounds === undefined ? {} : { bounds }),
        ...(shadowCapsules === undefined ? {} : { shadowCapsules }),
      } as never,
      refs: [],
      artifacts: {},
    });
  }

  // Skin asset (t49). The runtime SkinAsset POD is { skeletonGuid, jointPaths };
  // per-vertex influences live in the mesh vertex buffer, not the SkinAsset.
  // refs[] carries the skeleton GUID cross-edge (mirror of gltfImporter) so the
  // runner / runtime asset graph sees the skin->skeleton link.
  const skinGuid = guidOf('skin', 0);
  if (params.skin.vertexCount > 0 && skinGuid !== undefined) {
    assets.push({
      guid: skinGuid,
      kind: 'skin',
      payload: {
        kind: 'skin',
        skeletonGuid: skeletonGuid ?? '',
        jointPaths: params.skin.jointPaths,
      } as never,
      refs:
        skeletonGuid !== undefined
          ? [{ guid: skeletonGuid, sourceField: { fieldName: 'skeleton' } }]
          : [],
      artifacts: {},
    });
  }

  // Animation clip assets (t50)
  for (let i = 0; i < params.animationClips.length; i++) {
    const clip = params.animationClips[i];
    if (!clip) continue;
    const guid = guidOf('animation-clip', i);
    if (guid === undefined) continue;
    assets.push({
      guid,
      kind: 'animation-clip',
      payload: {
        kind: 'animation-clip',
        name: clip.name ?? `Clip${i}`,
        duration: clip.duration,
        channels: clip.channels.map((ch) => ({
          targetId: ch.targetId,
          property: ch.property,
          sampler: {
            input: Array.from(ch.sampler.input),
            output: Array.from(ch.sampler.output),
            interpolation: ch.sampler.interpolation,
          },
        })),
      } as never,
      refs: [],
      artifacts: {},
    });
  }

  const sceneGuid = guidOf('scene', 0);
  const animationTargetIds = new Set(
    params.animationClips.flatMap((clip) => clip.channels.map((channel) => channel.targetId)),
  );
  const morphWeightsByMeshIndex = new Map<
    number,
    { readonly targetCount: number; readonly weights?: Float32Array }
  >();
  for (const mesh of params.meshes) {
    const targetCount = mesh.morphTargets?.length ?? 0;
    if (targetCount > 0) {
      morphWeightsByMeshIndex.set(mesh.sourceIndex, {
        targetCount,
        ...(mesh.morphWeights === undefined
          ? {}
          : { weights: new Float32Array(mesh.morphWeights) }),
      });
    }
  }
  if (sceneGuid !== undefined) {
    assets.push(
      buildSceneAsset(params.scene, sceneGuid, {
        meshHandleByIndex,
        skinnedMeshIndex,
        skeletonHandle,
        refs: sceneRefs,
        skinGuids,
        animationTargetIds,
        morphWeightsByMeshIndex,
      }),
    );
  }

  // XOR identity rule (aligned with the glTF importer): a single-asset package
  // derives its name from the package path, so the stored entry name is dropped.
  // Only multi-asset packages keep per-entry stored names. FBX is almost always
  // multi-asset (a scene asset is always emitted), so this strips name only in
  // the degenerate single-asset case.
  if (assets.length === 1) {
    const only = assets[0];
    if (only && 'name' in only) {
      const { name: _dropped, ...rest } = only;
      assets[0] = rest;
    }
  }

  return assets;
}

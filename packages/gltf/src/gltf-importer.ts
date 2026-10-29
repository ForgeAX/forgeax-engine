import {
  applyMeshMaterialSlotTopology,
  meshMaterialSlotsToTopology,
} from '@forgeax/engine-geometry';
import { cookMeshCollision } from '@forgeax/engine-import';
import type { ImportSubAsset } from '@forgeax/engine-types';
import { groupMeshPrimitives } from './mesh-primitives';
// gltf-importer.ts - the build-time gltfImporter (feat-20260603-asset-import-loader-injection M2 / w19,
// extended in feat-20260608 M3 w14 with the texture pipeline: three image
// source paths funnelled through the ImportContext decodeImage seam).
//
// The `{ key: 'gltf', import }` Importer the @forgeax/engine-import runner
// dispatches a `*.meta.json` with `importer: 'gltf'` to. It reads the source
// bytes via `ctx.readSource()`, parses them to a `GltfDoc` (parseGltf / parseGlb),
// and converts each declared sub-asset (mesh / material / scene / texture /
// skin / animation-clip) into an `ImportedAsset` POD stamped with the
// meta-declared GUID (GUID import-stable iron law: GUIDs come from
// `ctx.subAssets[]`, never minted here).
//
// Texture pipeline (M3 D-1 / D-3 / D-6, requirements AC-08 / 09 / 10 / 11 /
// 12 / 13): for every glTF `images[]` row the importer extracts the raw
// PNG / JPEG bytes from one of three sources (bufferView slice in
// .glb / data: URI in .gltf / external URI sibling read), funnels them
// through `ctx.decodeImage` (the only seam to @forgeax/engine-image — a
// grep gate enforces zero static `from '@forgeax/engine-image'` lines in
// this package), and emits a `kind: 'texture'` ImportedAsset stamped with
// the meta-declared GUID. The colorSpace is pre-derived per-image by
// `deriveTextureColorSpace` (D-3 walk of material slot bindings).
//
// Material refs[]: each material's emitted ImportedAsset carries the GUIDs
// of every texture sub-asset its slots reference, so the runner builds the
// scene/material -> texture cross-edge needed by AC-11 / AC-19.
//
// Sub-asset -> GUID mapping: `ctx.subAssets[]` carries one entry per declared
// sub-asset with `{ guid, sourceIndex, kind }`. The importer indexes into the
// parsed doc by (kind, sourceIndex) and emits the corresponding POD under the
// declared GUID. A sub-asset kind with no doc counterpart (or a sourceIndex out
// of range) is skipped; the runner's GUID iron-law check then surfaces the
// gap as `import-produced-no-assets`. A texture sub-asset that fails byte
// extraction surfaces as `gltf-image-extract-failed` (D-6).

import { deriveDefaultLodScreenCoverages } from '@forgeax/engine-import';
import { packMeshBin } from '@forgeax/engine-import/mesh-bin';
import { AssetGuid as AssetGuidCodec } from '@forgeax/engine-pack/guid';
import {
  ANIMATION_CLIP_SAMPLES_ARTIFACT,
  encodeAnimationClipSamples,
} from '@forgeax/engine-pack/runtime';
import type {
  AssetGuid,
  AssetHandle,
  AssetRef,
  ImportContext,
  ImportedAsset,
  Importer,
  ImportResult,
  MaterialTextureValue,
  MaterialValue,
  MeshAsset,
  MeshMaterialSlotTopologyEntry,
} from '@forgeax/engine-types';
import {
  IMPORT_ERROR_HINTS,
  ImportError,
  readConservativeAnimatedBounds,
  reconcileMeshMaterialSlotTopology,
} from '@forgeax/engine-types';
import { deriveGltfAnimatedBounds } from './animated-bounds';
import {
  gltfDocToSceneAsset,
  meshIrToMeshAsset,
  toMaterialAsset,
  validateMaterialTangentInputs,
  validateMaterialUvSets,
} from './bridge.js';
import { gltfErr } from './errors.js';
import { extractImageBytes } from './extract-image-bytes.js';
import { deriveTextureColorSpace } from './image-color-space.js';
import type { GltfLodGroup } from './lod/parse-lod.js';
import { GLTF_MATERIAL_TEXTURE_SLOTS, materialTextureBinding } from './material/parse-material.js';
import { cookGltfMeshCards } from './mesh-cards';
import { cookGltfMeshDistanceField } from './mesh-distance-field';
import type { GltfDoc, GltfMaterialIr, GltfParseOptions } from './parse-gltf.js';
import { GLTF_UV_SET_COUNT, gltfMeshUvSet, parseGlb, parseGltf } from './parse-gltf.js';
import { deriveGltfShadowCapsules } from './shadow-capsules';

type ParseDocResult =
  | { readonly ok: true; readonly value: GltfDoc }
  | { readonly ok: false; readonly error: ImportError };
function isGlbBytes(source: string): boolean {
  return source.toLowerCase().endsWith('.glb');
}

function parseFailureMessage(
  prefix: string,
  error: { readonly code: string; readonly expected: string; readonly detail?: unknown },
): string {
  const detail = error.detail === undefined ? '' : ` detail=${JSON.stringify(error.detail)}`;
  return `${prefix}: ${error.code} ${error.expected}${detail}`;
}

function publishesCatalogProduct(input: {
  readonly importSettings: Readonly<Record<string, unknown>>;
}): boolean {
  return input.importSettings.geometry !== 'procedural';
}

function applyImportSettingsBounds(
  doc: GltfDoc,
  importSettings: Readonly<Record<string, unknown>>,
): GltfDoc {
  let changed = false;
  const skeletons = doc.skeletons.map((record, sourceIndex) => {
    // Source extras are the primary producer path. The sidecar row is an
    // explicit external-producer override for sources whose authoring tool
    // cannot carry ForgeaX extras; neither path derives a bind-pose AABB.
    const bounds = readConservativeAnimatedBounds(importSettings, sourceIndex);
    if (bounds === undefined || record.bounds !== undefined) return record;
    changed = true;
    return { ...record, bounds };
  });
  return changed ? { ...doc, skeletons } : doc;
}

function previousMaterialSlotTopology(
  ctx: ImportContext,
  meshSourceKey: string | undefined,
): readonly MeshMaterialSlotTopologyEntry[] | undefined {
  if (meshSourceKey === undefined) return undefined;
  const value = ctx.sourceOverrides?.[meshSourceKey]?.materialSlots;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new ImportError({
      code: 'invalid-source-override-payload',
      expected: `${meshSourceKey}.materialSlots to be an array`,
      hint: IMPORT_ERROR_HINTS['invalid-source-override-payload'],
      detail: {
        sourceKey: meshSourceKey,
        declaredSourceKeys: ctx.subAssets.flatMap((entry) => entry.sourceKey ?? []),
        reason: 'materialSlots is not an array',
      },
    });
  }
  const slots: MeshMaterialSlotTopologyEntry[] = [];
  for (const [index, raw] of value.entries()) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ImportError({
        code: 'invalid-source-override-payload',
        expected: `${meshSourceKey}.materialSlots[${index}] to be an object`,
        hint: IMPORT_ERROR_HINTS['invalid-source-override-payload'],
        detail: {
          sourceKey: meshSourceKey,
          declaredSourceKeys: ctx.subAssets.flatMap((entry) => entry.sourceKey ?? []),
          reason: `materialSlots[${index}] is not an object`,
        },
      });
    }
    const slot = raw as Record<string, unknown>;
    if (typeof slot.slotName !== 'string' || slot.slotName.trim().length === 0) {
      throw new ImportError({
        code: 'invalid-source-override-payload',
        expected: `${meshSourceKey}.materialSlots[${index}].slotName to be non-empty`,
        hint: IMPORT_ERROR_HINTS['invalid-source-override-payload'],
        detail: {
          sourceKey: meshSourceKey,
          declaredSourceKeys: ctx.subAssets.flatMap((entry) => entry.sourceKey ?? []),
          reason: `materialSlots[${index}].slotName is invalid`,
        },
      });
    }
    slots.push({
      slotName: slot.slotName,
      ...(typeof slot.sourceKey === 'string' ? { sourceKey: slot.sourceKey } : {}),
      ...(typeof slot.defaultMaterialGuid === 'string'
        ? { defaultMaterialGuid: slot.defaultMaterialGuid }
        : {}),
    });
  }
  return slots;
}

function sourceMaterialGuid(
  reference: NonNullable<MeshAsset['materialSlots'][number]['defaultMaterial']>,
): string {
  if (typeof reference === 'number')
    throw new Error('imported material defaults require source GUIDs');
  return AssetGuidCodec.format(reference);
}

function stabilizeMeshMaterialSlots(
  mesh: MeshAsset,
  ctx: ImportContext,
  meshGuid: string,
  meshSourceKey: string | undefined,
): MeshAsset {
  const reconciled = reconcileMeshMaterialSlotTopology(
    meshMaterialSlotsToTopology(mesh.materialSlots),
    previousMaterialSlotTopology(ctx, meshSourceKey),
  );
  if (!reconciled.ok) {
    throw new ImportError({
      code: 'mesh-material-slot-topology-change',
      expected: `unambiguous material slot identity for mesh ${meshGuid}`,
      hint: IMPORT_ERROR_HINTS['mesh-material-slot-topology-change'],
      detail: {
        meshGuid,
        ...(meshSourceKey === undefined ? {} : { meshSourceKey }),
        previousIndices: reconciled.error.previousIndices,
        nextIndices: reconciled.error.nextIndices,
      },
    });
  }
  const authoredDefaults =
    meshSourceKey === undefined
      ? undefined
      : ctx.sourceOverrides?.[meshSourceKey]?.materialSlotDefaultOverrides;
  if (
    authoredDefaults !== undefined &&
    (authoredDefaults === null ||
      typeof authoredDefaults !== 'object' ||
      Array.isArray(authoredDefaults))
  ) {
    throw new ImportError({
      code: 'invalid-source-override-payload',
      expected: `${meshSourceKey}.materialSlotDefaultOverrides to be an object`,
      hint: IMPORT_ERROR_HINTS['invalid-source-override-payload'],
      detail: {
        sourceKey: meshSourceKey,
        declaredSourceKeys: [],
        reason: 'materialSlotDefaultOverrides is invalid',
      },
    });
  }
  const authoredBySlot = authoredDefaults as Readonly<Record<string, unknown>> | undefined;
  return applyMeshMaterialSlotTopology(mesh, reconciled, authoredBySlot);
}

async function parseDoc(
  source: string,
  bytes: Uint8Array,
  ctx: ImportContext,
  options: GltfParseOptions = {},
): Promise<ParseDocResult> {
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  if (isGlbBytes(source)) {
    const res = await parseGlb(ab, source, options);
    if (!res.ok) {
      if (res.error instanceof ImportError) return { ok: false, error: res.error };
      throw new Error(parseFailureMessage('parseGlb failed', res.error));
    }
    return { ok: true, value: res.value };
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    throw new Error(`gltf JSON parse failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  // External buffers: read sibling files relative to meta.source. data: URIs
  // are decoded inline by parseGltf; only external URIs reach the loader.
  const externalLoader = async (uri: string): Promise<ArrayBuffer> => {
    const sib = await ctx.readSibling(uri);
    if (!sib.ok) {
      throw new Error(`gltfImporter: external buffer "${uri}" read failed: ${sib.error.code}`);
    }
    return sib.value.buffer.slice(
      sib.value.byteOffset,
      sib.value.byteOffset + sib.value.byteLength,
    ) as ArrayBuffer;
  };
  const res = await parseGltf(json, externalLoader, source, options);
  if (!res.ok) {
    if (res.error instanceof ImportError) return { ok: false, error: res.error };
    throw new Error(parseFailureMessage('parseGltf failed', res.error));
  }
  return { ok: true, value: res.value };
}

/** Import-only refs[] indices; runtime loading resolves them before World admission. */
const refIndex = <K extends string>(index: number): AssetHandle<K> => index as AssetHandle<K>;

interface HandleMaps {
  readonly meshHandles: Map<number, AssetHandle<'mesh'>>;
  readonly materialHandles: Map<number, AssetHandle<'material'>>;
  readonly textureHandles: Map<number, AssetHandle<'texture'>>;
  readonly samplerHandles: Map<number, AssetHandle<'sampler'>>;
  readonly meshGuidByIndex: Map<number, string>;
  readonly materialGuidByIndex: Map<number, string>;
  readonly textureGuidByIndex: Map<number, string>;
  readonly samplerGuidByIndex: Map<number, string>;
}

/**
 * Build the gltf-index -> declared-GUID maps so scene refs resolve to the
 * sub-asset GUIDs (not runtime handles, which do not exist at import time).
 * The scene POD therefore carries deterministic synthetic handle slots; the
 * GUID cross-references are recorded on the ImportedAsset `refs[]`.
 *
 * Texture handles are seeded from `subAssets[]` of kind 'texture'; their
 * sourceIndex is the glTF `images[]` row (toAssetPack emits one texture
 * sub-asset per image row, so the mapping is image-index keyed even though
 * the field is named textureHandles for material binding readability).
 * GltfMaterialIr's `*Texture` fields hold glTF `textures[]` indices; the
 * importer dereferences `textures[i].source` to convert that into an image
 * index when stamping material handles.
 */
function buildHandleMaps(subAssets: readonly ImportSubAsset[], doc: GltfDoc): HandleMaps {
  const meshHandles = new Map<number, AssetHandle<'mesh'>>();
  const materialHandles = new Map<number, AssetHandle<'material'>>();
  const textureHandles = new Map<number, AssetHandle<'texture'>>();
  const samplerHandles = new Map<number, AssetHandle<'sampler'>>();
  const meshGuidByIndex = new Map<number, string>();
  const materialGuidByIndex = new Map<number, string>();
  const textureGuidByIndex = new Map<number, string>();
  const samplerGuidByIndex = new Map<number, string>();
  // bug-20260610 layer 7c-2: scene's `refs[]` is concatenated in the order
  // [mesh sub-assets..., material sub-assets..., texture sub-assets...] (see
  // gltf-importer scene branch). The synthetic handle values stamped here
  // travel through `MeshFilter.assetHandle` / `MeshRenderer.materials[*]` and
  // are decoded at runtime as **refs[] indices** by parseScenePayload. So the
  // handle value MUST equal the slot offset in the eventual concat, NOT the
  // gltf source-index. The previous keying-by-sourceIndex worked accidentally
  // when there was exactly one mesh + N <= meshCount materials; it broke as
  // soon as materialIndex landed past the mesh-section boundary (Sponza:
  // materials[0]=0 -> refs[0] = mesh GUID, every submesh sampled the mesh
  // asset as its material -> single fallback unlit dispatch entry, no per-
  // primitive draws).
  let meshCursor = 0;
  let materialCursor = 0;
  for (const sub of subAssets) {
    if (sub.kind === 'mesh') {
      meshHandles.set(sub.sourceIndex, refIndex<'mesh'>(meshCursor));
      meshGuidByIndex.set(sub.sourceIndex, sub.guid);
      meshCursor += 1;
    } else if (sub.kind === 'material') {
      // material handles come AFTER all mesh refs in the concat.
      // The actual offset (= meshCount + materialCursor) is back-patched
      // below once we know meshCount.
      materialHandles.set(sub.sourceIndex, refIndex<'material'>(materialCursor));
      materialGuidByIndex.set(sub.sourceIndex, sub.guid);
      materialCursor += 1;
    } else if (sub.kind === 'texture') {
      textureGuidByIndex.set(sub.sourceIndex, sub.guid);
    } else if (sub.kind === 'sampler') {
      samplerGuidByIndex.set(sub.sourceIndex, sub.guid);
    }
  }
  const meshCount = meshCursor;
  if (meshCount > 0) {
    for (const [k, v] of materialHandles) {
      const local = v as unknown as number;
      materialHandles.set(k, refIndex<'material'>(local + meshCount));
    }
  }
  // For material binding (toMaterialAsset / values.<X>Texture) the handle
  // value is the texture's slot offset within the SAME asset's `refs[]` (which
  // is `materialTextureRefs` order, not the scene-level refs concat).
  // toMaterialAsset only consumes textureHandles to copy a number into the
  // values; the gltf-importer's later 7a fix-up rewrites those values
  // into refs[] indices for the runtime materialLoader. Keying by texIndex
  // and storing `tex.source` here matches the existing 7a path.
  const textures = doc.textures ?? [];
  for (let texIndex = 0; texIndex < textures.length; texIndex++) {
    const tex = textures[texIndex];
    if (tex === undefined) continue;
    if (textureGuidByIndex.has(tex.source)) {
      textureHandles.set(texIndex, refIndex<'texture'>(tex.source));
    }
  }
  for (const [samplerIndex] of samplerGuidByIndex) {
    samplerHandles.set(samplerIndex, refIndex<'sampler'>(samplerIndex));
  }
  return {
    meshHandles,
    materialHandles,
    textureHandles,
    samplerHandles,
    meshGuidByIndex,
    materialGuidByIndex,
    textureGuidByIndex,
    samplerGuidByIndex,
  };
}

/** Collect texture and sampler GUID refs for one material (AC-11 cross-edge). */
export function materialRefsForPack(
  mat: GltfMaterialIr,
  doc: GltfDoc,
  textureGuidByIndex: ReadonlyMap<number, string>,
  samplerGuidByIndex: ReadonlyMap<number, string> = new Map(),
): readonly AssetRef[] {
  const refs: AssetRef[] = [];
  const textures = doc.textures ?? [];
  for (const { slot } of GLTF_MATERIAL_TEXTURE_SLOTS) {
    const binding = materialTextureBinding(mat[slot]);
    if (binding === undefined) continue;
    const tex = textures[binding.texture];
    if (tex === undefined) continue;
    const guid = textureGuidByIndex.get(tex.source);
    if (guid !== undefined) {
      refs.push({
        guid,
        sourceField: { componentName: '<material>', fieldName: slot },
      });
    }
    if (binding.sampler !== undefined) {
      const samplerGuid = samplerGuidByIndex.get(binding.sampler);
      if (samplerGuid !== undefined) {
        refs.push({
          guid: samplerGuid,
          sourceField: { componentName: '<material>', fieldName: `${slot}.sampler` },
        });
      }
    }
  }
  return refs;
}

function availableUvSets(mesh: GltfDoc['meshes'][number]): readonly number[] {
  const sets: number[] = [];
  for (let set = 0; set < GLTF_UV_SET_COUNT; set++) {
    if (gltfMeshUvSet(mesh, set) !== undefined) sets.push(set);
  }
  return sets;
}

function rewriteMaterialAssetRefs(
  matAsset: ReturnType<typeof toMaterialAsset>,
  mat: GltfMaterialIr,
  doc: GltfDoc,
  maps: HandleMaps,
): ReturnType<typeof toMaterialAsset> {
  const values = { ...(matAsset.values ?? {}) } as Record<string, MaterialValue | null>;
  const textures = doc.textures ?? [];
  let cursor = 0;
  for (const { slot } of GLTF_MATERIAL_TEXTURE_SLOTS) {
    const binding = materialTextureBinding(mat[slot]);
    if (binding === undefined) continue;
    const texture = textures[binding.texture];
    const textureGuid =
      texture === undefined ? undefined : maps.textureGuidByIndex.get(texture.source);
    const value = values[slot];
    if (textureGuid === undefined || typeof value !== 'object' || value === null) {
      delete values[slot];
      continue;
    }
    const textureValue = value as MaterialTextureValue;
    if (textureValue.source !== undefined)
      throw new TypeError('glTF source materials require texture GUID references');
    const textureRef = cursor as unknown as NonNullable<MaterialTextureValue['texture']>;
    cursor++;
    const rewritten =
      binding.sampler !== undefined && maps.samplerGuidByIndex.has(binding.sampler)
        ? {
            ...textureValue,
            texture: textureRef,
            sampler: cursor as unknown as NonNullable<MaterialTextureValue['sampler']>,
          }
        : { ...textureValue, texture: textureRef };
    if (binding.sampler !== undefined && maps.samplerGuidByIndex.has(binding.sampler)) cursor++;
    values[slot] = rewritten;
  }
  return { ...matAsset, values };
}

type GltfMeshPrimitive = GltfDoc['meshes'][number];
type ImportStep<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ImportError };

interface MeshLodLevel {
  readonly mesh: NonNullable<MeshAsset['lods']>[number]['mesh'];
  readonly screenCoverage: number;
  readonly guid: string;
}

/** Facts derived once per import that every sub-asset emitter reads. */
interface GltfImportSession {
  readonly ctx: ImportContext;
  readonly doc: GltfDoc;
  readonly maps: HandleMaps;
  /** Single-asset sources carry no per-asset display name. */
  readonly isMultiAsset: boolean;
  readonly primitivesByMesh: ReadonlyMap<number, readonly GltfMeshPrimitive[]>;
  readonly imageColorSpaces: ReturnType<typeof deriveTextureColorSpace>;
  readonly extraction: ReturnType<typeof extractImageBytes>;
  /**
   * M4 (tweak-20260611-skin-fox-3clip-and-kb-sample-assets): SkinAsset.refs[]
   * carries the skeleton GUID (each skin binds 1:1 to a SkeletonAsset; the
   * skeletonGuid field is the on-asset cross-reference; refs[] is the runner-
   * visible cross-edge used for pack-index ordering and integrity checks).
   */
  readonly skeletonGuidBySourceIndex: ReadonlyMap<number, string>;
  /**
   * feat-20260612 M2 fixup: parallel skin GUID index. Skins and skeletons
   * share `sourceIndex` (toAssetPack emits 1:1 per SkeletonPod) but live
   * as distinct `kind` sub-assets, so the SkinAsset GUIDs differ from the
   * SkeletonAsset GUIDs. The scene emitter appends these GUIDs to both
   * its refs[] (the runtime recursion source: source Scene loading walks
   * envelope.refs to recursively pull every SkinAsset before instantiate) and
   * its payload.skinGuids (the reverse-decode hint) -- without the refs[] edge,
   * browser-async-pack-fetch never loads SkinAssets and Skin.joints stays
   * length=0).
   */
  readonly skinGuidBySourceIndex: ReadonlyMap<number, string>;
}

function subAssetGuidsByKind(
  subAssets: readonly ImportSubAsset[],
  kind: string,
): Map<number, string> {
  const guids = new Map<number, string>();
  for (const sub of subAssets) {
    if (sub.kind === kind) guids.set(sub.sourceIndex, sub.guid);
  }
  return guids;
}

/**
 * Extract image bytes (3 source paths) once. Failures here are surfaced
 * per-image so a single bad row does not abort the whole importer.
 */
function extractDeclaredImages(
  subAssets: readonly ImportSubAsset[],
  doc: GltfDoc,
): ReturnType<typeof extractImageBytes> {
  if (subAssets.some((sub) => sub.kind === 'texture')) return extractImageBytes(doc.images ?? []);
  return { extracted: new Map(), failures: [] };
}

function createImportSession(ctx: ImportContext, doc: GltfDoc): GltfImportSession {
  return {
    ctx,
    doc,
    maps: buildHandleMaps(ctx.subAssets, doc),
    isMultiAsset: ctx.subAssets.length > 1,
    primitivesByMesh: groupMeshPrimitives(doc.meshes),
    // Pre-derive each images[] row's colorSpace from material slot bindings
    // (D-3 / AC-08). orphan images default to 'linear' (AC-13).
    imageColorSpaces: deriveTextureColorSpace({
      imageCount: (doc.images ?? []).length,
      textures: doc.textures,
      materials: doc.materials,
    }),
    extraction: extractDeclaredImages(ctx.subAssets, doc),
    skeletonGuidBySourceIndex: subAssetGuidsByKind(ctx.subAssets, 'skeleton'),
    skinGuidBySourceIndex: subAssetGuidsByKind(ctx.subAssets, 'skin'),
  };
}

function displayName(session: GltfImportSession, name: string | undefined): { name?: string } {
  const shown = session.isMultiAsset ? name : undefined;
  return shown !== undefined ? { name: shown } : {};
}

function meshCookError(
  sourceIndex: number,
  error: { readonly expected: string; readonly hint: string; readonly detail?: unknown },
): ImportError {
  return new ImportError({
    code: 'import-internal-error',
    expected: error.expected,
    hint: error.hint,
    detail: { reason: `mesh ${sourceIndex}: ${JSON.stringify(error.detail)}` },
  });
}

function bridgeMeshPrimitives(
  session: GltfImportSession,
  sub: ImportSubAsset,
  prims: readonly GltfMeshPrimitive[],
): ImportStep<MeshAsset> {
  const { doc, ctx } = session;
  const materialNameByIndex = new Map<number, string>();
  const materialSourceKeyByIndex = new Map<number, string>();
  for (let materialIndex = 0; materialIndex < doc.materials.length; materialIndex++) {
    const name = doc.materials[materialIndex]?.name;
    if (typeof name === 'string') materialNameByIndex.set(materialIndex, name);
  }
  for (const material of ctx.subAssets) {
    if (material.kind === 'material' && material.sourceKey !== undefined) {
      materialSourceKeyByIndex.set(material.sourceIndex, material.sourceKey);
    }
  }
  const bridged = meshIrToMeshAsset(prims, {
    guidByIndex: session.maps.materialGuidByIndex,
    nameByIndex: materialNameByIndex,
    sourceKeyByIndex: materialSourceKeyByIndex,
  });
  if (bridged.ok) return { ok: true, value: bridged.value };
  return {
    ok: false,
    error: new ImportError({
      code: 'import-internal-error',
      expected: 'gltf mesh bridge to produce a canonical MeshAsset',
      actual: bridged.error.code,
      hint: 'repair the source primitive and re-run the glTF importer',
      detail: {
        reason: `gltf mesh bridge rejected mesh ${sub.sourceIndex}; inspect the bridge error detail`,
      },
    }),
  };
}

/** The MSFT_lod group rooted at this mesh: an explicit group first, then the legacy single root. */
function meshLodGroup(doc: GltfDoc, meshIndex: number): GltfLodGroup | undefined {
  const lod = doc.lod;
  if (lod === undefined) return undefined;
  const group = lod.groups?.find(
    (candidate) => doc.nodes[candidate.rootNode]?.meshIndex === meshIndex,
  );
  if (group !== undefined) return group;
  return lod.rootNode !== undefined && doc.nodes[lod.rootNode]?.meshIndex === meshIndex
    ? lod
    : undefined;
}

function validateLodGroupMeshes(
  session: GltfImportSession,
  meshIndex: number,
  lodGroup: GltfLodGroup,
): ImportError | undefined {
  const { doc, maps } = session;
  const referencedMeshIndices = [
    meshIndex,
    ...lodGroup.lodNodeIds.map((nodeIndex) => doc.nodes[nodeIndex]?.meshIndex),
  ];
  const missingMeshIndex = referencedMeshIndices.find(
    (candidate) =>
      !Number.isInteger(candidate) ||
      candidate === null ||
      candidate === undefined ||
      maps.meshGuidByIndex.get(candidate) === undefined,
  );
  if (missingMeshIndex === undefined) return undefined;
  return new ImportError({
    code: 'import-internal-error',
    expected: 'every MSFT_lod node to resolve a cooked mesh sub-asset',
    actual: String(missingMeshIndex),
    hint: 'repair the referenced glTF mesh primitives and re-run the importer',
    detail: {
      reason: `MSFT_lod group for mesh ${meshIndex} references an unprojected mesh`,
    },
  });
}

function authoredLodCoverage(authored: unknown): unknown {
  return authored !== null && typeof authored === 'object'
    ? (authored as { readonly screenCoverage?: unknown }).screenCoverage
    : undefined;
}

/** Authored sourceOverrides coverage wins over the source group and the derived default. */
function meshLodLevels(
  session: GltfImportSession,
  sub: ImportSubAsset,
  lodGroup: GltfLodGroup,
): MeshLodLevel[] {
  const { doc, maps, ctx } = session;
  const authoredLods =
    sub.sourceKey === undefined ? undefined : ctx.sourceOverrides?.[sub.sourceKey]?.lods;
  const lodEntries = Array.isArray(authoredLods) ? authoredLods : [];
  return lodGroup.lodNodeIds.flatMap((nodeIndex, index) => {
    const meshIndex = doc.nodes[nodeIndex]?.meshIndex;
    const guid =
      meshIndex === undefined || meshIndex === null
        ? undefined
        : maps.meshGuidByIndex.get(meshIndex);
    if (guid === undefined) return [];
    const authoredCoverage = authoredLodCoverage(lodEntries[index]);
    const coverage =
      typeof authoredCoverage === 'number'
        ? authoredCoverage
        : (lodGroup.screenCoverages[index] ??
          deriveDefaultLodScreenCoverages(lodGroup.lodNodeIds.length + 1)[index]);
    const parsed = AssetGuidCodec.parse(guid);
    return parsed.ok && coverage !== undefined
      ? [{ mesh: parsed.value, screenCoverage: coverage, guid }]
      : [];
  });
}

function resolveMeshLodLevels(
  session: GltfImportSession,
  sub: ImportSubAsset,
): ImportStep<MeshLodLevel[]> {
  const lodGroup = meshLodGroup(session.doc, sub.sourceIndex);
  if (lodGroup === undefined) return { ok: true, value: [] };
  const missing = validateLodGroupMeshes(session, sub.sourceIndex, lodGroup);
  if (missing !== undefined) return { ok: false, error: missing };
  return { ok: true, value: meshLodLevels(session, sub, lodGroup) };
}

/** Material slot defaults then LOD meshes, deduplicated case-insensitively by GUID. */
function meshAssetRefs(meshPayload: MeshAsset, lodLevels: readonly MeshLodLevel[]): AssetRef[] {
  const materialRefs: AssetRef[] = [];
  const seenMaterialGuids = new Set<string>();
  for (let slotIndex = 0; slotIndex < meshPayload.materialSlots.length; slotIndex++) {
    const defaultMaterial = meshPayload.materialSlots[slotIndex]?.defaultMaterial;
    const guid = defaultMaterial === undefined ? undefined : sourceMaterialGuid(defaultMaterial);
    if (guid !== undefined && !seenMaterialGuids.has(guid.toLowerCase())) {
      seenMaterialGuids.add(guid.toLowerCase());
      materialRefs.push({
        guid,
        sourceField: { fieldName: 'materialSlots', arrayIndex: slotIndex },
      });
    }
  }
  for (const [lodIndex, level] of lodLevels.entries()) {
    if (!seenMaterialGuids.has(level.guid.toLowerCase())) {
      seenMaterialGuids.add(level.guid.toLowerCase());
      materialRefs.push({
        guid: level.guid,
        sourceField: { fieldName: 'lods', arrayIndex: lodIndex },
      });
    }
  }
  return materialRefs;
}

function packMeshBody(
  meshPayload: MeshAsset,
  sourceKey: string,
  materialRefs: readonly AssetRef[],
): Uint8Array {
  const packed = packMeshBin(
    meshPayload as never,
    sourceKey,
    materialRefs.map((ref) => ref.guid),
  );
  if (!packed.ok) {
    throw new ImportError({
      code: 'import-internal-error',
      expected: 'mesh-bin v5 producer to accept the canonical mesh projection',
      hint: 're-cook the source with its Meta sidecar after fixing the mesh payload',
      detail: { reason: `${packed.error.code}: ${packed.error.actual}` },
    });
  }
  return packed.value;
}

async function importMeshSubAsset(
  session: GltfImportSession,
  sub: ImportSubAsset,
): Promise<ImportStep<ImportedAsset<unknown> | undefined>> {
  const { doc, ctx } = session;
  // sub.sourceIndex now indexes glTF mesh-index (not flat GltfMeshIr index).
  // parseGltf flattens N glTF meshes with M_i primitives into sum(M_i)
  // GltfMeshIr rows, all sharing meshIndex; gather all rows whose
  // meshIndex === sub.sourceIndex (preserving doc.meshes order so the
  // bridge's positional materials[i] <-> submeshes[i] pairing aligns)
  // and let meshIrToMeshAsset interleave them into one MeshAsset with
  // N Submesh entries.
  const prims = session.primitivesByMesh.get(sub.sourceIndex) ?? [];
  if (prims.length === 0) return { ok: true, value: undefined };
  const bridged = bridgeMeshPrimitives(session, sub, prims);
  if (!bridged.ok) return bridged;
  const cards = await cookGltfMeshCards(
    bridged.value,
    prims,
    doc.materials,
    ctx.importSettings.meshCards,
  );
  if (!cards.ok) return { ok: false, error: meshCookError(sub.sourceIndex, cards.error) };
  const stabilizedMesh = stabilizeMeshMaterialSlots(cards.value, ctx, sub.guid, sub.sourceKey);
  const distanceField = await cookGltfMeshDistanceField(
    cards.value,
    sub.guid,
    prims,
    doc.materials,
    ctx.importSettings.meshDistanceField,
  );
  if (!distanceField.ok)
    return { ok: false, error: meshCookError(sub.sourceIndex, distanceField.error) };
  const lodLevels = resolveMeshLodLevels(session, sub);
  if (!lodLevels.ok) return lodLevels;
  const sourceMeshPayload: MeshAsset =
    lodLevels.value.length === 0
      ? stabilizedMesh
      : {
          ...stabilizedMesh,
          lods: lodLevels.value.map(({ mesh, screenCoverage }) => ({ mesh, screenCoverage })),
        };
  const meshPayload = cookMeshCollision(
    sourceMeshPayload,
    ctx.importSettings.meshCollision,
  ).unwrap();
  const materialRefs = meshAssetRefs(meshPayload, lodLevels.value);
  return {
    ok: true,
    value: {
      guid: sub.guid,
      kind: 'mesh',
      ...displayName(session, prims[0]?.name),
      payload: {
        kind: 'mesh',
        ...(distanceField.value === undefined
          ? {}
          : { distanceField: distanceField.value.payload }),
      },
      refs: materialRefs,
      artifacts: {
        ...distanceField.value?.artifacts,
        body: {
          mediaType: 'application/x-forgeax-mesh',
          assetCodec: { name: 'mesh-binary', version: '5' },
          bytes: packMeshBody(meshPayload, sub.sourceKey ?? ctx.source, materialRefs),
        },
      },
    },
  };
}

/**
 * feat-20260611 w17-a: a material consumed by any primitive carrying JOINTS_0 +
 * WEIGHTS_0 routes the emitted MaterialAsset to `forgeax::pbr-skin`. Mirrors
 * the per-MeshAsset 18F-stride decision in meshIrToMeshAsset (D-2): a material
 * consumed by any skinned primitive must use the skin shader so the runtime
 * PSO chain (LayoutKind='pbr-skin' + 6-attribute deriveVertexBufferLayout) is
 * exercised.
 */
function isMaterialSkinned(doc: GltfDoc, materialIndex: number): boolean {
  return doc.meshes.some(
    (meshIr) =>
      meshIr.materialIndex === materialIndex &&
      meshIr.joints0 !== undefined &&
      meshIr.weights0 !== undefined,
  );
}

function validateMaterialPrimitives(
  mat: GltfMaterialIr,
  doc: GltfDoc,
  materialIndex: number,
): void {
  for (let primitiveIndex = 0; primitiveIndex < doc.meshes.length; primitiveIndex++) {
    const meshIr = doc.meshes[primitiveIndex];
    if (meshIr?.materialIndex !== materialIndex) continue;
    const uvResult = validateMaterialUvSets(
      mat,
      `primitive-${primitiveIndex}`,
      availableUvSets(meshIr),
    );
    if (!uvResult.ok) {
      throw Object.assign(new Error(uvResult.error.message), uvResult.error);
    }
    const tangentResult = validateMaterialTangentInputs(mat, meshIr);
    if (!tangentResult.ok) {
      throw Object.assign(new Error(tangentResult.error.message), tangentResult.error);
    }
  }
}

function importMaterialSubAsset(
  session: GltfImportSession,
  sub: ImportSubAsset,
): ImportedAsset<unknown> | undefined {
  const { doc, maps, ctx } = session;
  const mat = doc.materials[sub.sourceIndex];
  if (mat === undefined) return undefined;
  const skinned = isMaterialSkinned(doc, sub.sourceIndex);
  validateMaterialPrimitives(mat, doc, sub.sourceIndex);
  const matAsset = toMaterialAsset(mat, {
    textureHandles: maps.textureHandles,
    samplerHandles: maps.samplerHandles,
    skinned,
    ...(typeof ctx.importSettings.standardMaterialGuid === 'string'
      ? { standardRootGuid: ctx.importSettings.standardMaterialGuid as unknown as AssetGuid }
      : {}),
  });
  const refs = materialRefsForPack(mat, doc, maps.textureGuidByIndex, maps.samplerGuidByIndex);
  // D-8: if material has a parent, add parent edge to refs
  const materialRefs: AssetRef[] = [...refs];
  if (matAsset.parent !== undefined) {
    materialRefs.push({
      guid: matAsset.parent as unknown as string,
      sourceField: { fieldName: 'parent' },
    });
  }
  return {
    guid: sub.guid,
    kind: 'material',
    ...displayName(session, mat.name),
    payload: rewriteMaterialAssetRefs(matAsset, mat, doc, maps),
    refs: materialRefs,
    artifacts: {},
  };
}

function extractedImageOrThrow(
  session: GltfImportSession,
  imageIndex: number,
): NonNullable<ReturnType<GltfImportSession['extraction']['extracted']['get']>> {
  const extracted = session.extraction.extracted.get(imageIndex);
  if (extracted !== undefined) return extracted;
  const failure = session.extraction.failures.find((f) => f.imageIndex === imageIndex);
  const detail = failure ?? {
    imageIndex,
    source: 'bufferView' as const,
    reason: 'image row missing from extraction map (no images[] entry?)',
  };
  const error = gltfErr('gltf-image-extract-failed', detail);
  throw new Error(
    `gltfImporter: ${error.code} on image ${imageIndex} (${detail.source}): ${detail.reason}`,
  );
}

async function importTextureSubAsset(
  session: GltfImportSession,
  sub: ImportSubAsset,
): Promise<ImportedAsset<unknown>> {
  const { ctx } = session;
  const imageIndex = sub.sourceIndex;
  const extracted = extractedImageOrThrow(session, imageIndex);
  const colorSpace = session.imageColorSpaces.get(imageIndex) ?? 'linear';
  // Carry colorSpace + mipmap settings into decodeImage via a per-image
  // settings record (mirror of importImageSettings — but here the importer
  // owns the decision because the seam is in-bounds for AC-12 (c)).
  const decodeSettings = {
    ...ctx.importSettings,
    colorSpace,
    mipmap: ctx.importSettings.mipmap ?? true,
  };
  const decoded = await ctx.decodeImage(extracted.bytes, extracted.mimeType, decodeSettings);
  if (!decoded.ok) {
    const reason = `decodeImage failed: ${decoded.error.code}`;
    const error = gltfErr('gltf-image-extract-failed', {
      imageIndex,
      source: extracted.source,
      reason,
    });
    throw new Error(
      `gltfImporter: ${error.code} on image ${imageIndex} (${extracted.source}): ${reason}`,
    );
  }
  return {
    guid: sub.guid,
    kind: 'texture',
    ...displayName(session, (session.doc.images ?? [])[imageIndex]?.name),
    payload: decoded.value.texture,
    refs: [],
    artifacts: {
      body: {
        mediaType: decoded.value.mediaType ?? extracted.mimeType,
        assetCodec: decoded.value.assetCodec ?? { name: 'rgba8', version: '1' },
        bytes: decoded.value.bytes,
      },
    },
  };
}

/** glTF NEAREST (9728) and the NEAREST_MIPMAP_* min filters sample texels with nearest filtering. */
function samplerFilter(value: number | undefined): 'nearest' | 'linear' | undefined {
  if (value === undefined) return undefined;
  return value === 9728 || value === 9984 || value === 9986 || value === 9988
    ? 'nearest'
    : 'linear';
}

/** glTF *_MIPMAP_NEAREST min filters (9984, 9985) select the nearest mip. */
function samplerMipmapFilter(value: number | undefined): 'nearest' | 'linear' | undefined {
  if (value === undefined) return undefined;
  return value === 9984 || value === 9985 ? 'nearest' : 'linear';
}

function samplerAddressMode(value: number): 'repeat' | 'mirror-repeat' | 'clamp-to-edge' {
  if (value === 33071) return 'clamp-to-edge';
  if (value === 33648) return 'mirror-repeat';
  return 'repeat';
}

function importSamplerSubAsset(
  session: GltfImportSession,
  sub: ImportSubAsset,
): ImportedAsset<unknown> | undefined {
  const sampler = session.doc.samplers?.[sub.sourceIndex];
  if (sampler === undefined) return undefined;
  const magFilter = samplerFilter(sampler.magFilter);
  const minFilter = samplerFilter(sampler.minFilter);
  const mipmap = samplerMipmapFilter(sampler.minFilter);
  const payload = {
    kind: 'sampler' as const,
    ...(magFilter === undefined ? {} : { magFilter }),
    ...(minFilter === undefined ? {} : { minFilter }),
    ...(mipmap === undefined ? {} : { mipmapFilter: mipmap }),
    addressModeU: samplerAddressMode(sampler.wrapS),
    addressModeV: samplerAddressMode(sampler.wrapT),
  };
  return { guid: sub.guid, kind: 'sampler', payload, refs: [], artifacts: {} };
}

type SceneAssetPod = ReturnType<typeof gltfDocToSceneAsset>;

interface SceneRefProvenance {
  readonly meshFilterByHandle: ReadonlyMap<number, { readonly sceneEntityKey: string }>;
  readonly skinBySkeletonGuid: ReadonlyMap<string, { readonly sceneEntityKey: string }>;
}

/**
 * Walk keyed scene entities to find which entity authored each mesh handle
 * (MeshFilter.assetHandle) and each skeleton GUID (Skin.skeleton).
 */
function sceneRefProvenance(scene: SceneAssetPod): SceneRefProvenance {
  const meshFilterByHandle = new Map<number, { sceneEntityKey: string }>();
  const skinBySkeletonGuid = new Map<string, { sceneEntityKey: string }>();
  for (const [sceneEntityKey, entity] of Object.entries(scene.entities)) {
    const comps = entity.components as Record<string, Record<string, unknown>>;
    const mf = comps.MeshFilter;
    if (mf !== undefined && typeof mf.assetHandle === 'number') {
      meshFilterByHandle.set(mf.assetHandle, { sceneEntityKey });
    }
    const skin = comps.Skin;
    if (skin !== undefined && typeof skin.skeleton === 'string') {
      skinBySkeletonGuid.set(skin.skeleton, { sceneEntityKey });
    }
  }
  return { meshFilterByHandle, skinBySkeletonGuid };
}

/**
 * Scene refs contain only dependencies authored directly by the scene:
 * mesh, skeleton, and skin assets. Imported material defaults belong to
 * MeshAsset.materialSlots, and textures belong to MaterialAsset refs;
 * repeating either here would create a second dependency owner.
 * Skeleton GUIDs are appended so the runtime asset graph sees the
 * cross-edge when a skinned mesh node carries Skin { skeleton:
 * <guid-string> }; skin GUIDs (feat-20260612 M2 fixup) carry the
 * SkinAsset cross-edge that has no entity-component representation but
 * is required for postSpawnResolveJoints to resolve Skin.joints[] via
 * SkinAsset.jointPaths.
 *
 * D-2 / D-3: refs carries structured edge metadata (AssetRef[]). Mesh
 * handle values are refs[] indices, so a mesh ref's sourceField comes from
 * the entity whose MeshFilter holds that index. Skeleton edges: sourceField
 * from Skin.skeleton if an entity carries that GUID. Skin edges:
 * sourceField=undefined (cross-edge with no entity-component representation).
 */
function sceneAssetRefs(session: GltfImportSession, scene: SceneAssetPod): AssetRef[] {
  const provenance = sceneRefProvenance(scene);
  const refs: AssetRef[] = [];
  for (const [handle, guid] of [...session.maps.meshGuidByIndex.values()].entries()) {
    const prov = provenance.meshFilterByHandle.get(handle);
    refs.push(
      prov !== undefined
        ? {
            guid,
            sourceField: { componentName: 'MeshFilter', fieldName: 'assetHandle' },
            sceneEntityKey: prov.sceneEntityKey,
          }
        : { guid },
    );
  }
  for (const guid of session.skeletonGuidBySourceIndex.values()) {
    const skProv = provenance.skinBySkeletonGuid.get(guid);
    refs.push(
      skProv !== undefined
        ? {
            guid,
            sourceField: { componentName: 'Skin', fieldName: 'skeleton' },
            sceneEntityKey: skProv.sceneEntityKey,
          }
        : { guid },
    );
  }
  for (const guid of session.skinGuidBySourceIndex.values()) refs.push({ guid });
  return refs;
}

function importSceneSubAsset(
  session: GltfImportSession,
  sub: ImportSubAsset,
): ImportedAsset<unknown> {
  // #317 multi-material design: bridge accepts glTF mesh-index keyed
  // meshHandles + materialHandles only; primitive merge happens via
  // doc.meshes[] filtering on meshIndex inside the bridge.
  // tweak-20260611 M6: also pass skeletonGuidBySkinIndex so the bridge
  // can stamp Skin component (skeleton GUID string) onto skinned mesh
  // entities. Skins are 1:1 with skeletons in toAssetPack so the same
  // sourceIndex map serves both purposes (the field name says
  // "BySkinIndex" because the bridge keys by GltfNodeIr.skinIndex).
  const scene = gltfDocToSceneAsset(session.doc, {
    meshHandles: session.maps.meshHandles,
    materialHandles: session.maps.materialHandles,
    skeletonGuidBySkinIndex: session.skeletonGuidBySourceIndex,
  });
  const refs = sceneAssetRefs(session, scene);
  // Inject skinGuids into the scene payload as the reverse-decode hint; the
  // SkinAsset GUIDs are already in the scene envelope's refs[] above, which
  // is the runtime recursion source for the browser-async-pack-fetch path.
  // Stored as inline GUID strings (in-memory dawn smoke path); the on-disk
  // .pack.json round-trip preserves them as strings -- parseScenePayload's
  // resolveSkinGuids accepts both string and refs[]-index shapes.
  const skinGuidList = [...session.skinGuidBySourceIndex.values()];
  const sceneWithSkinGuids =
    skinGuidList.length > 0 ? { ...scene, skinGuids: skinGuidList } : scene;
  return {
    guid: sub.guid,
    kind: 'scene',
    ...displayName(session, session.doc.scenes[sub.sourceIndex]?.name),
    payload: sceneWithSkinGuids,
    refs,
    artifacts: {},
  };
}

/**
 * tweak-20260611 M4: skeleton sub-asset POD emit. SkeletonPod (the
 * gltf IR shape from parse-skin) carries inverseBindMatrices + jointCount
 * + jointPaths; SkeletonAsset (the runtime POD) carries IBM + jointCount
 * only — jointPaths live on the parallel SkinAsset (1:1 mapping per
 * toAssetPack's emit policy). refs[] is empty (skeleton is leaf data).
 */
function importSkeletonSubAsset(
  session: GltfImportSession,
  sub: ImportSubAsset,
): ImportedAsset<unknown> | undefined {
  const rec = session.doc.skeletons[sub.sourceIndex];
  if (rec === undefined) return undefined;
  const payload = {
    kind: 'skeleton' as const,
    inverseBindMatrices: rec.inverseBindMatrices,
    jointCount: rec.jointCount,
    ...(rec.bounds === undefined ? {} : { bounds: rec.bounds }),
    ...(rec.shadowCapsules === undefined ? {} : { shadowCapsules: rec.shadowCapsules }),
  };
  return { guid: sub.guid, kind: 'skeleton', payload, refs: [], artifacts: {} };
}

/**
 * tweak-20260611 M4: skin sub-asset POD emit. The 1:1 mapping with
 * skeleton (toAssetPack emits one skin per SkeletonPod at the same
 * sourceIndex) lets us pull the skeleton GUID out of the pre-built
 * skeletonGuidBySourceIndex map. SkinAsset is the runtime POD, distinct
 * from SkeletonPod: skeletonGuid + jointPaths only (zero entity refs
 * at the asset layer per AC-06). refs[] carries the skeletonGuid so the
 * runner sees the cross-edge.
 */
function importSkinSubAsset(
  session: GltfImportSession,
  sub: ImportSubAsset,
): ImportedAsset<unknown> | undefined {
  const rec = session.doc.skeletons[sub.sourceIndex];
  if (rec === undefined) return undefined;
  const skeletonGuid = session.skeletonGuidBySourceIndex.get(sub.sourceIndex);
  if (skeletonGuid === undefined) return undefined;
  const payload = {
    kind: 'skin' as const,
    skeletonGuid,
    jointPaths: rec.jointPaths,
  };
  return {
    guid: sub.guid,
    kind: 'skin',
    payload,
    refs: [{ guid: skeletonGuid, sourceField: { fieldName: 'skeleton' } }],
    artifacts: {},
  };
}

/**
 * tweak-20260611 M4: animation-clip sub-asset POD emit. GltfAnimationClipRecord
 * (gltf IR) and AnimationClip (runtime POD) are structurally compatible
 * — both carry duration + channels[]; channels' inner shape matches
 * (targetId / property / sampler). property is narrowed to the runtime
 * closed union by the parser. refs[] is empty (animation clips reference joints by name path
 * resolved at post-spawn time, not by sub-asset cross-edge).
 */
function importAnimationClipSubAsset(
  session: GltfImportSession,
  sub: ImportSubAsset,
): ImportedAsset<unknown> | undefined {
  const rec = session.doc.animationClips[sub.sourceIndex];
  if (rec === undefined) return undefined;
  const payload = {
    kind: 'animation-clip' as const,
    duration: rec.duration,
    channels: rec.channels.map((ch) => ({
      targetId: ch.targetId,
      property: ch.property,
      sampler: {
        input: ch.sampler.input,
        output: ch.sampler.output,
        interpolation: ch.sampler.interpolation,
      },
    })),
  };
  const samples = encodeAnimationClipSamples(payload);
  return {
    guid: sub.guid,
    kind: 'animation-clip',
    payload: samples?.payload ?? payload,
    refs: [],
    artifacts:
      samples === undefined
        ? {}
        : {
            [ANIMATION_CLIP_SAMPLES_ARTIFACT]: {
              mediaType: 'application/octet-stream',
              bytes: samples.bytes,
            },
          },
  };
}

/** Emit one declared sub-asset; kinds without a doc counterpart emit nothing. */
async function importSubAsset(
  session: GltfImportSession,
  sub: ImportSubAsset,
): Promise<ImportStep<ImportedAsset<unknown> | undefined>> {
  switch (sub.kind) {
    case 'mesh':
      return importMeshSubAsset(session, sub);
    case 'material':
      return { ok: true, value: importMaterialSubAsset(session, sub) };
    case 'texture':
      return { ok: true, value: await importTextureSubAsset(session, sub) };
    case 'sampler':
      return { ok: true, value: importSamplerSubAsset(session, sub) };
    case 'scene':
      return { ok: true, value: importSceneSubAsset(session, sub) };
    case 'skeleton':
      return { ok: true, value: importSkeletonSubAsset(session, sub) };
    case 'skin':
      return { ok: true, value: importSkinSubAsset(session, sub) };
    case 'animation-clip':
      return { ok: true, value: importAnimationClipSubAsset(session, sub) };
    default:
      return { ok: true, value: undefined };
  }
}

async function importGltf(
  ctx: ImportContext,
  options: GltfParseOptions = {},
): Promise<ImportResult<unknown>> {
  const read = await ctx.readSource();
  if (!read.ok) {
    throw new Error(
      `gltfImporter: readSource failed: ${read.error instanceof Error ? read.error.message : String(read.error)}`,
    );
  }
  const parsed = await parseDoc(ctx.source, read.value, ctx, options);
  if (!parsed.ok) return parsed;
  const doc = deriveGltfShadowCapsules(
    deriveGltfAnimatedBounds(applyImportSettingsBounds(parsed.value, ctx.importSettings)),
  );
  const session = createImportSession(ctx, doc);
  const out: ImportedAsset<unknown>[] = [];
  for (const sub of ctx.subAssets) {
    const asset = await importSubAsset(session, sub);
    if (!asset.ok) return asset;
    if (asset.value !== undefined) out.push(asset.value);
  }
  return { ok: true, value: { assets: out, sourceDependencies: [] } };
}

/**
 * The gltf {@link Importer}. Register it into an `ImporterRegistry` so the
 * import runner dispatches `meta.importer === 'gltf'` sidecars here.
 *
 * @example
 * ```ts
 * import { ImporterRegistry } from '@forgeax/engine-import';
 * import { gltfImporter } from '@forgeax/engine-gltf';
 * const importers = new ImporterRegistry();
 * importers.register(gltfImporter);
 * ```
 */
export function createGltfImporter(options: GltfParseOptions = {}): Importer {
  return {
    key: 'gltf',
    import: (ctx) => importGltf(ctx, options),
    capabilities: { catalog: { publish: publishesCatalogProduct } },
  };
}

/** Importer for hosts that provide an optional build-only Meshopt decoder. */
export const gltfImporter: Importer = createGltfImporter();

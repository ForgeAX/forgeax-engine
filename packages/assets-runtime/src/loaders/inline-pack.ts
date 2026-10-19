import { admitsMeshCardLayout, validateMeshCardLayout } from '@forgeax/engine-geometry';
// @forgeax/engine-assets-runtime -- inline pack-payload loader bodies
// (feat-20260705-runtime-tier2-decomposition M1 / w4, D-4 F1 straight-cut).
// Pure move from asset-registry.ts; zero identifier changes.

import {
  attachMeshDistanceField,
  createProceduralMesh,
  deriveVertexLayoutProjection,
  MESH_GEOMETRIC_DISTANCE_FIELD_CODEC,
  MESH_VISIBILITY_DISTANCE_FIELD_CODEC,
  MeshBinAssetError,
  PROCEDURAL_FLOATS_PER_VERTEX,
  prepareMeshData,
  unpackMeshBin,
  validateMeshCollisionAttachment,
} from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type {
  AddressMode,
  AnimationChannel,
  AnimationGraph,
  AnimationGraphNode,
  Asset,
  AssetGuid as AssetGuidType,
  AudioClipAsset,
  CompareFunction,
  FilterMode,
  LoadContext,
  Loader,
  MaterialAsset,
  MaterialPass,
  MaterialTextureCoordinates,
  ParticleEffectAsset,
  MeshAsset as TypesMeshAsset,
} from '@forgeax/engine-types';
import {
  AssetError,
  isMaterialStaticSwitches,
  isMaterialTextureParameterType,
  MATERIAL_CHILD_FORBIDDEN_FIELDS,
  parseShadowCapsuleSet,
  resolveMaterialTextureCoordinates,
} from '@forgeax/engine-types';
import { parseScenePayload } from '../scene-payload';
import { renderPipelineLoader, tilesetLoader } from './pack-artifact';

type ParsedMeshLodPayload = {
  readonly lods?: TypesMeshAsset['lods'];
  readonly lodHysteresis?: number;
};

function parseLodGuid(
  raw: unknown,
  refs: readonly string[] | undefined,
): AssetGuidType | undefined {
  if (raw instanceof Uint8Array) {
    return raw.byteLength === 16 ? (raw as AssetGuidType) : undefined;
  }
  if (Array.isArray(raw)) {
    if (
      raw.length !== 16 ||
      raw.some((byte) => !Number.isInteger(byte) || (byte as number) < 0 || (byte as number) > 255)
    )
      return undefined;
    return new Uint8Array(raw as number[]) as AssetGuidType;
  }
  if (typeof raw === 'string') {
    const parsed = AssetGuid.parse(raw);
    return parsed.ok ? parsed.value : undefined;
  }
  if (typeof raw === 'number' && Number.isInteger(raw) && refs !== undefined) {
    const ref = refs[raw];
    if (ref === undefined) return undefined;
    const parsed = AssetGuid.parse(ref);
    return parsed.ok ? parsed.value : undefined;
  }
  return undefined;
}

function parseMeshLodPayload(
  rawLods: unknown,
  rawHysteresis: unknown,
  refs: readonly string[] | undefined,
): { readonly ok: true; readonly value: ParsedMeshLodPayload } | { readonly ok: false } {
  if (rawLods !== undefined && !Array.isArray(rawLods)) return { ok: false };
  if (
    rawHysteresis !== undefined &&
    (typeof rawHysteresis !== 'number' ||
      !Number.isFinite(rawHysteresis) ||
      rawHysteresis < 0 ||
      rawHysteresis >= 1)
  )
    return { ok: false };
  if (rawLods === undefined) {
    return {
      ok: true,
      value: rawHysteresis === undefined ? {} : { lodHysteresis: rawHysteresis as number },
    };
  }
  if (rawLods.length > 7) return { ok: false };
  let previousCoverage = 1;
  const lods: NonNullable<TypesMeshAsset['lods']>[number][] = [];
  for (const rawLod of rawLods) {
    if (rawLod === null || typeof rawLod !== 'object') return { ok: false };
    const entry = rawLod as Record<string, unknown>;
    const mesh = parseLodGuid(entry.mesh ?? entry.meshRef, refs);
    const screenCoverage = entry.screenCoverage;
    if (
      mesh === undefined ||
      typeof screenCoverage !== 'number' ||
      !Number.isFinite(screenCoverage) ||
      screenCoverage <= 0 ||
      screenCoverage > 1 ||
      screenCoverage >= previousCoverage
    )
      return { ok: false };
    lods.push({ mesh, screenCoverage });
    previousCoverage = screenCoverage;
  }
  return {
    ok: true,
    value: {
      lods,
      ...(rawHysteresis === undefined ? {} : { lodHysteresis: rawHysteresis as number }),
    },
  };
}

// === Inline pack-payload loader bodies (feat-20260603-asset-import-loader-injection
// M1 / w4) ===
//
// The eight `if (kind === ...)` arms that lived inside
// `AssetRegistry.parseAssetPayload` (research Finding 1) are extracted here as
// module-level `{ kind, load }` objects so they register into a
// `LoaderRegistry` (D-1) and can be imported by `wireDefaultLoaders` (w5). The
// body logic is copied verbatim — M1 is a pure refactor (AC-03), no behavioural
// change. Each parses an inline `.pack.json` payload synchronously and returns
// the `Asset` POD or `undefined` (parse rejected). The `scene` arm routes its
// structured out-of-bounds-ref error back through the LoaderOutput return
// value instead of the old shared instance slot (D-8 channel replaced by F21).

/** mesh loader — Float32Array / Uint16Array | Uint32Array normalisation -> MeshAsset.
 *
 * feat-20260611: skinIndex (Uint16Array) and skinWeight (Float32Array) accept
 * both their native typed-array shape (in-memory: dawn smoke / direct
 * `register` test) AND `number[]` (post-`JSON.stringify` shape produced by the
 * dev-server / build-mode pack-body round-trip — `JSON.stringify(pack) -> fetch
 * -> JSON.parse` flattens every typed array to a plain Array). Same dual
 * contract `skeletonLoader` / `animationClipLoader` already honour (PR #350);
 * without the array arm, every Fox.glb / Khronos skinned glTF surfaces as
 * `asset-parse-failed` on the browser path while dawn smoke stays green.
 */
export const meshLoader: Loader = {
  kind: 'mesh',
  load(payload) {
    if (payload.distanceField !== undefined) return undefined;
    const procedural = createProceduralMesh(payload);
    if (procedural !== undefined) return procedural.ok ? procedural.value : undefined;

    const vertexData = payload.vertices;
    const indexData = payload.indices;
    const rawAttributes = (payload.attributes as Record<string, unknown> | undefined) ?? {};
    const attributes: Record<string, unknown> = { ...rawAttributes };
    // JSON transport must restore every canonical attribute before derived geometry admission.
    for (const attribute of deriveVertexLayoutProjection(
      rawAttributes as TypesMeshAsset['attributes'],
    ).attributes) {
      const value = rawAttributes[attribute.key];
      if (Array.isArray(value))
        attributes[attribute.key] =
          attribute.key === 'skinIndex' ? new Uint16Array(value) : new Float32Array(value);
    }

    const rawAabb = payload.aabb;
    let aabb: Float32Array | undefined;
    if (rawAabb instanceof Float32Array) {
      aabb = rawAabb;
    } else if (Array.isArray(rawAabb)) {
      aabb = new Float32Array(rawAabb as number[]);
    } else if (rawAabb !== undefined) {
      return undefined;
    }

    let morphTargets: TypesMeshAsset['morphTargets'];
    const rawMorphTargets = payload.morphTargets;
    if (rawMorphTargets !== undefined) {
      if (
        !Array.isArray(rawMorphTargets) ||
        rawMorphTargets.length < 1 ||
        rawMorphTargets.length > 8
      ) {
        return undefined;
      }
      const parsedTargets: NonNullable<TypesMeshAsset['morphTargets']>[number][] = [];
      for (const rawTarget of rawMorphTargets) {
        if (typeof rawTarget !== 'object' || rawTarget === null) return undefined;
        const source = rawTarget as Record<string, unknown>;
        const target: {
          position?: Float32Array;
          normal?: Float32Array;
          tangent?: Float32Array;
        } = {};
        for (const [key, value] of Object.entries(source)) {
          if (key !== 'position' && key !== 'normal' && key !== 'tangent') return undefined;
          if (value instanceof Float32Array) target[key] = value;
          else if (Array.isArray(value)) target[key] = new Float32Array(value as number[]);
          else return undefined;
        }
        if (Object.keys(target).length === 0) return undefined;
        parsedTargets.push(target);
      }
      morphTargets = parsedTargets;
    }
    let morphWeights: Float32Array | undefined;
    const rawMorphWeights = payload.morphWeights;
    if (rawMorphWeights !== undefined) {
      if (rawMorphWeights instanceof Float32Array) morphWeights = rawMorphWeights;
      else if (Array.isArray(rawMorphWeights))
        morphWeights = new Float32Array(rawMorphWeights as number[]);
      else return undefined;
      if (morphTargets !== undefined && morphWeights.length !== morphTargets.length)
        return undefined;
    }

    const parsedLods = parseMeshLodPayload(payload.lods, payload.lodHysteresis, undefined);
    if (!parsedLods.ok) return undefined;

    const skinIndexRaw = attributes.skinIndex;
    if (skinIndexRaw instanceof Uint16Array) {
      attributes.skinIndex = skinIndexRaw;
    } else if (Array.isArray(skinIndexRaw)) {
      attributes.skinIndex = new Uint16Array(skinIndexRaw as number[]);
    } else if (skinIndexRaw !== undefined) {
      return undefined;
    }

    const skinWeightRaw = attributes.skinWeight;
    if (skinWeightRaw instanceof Float32Array) {
      attributes.skinWeight = skinWeightRaw;
    } else if (Array.isArray(skinWeightRaw)) {
      attributes.skinWeight = new Float32Array(skinWeightRaw as number[]);
    } else if (skinWeightRaw !== undefined) {
      return undefined;
    }

    let vertices: Float32Array;
    let indices: Uint16Array | Uint32Array | undefined;

    if (vertexData instanceof Float32Array) {
      vertices = vertexData;
    } else if (Array.isArray(vertexData)) {
      vertices = new Float32Array(vertexData as number[]);
    } else {
      return undefined;
    }

    // bug-20260610: index width must follow vertex count, not a hard-coded
    // Uint16Array. A glTF mesh (e.g. Sponza, ~192k merged verts) overflows
    // Uint16; round-tripping through Uint16Array silently wraps and
    // `mesh-vertex-stride-mismatch` then fires because `maxIndex + 1` no
    // longer equals `vertexCount`. Mirrors `meshIrToMeshAsset` in
    // packages/gltf/src/bridge.ts which picks Uint32 above 0xffff.
    //
    // feat-20260612 M2 fixup: when the input carries an empty index array
    // (Fox.glb-style non-indexed primitives flattened through the mesh-bin
    // sidecar with `ilen=0`), drop the indices field rather than emit a
    // 0-byte typed array. The downstream `gpu-resource-store` chooses the
    // indexed-vs-vertex-only path on `mesh.indices !== undefined`; a 0-byte
    // typed array still satisfies !== undefined and triggers a 0-size IBO
    // allocation, whose `setIndexBuffer(buffer.slice(0..0), ...)` panics
    // wgpu's `BufferSlice` "buffer slices can not be empty" assertion.
    if (indexData instanceof Uint16Array || indexData instanceof Uint32Array) {
      indices = indexData.length > 0 ? indexData : undefined;
    } else if (Array.isArray(indexData)) {
      const arr = indexData as number[];
      if (arr.length === 0) {
        indices = undefined;
      } else {
        const vertexCount = vertices.length / PROCEDURAL_FLOATS_PER_VERTEX;
        const useUint32 = vertexCount > 0xffff;
        indices = useUint32 ? new Uint32Array(arr) : new Uint16Array(arr);
      }
    } else if (indexData === undefined) {
      indices = undefined;
    } else {
      return undefined;
    }

    // feat-20260608 M5 / w27: pack-payload mesh assets default to a single
    // triangle-list submesh covering the full index/vertex range. Inline
    // .pack.json mesh payloads do not carry submesh tables (single-prim
    // legacy shape); render code unconditionally reads `submeshes[0]`.
    // vertexCount stored as full vertices.length (downstream computes per-
    // attribute strides; submesh keeps the buffer-element-count for now).
    //
    // bug-20260610: when the payload carries an explicit `submeshes` table
    // (gltf importer emits one per primitive), respect it. The
    // `triangle-list 0..indices.length` default fits only single-prim packs.
    const payloadSubmeshes = payload.submeshes;
    const rawSubmeshes =
      Array.isArray(payloadSubmeshes) && payloadSubmeshes.length > 0
        ? (payloadSubmeshes as unknown as TypesMeshAsset['submeshes'])
        : [
            {
              indexOffset: 0,
              indexCount: indices?.length ?? 0,
              vertexCount: vertices.length,
              topology: 'triangle-list' as const,
            },
          ];
    const payloadSlots = payload.materialSlots;
    const materialSlots: TypesMeshAsset['materialSlots'] = Array.isArray(payloadSlots)
      ? payloadSlots.map((raw, slotIndex) => {
          if (typeof raw !== 'object' || raw === null)
            return { slotName: `LegacySlot_${slotIndex}` };
          const slot = raw as Record<string, unknown>;
          let defaultMaterial: AssetGuidType | undefined;
          if (slot.defaultMaterial instanceof Uint8Array) {
            defaultMaterial = slot.defaultMaterial as AssetGuidType;
          } else if (typeof slot.defaultMaterial === 'string') {
            const parsed = AssetGuid.parse(slot.defaultMaterial);
            if (!parsed.ok) return { slotName: `LegacySlot_${slotIndex}` };
            defaultMaterial = parsed.value;
          }
          return {
            slotName:
              typeof slot.slotName === 'string' && slot.slotName.trim().length > 0
                ? slot.slotName
                : `LegacySlot_${slotIndex}`,
            ...(typeof slot.sourceKey === 'string' ? { sourceKey: slot.sourceKey } : {}),
            ...(defaultMaterial !== undefined ? { defaultMaterial } : {}),
          };
        })
      : rawSubmeshes.map((_, slotIndex) => ({ slotName: `LegacySlot_${slotIndex}` }));
    const submeshes: TypesMeshAsset['submeshes'] = rawSubmeshes.map((submesh, submeshIndex) => ({
      ...submesh,
      materialSlot: Number.isInteger((submesh as { materialSlot?: unknown }).materialSlot)
        ? (submesh as { materialSlot: number }).materialSlot
        : submeshIndex,
    }));

    const cardLayout = payload.cardLayout as TypesMeshAsset['cardLayout'];
    if (submeshes.some((section) => 'cardLayout' in section)) return undefined;
    if (
      cardLayout !== undefined &&
      (!validateMeshCardLayout(cardLayout).ok ||
        !admitsMeshCardLayout({ submeshes, morphTargets, skinIndex: attributes.skinIndex }))
    )
      return undefined;
    const mesh: TypesMeshAsset = {
      kind: 'mesh',
      ...(cardLayout === undefined ? {} : { cardLayout }),
      vertices,
      ...(indices !== undefined ? { indices } : {}),
      attributes: attributes as TypesMeshAsset['attributes'],
      ...(aabb !== undefined ? { aabb } : {}),
      ...(morphTargets !== undefined ? { morphTargets } : {}),
      ...(morphWeights !== undefined ? { morphWeights } : {}),
      ...(parsedLods.value.lods === undefined ? {} : { lods: parsedLods.value.lods }),
      ...(parsedLods.value.lodHysteresis === undefined
        ? {}
        : { lodHysteresis: parsedLods.value.lodHysteresis }),
      submeshes,
      materialSlots,
    };
    if (payload.collision === undefined) return mesh;
    const collision = validateMeshCollisionAttachment(mesh, payload.collision);
    return collision.ok ? { ...mesh, collision: collision.value } : undefined;
  },
  loadPack(input, ctx) {
    const distanceField = input.payload.distanceField;
    const fieldArtifact = input.artifacts['distance-field.bin'];
    const original = input;
    const loadGeometry = () => {
      let input = original;
      if (distanceField !== undefined) {
        const { distanceField: _, ...geometry } = original.payload;
        input = { ...original, payload: geometry };
      }
      if (input.payload.vertices instanceof Float32Array && input.payload.kind === 'mesh') {
        if (input.artifacts.body !== undefined)
          return {
            ok: false,
            error: new AssetError({
              code: 'asset-parse-failed',
              expected: 'one Mesh geometry source',
              hint: 'submit native Mesh data or a body artifact, never both',
            }),
          } as never;
        const result = prepareMeshData(
          input.payload as unknown as TypesMeshAsset,
          input.guid,
          input.refs,
        );
        if (!result.ok) return { ok: false, error: result.error } as never;
        return input.payload as unknown as TypesMeshAsset;
      }
      const artifact = input.artifacts.body;
      if (artifact === undefined) return meshLoader.load(input.payload, input.refs, ctx);
      const decoded = unpackMeshBin(artifact.bytes, input.guid);
      if (!decoded.ok) return { ok: false, error: decoded.error } as never;
      const materialSlots = decoded.value.materialSlots.map((slot) => {
        const refIndex = slot.defaultMaterialRef;
        const ref = refIndex === undefined ? undefined : input.refs[refIndex];
        if (refIndex !== undefined && ref === undefined) return undefined;
        if (ref === undefined) {
          return {
            slotName: String(slot.slotName),
            ...(typeof slot.sourceKey === 'string' ? { sourceKey: slot.sourceKey } : {}),
          };
        }
        const parsed = AssetGuid.parse(ref);
        if (!parsed.ok) return undefined;
        return {
          slotName: String(slot.slotName),
          ...(typeof slot.sourceKey === 'string' ? { sourceKey: slot.sourceKey } : {}),
          defaultMaterial: parsed.value,
        };
      });
      if (materialSlots.some((slot) => slot === undefined)) {
        return {
          ok: false,
          error: new MeshBinAssetError({
            sourceKey: input.guid,
            expected: 'material slot references must resolve through the pack refs table',
            actual: 'material reference is out of bounds or is not a valid AssetGuid',
            reason: 'metadata-invalid',
            actualFacts: { field: 'metadata' },
          }),
        } as never;
      }
      const parsedLods = parseMeshLodPayload(
        decoded.value.lods,
        decoded.value.lodHysteresis,
        input.refs,
      );
      if (!parsedLods.ok) {
        return {
          ok: false,
          error: new MeshBinAssetError({
            sourceKey: input.guid,
            expected: 'LOD mesh references must resolve through the pack refs table',
            actual: 'LOD reference is out of bounds, malformed, or has invalid coverage metadata',
            reason: 'metadata-invalid',
            actualFacts: { field: 'metadata' },
          }),
        } as never;
      }
      return meshLoader.load(
        {
          vertices: decoded.value.vertices,
          ...(decoded.value.indices !== undefined ? { indices: decoded.value.indices } : {}),
          submeshes: decoded.value.submeshes,
          ...(decoded.value.collision === undefined ? {} : { collision: decoded.value.collision }),
          ...(decoded.value.cardLayout === undefined
            ? {}
            : { cardLayout: decoded.value.cardLayout }),
          materialSlots,
          ...(decoded.value.aabb !== undefined ? { aabb: decoded.value.aabb } : {}),
          ...(decoded.value.morphTargets !== undefined
            ? { morphTargets: decoded.value.morphTargets }
            : {}),
          ...(decoded.value.morphWeights !== undefined
            ? { morphWeights: decoded.value.morphWeights }
            : {}),
          ...(parsedLods.value.lods === undefined ? {} : { lods: parsedLods.value.lods }),
          ...(parsedLods.value.lodHysteresis === undefined
            ? {}
            : { lodHysteresis: parsedLods.value.lodHysteresis }),
          attributes: decoded.value.attributes,
        },
        input.refs,
        ctx,
      );
    };
    const mesh = loadGeometry();
    if (distanceField === undefined && fieldArtifact === undefined) return mesh;
    const failure = (reason: string) =>
      ({
        ok: false,
        error: new AssetError({
          code: 'asset-parse-failed',
          expected: 'a complete Mesh distance field matching geometry and source sidedness',
          hint: 'Recook and republish the same mesh GUID through its source Meta.',
          detail: { field: 'distanceField', value: distanceField, reason },
        }),
      }) as never;
    if (mesh === undefined || !('kind' in mesh) || mesh.kind !== 'mesh') return mesh;
    if (!fieldArtifact) return failure('mesh distance field artifact is missing');
    const { assetCodec, integrity } = fieldArtifact.descriptor;
    if (
      assetCodec?.name !== MESH_VISIBILITY_DISTANCE_FIELD_CODEC.name ||
      assetCodec.version !== MESH_VISIBILITY_DISTANCE_FIELD_CODEC.version ||
      (assetCodec.profile !== MESH_VISIBILITY_DISTANCE_FIELD_CODEC.profile &&
        assetCodec.profile !== MESH_GEOMETRIC_DISTANCE_FIELD_CODEC.profile)
    )
      return failure('unsupported mesh distance field artifact codec');
    if (!integrity) return failure('mesh distance field artifact integrity is missing');
    const artifact = { integrity: { ...integrity }, assetCodec: { ...assetCodec } };
    return attachMeshDistanceField(mesh as TypesMeshAsset, distanceField, fieldArtifact.bytes).then(
      (result) => {
        if (!result.ok) return failure(result.error.detail.reason);
        const field = result.value.distanceField;
        if (!field) return failure('mesh distance field attachment is missing');
        const codec =
          field.policy.kind === 'sampled-visibility'
            ? MESH_VISIBILITY_DISTANCE_FIELD_CODEC
            : MESH_GEOMETRIC_DISTANCE_FIELD_CODEC;
        if (artifact.assetCodec.profile !== codec.profile)
          return failure('mesh distance field codec policy mismatch');
        return {
          ok: true as const,
          value: {
            ...result.value,
            distanceField: {
              ...field,
              artifact,
            },
          },
        };
      },
    );
  },
};

/** Scene loading is structural; component references bind through World-local reflection. */
export const sceneLoader: Loader = {
  kind: 'scene',
  load(payload, refs, _ctx: LoadContext) {
    const result = parseScenePayload(payload, refs === undefined ? undefined : [...refs]);
    if (result === undefined) return undefined;
    return result as Asset;
  },
};

/**
 * feat-20260613-material-paramschema-driven-binding M4 / w22 (D-5 graceful):
 * the legacy hardcoded texture-field allowlist Set has been removed
 * (AC-03). The materialLoader now consults `ctx.getMaterialShaderTextureFieldNames`
 * (paramSchema-derived via derive()) to know which values fields carry
 * refs[] indices. When the shader is not yet registered (cross-worktree
 * shader-late-register path, plan R-4), the loader falls back to attempting
 * resolution on every int-typed paramValue in [0, refs.length) — M4 / w23's
 * extract-layer paramSchema validation catches misclassifications and routes
 * unresolved texture slots through `MISSING_TEXTURE_HANDLE`.
 */
function collectShaderTextureFieldNames(
  passesFromPayload: unknown,
  ctx: LoadContext,
): ReadonlySet<string> | undefined {
  if (!Array.isArray(passesFromPayload) || passesFromPayload.length === 0) return undefined;
  const lookup = ctx.getMaterialShaderTextureFieldNames;
  if (lookup === undefined) return undefined;
  const collected = new Set<string>();
  let anyResolved = false;
  for (const pass of passesFromPayload) {
    const shaderId = (pass as { program?: { module?: unknown } }).program?.module;
    if (typeof shaderId !== 'string' || shaderId.length === 0) continue;
    const fields = lookup(shaderId);
    if (fields === undefined) continue;
    anyResolved = true;
    for (const name of fields) collected.add(name);
  }
  return anyResolved ? collected : undefined;
}

function refGuidAt(refs: readonly unknown[] | undefined, index: number): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index >= (refs?.length ?? 0)) return undefined;
  const guid = refs?.[index];
  if (typeof guid === 'string') return guid;
  if (typeof guid === 'object' && guid !== null && 'guid' in guid) {
    const nestedGuid = (guid as { guid?: unknown }).guid;
    return typeof nestedGuid === 'string' ? nestedGuid : undefined;
  }
  return undefined;
}

function isIdentityTextureCoordinates(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const coordinates = value as Record<string, unknown>;
  if (Object.keys(coordinates).some((key) => key !== 'set' && key !== 'transform')) return false;
  const transform = coordinates.transform;
  if (
    transform !== undefined &&
    (typeof transform !== 'object' || transform === null || Array.isArray(transform))
  ) {
    return false;
  }
  if (
    transform !== undefined &&
    Object.keys(transform as Record<string, unknown>).some(
      (key) => key !== 'offset' && key !== 'scale' && key !== 'rotation',
    )
  ) {
    return false;
  }
  const resolved = resolveMaterialTextureCoordinates(coordinates as MaterialTextureCoordinates);
  return (
    resolved.set === 0 &&
    resolved.transform.offset[0] === 0 &&
    resolved.transform.offset[1] === 0 &&
    resolved.transform.scale[0] === 1 &&
    resolved.transform.scale[1] === 1 &&
    resolved.transform.rotation === 0
  );
}

function compactTextureValue(value: Record<string, unknown>): unknown {
  const compact = { ...value };
  if (isIdentityTextureCoordinates(compact.coordinates)) delete compact.coordinates;
  return compact;
}

/** material loader — passes + values + serialized parent GUID -> parentGuid. */
export const materialLoader: Loader = {
  kind: 'material',
  load(payload, refs, ctx: LoadContext) {
    const matPayload = payload;
    const passesFromPayload = matPayload.passes;
    const cooked = matPayload.cooked;
    const rawParamValues = (matPayload.values as Record<string, unknown>) ?? {};
    const staticSwitches = matPayload.staticSwitches;
    if (staticSwitches !== undefined && !isMaterialStaticSwitches(staticSwitches)) return undefined;

    let parentGuid: string | undefined;
    if (typeof matPayload.parent === 'string') {
      parentGuid = matPayload.parent;
    } else if (typeof matPayload.parent === 'number') {
      const idx = matPayload.parent;
      const refsArr = refs ?? [];
      if (idx >= 0 && idx < refsArr.length) {
        parentGuid = refGuidAt(refsArr, idx);
      }
      if (parentGuid === undefined) {
        return undefined;
      }
    }

    // A parent-bearing row is a strict child contract. Root-owned fields are
    // rejected before values/ref projection so an invalid child can never be
    // registered with a half-inherited pass/schema payload. Object.hasOwn is
    // intentional: even `{ passes: undefined }` is an authored forbidden
    // field at the JSON loading boundary.
    if (
      parentGuid !== undefined &&
      MATERIAL_CHILD_FORBIDDEN_FIELDS.some((field) => Object.hasOwn(matPayload, field))
    ) {
      return undefined;
    }

    // Numeric refs require a declared texture field. Children carry no schema,
    // so their serialized texture references use { texture, sampler? }; bare
    // numbers remain values even when they happen to index refs (including parent).
    const values: Record<string, unknown> = { ...rawParamValues };
    if (refs && refs.length > 0) {
      const shaderTextureFields = collectShaderTextureFieldNames(passesFromPayload, ctx);
      const authoredTextureFields = Array.isArray(matPayload.parameters)
        ? new Set(
            matPayload.parameters
              .filter(
                (parameter): parameter is { name: string; type: string } =>
                  typeof parameter === 'object' &&
                  parameter !== null &&
                  'name' in parameter &&
                  typeof parameter.name === 'string' &&
                  'type' in parameter &&
                  isMaterialTextureParameterType(parameter.type),
              )
              .map((parameter) => parameter.name),
          )
        : undefined;
      const textureFields =
        authoredTextureFields !== undefined
          ? new Set([...(shaderTextureFields ?? []), ...authoredTextureFields])
          : shaderTextureFields;
      // Walk every value so the structured MaterialTextureValue shape remains
      // resolvable even when a shader is registered with an empty/late
      // paramSchema (pbr-skin currently takes this path). Scalar values still
      // require schema membership below, so metallic/roughness integers are
      // never mistaken for refs indices merely because the schema is empty.
      const candidateFields = Object.keys(values);
      for (const fieldName of candidateFields) {
        const value = values[fieldName];
        if (typeof value === 'number' && Number.isInteger(value)) {
          if (!textureFields?.has(fieldName)) {
            continue;
          }
          const refGuid = refGuidAt(refs, value);
          if (refGuid === undefined) {
            delete values[fieldName];
            continue;
          }
          values[fieldName] = { texture: refGuid };
          continue;
        }

        // glTF materials use the engine's structured MaterialTextureValue
        // shape (`{ texture: <refs index> }`), not the legacy scalar form.
        // Resolve that nested index at the same loader boundary; leaving zero
        // here is a valid-looking handle that silently renders the material
        // white and never reaches the browser console as an exception.
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          const textureIndex = (value as { texture?: unknown }).texture;
          if (typeof textureIndex !== 'number' || !Number.isInteger(textureIndex)) continue;
          const textureGuid = refGuidAt(refs, textureIndex);
          if (textureGuid === undefined) {
            if (textureFields !== undefined) delete values[fieldName];
            continue;
          }
          const resolved: Record<string, unknown> = {
            ...(value as Record<string, unknown>),
            texture: textureGuid,
          };
          const samplerIndex = resolved.sampler;
          if (typeof samplerIndex === 'number' && Number.isInteger(samplerIndex)) {
            const samplerGuid = refGuidAt(refs, samplerIndex);
            if (samplerGuid === undefined) delete resolved.sampler;
            else resolved.sampler = samplerGuid;
          }
          values[fieldName] = compactTextureValue(resolved);
        }
      }
    }

    if (Array.isArray(passesFromPayload) && passesFromPayload.length > 0) {
      return {
        kind: 'material',
        ...(cooked === undefined ? {} : { cooked }),
        passes: passesFromPayload as readonly MaterialPass[],
        parameters: matPayload.parameters,
        ...(staticSwitches === undefined ? {} : { staticSwitches }),
        ...(matPayload.particleInputs === undefined
          ? {}
          : { particleInputs: matPayload.particleInputs as MaterialAsset['particleInputs'] }),
        ...(matPayload.surface === undefined
          ? {}
          : { surface: matPayload.surface as MaterialAsset['surface'] }),
        values,
        colorSpace: matPayload.colorSpace,
        parentGuid,
      } as MaterialAsset & { parentGuid?: string };
    }

    if (parentGuid !== undefined) {
      return {
        kind: 'material',
        ...(cooked === undefined ? {} : { cooked }),
        values,
        parentGuid,
        ...(staticSwitches === undefined ? {} : { staticSwitches }),
      } as unknown as MaterialAsset & { parentGuid?: string };
    }

    return undefined;
  },
};

/** sampler loader — preserve the serialised SamplerAsset descriptor. */
export const samplerLoader: Loader = {
  kind: 'sampler',
  load(payload) {
    const filters = new Set<FilterMode>(['nearest', 'linear']);
    const mipmapFilters = new Set<GPUMipmapFilterMode>(['nearest', 'linear']);
    const addressModes = new Set<AddressMode>(['clamp-to-edge', 'repeat', 'mirror-repeat']);
    const compareFunctions = new Set<CompareFunction>([
      'never',
      'less',
      'equal',
      'less-equal',
      'greater',
      'not-equal',
      'greater-equal',
      'always',
    ]);
    const stringField = <T extends string>(
      key: string,
      allowed: ReadonlySet<T>,
    ): T | undefined | null => {
      const value = payload[key];
      if (value === undefined) return undefined;
      return typeof value === 'string' && allowed.has(value as T) ? (value as T) : null;
    };
    const magFilter = stringField('magFilter', filters);
    const minFilter = stringField('minFilter', filters);
    const mipmapFilter = stringField('mipmapFilter', mipmapFilters);
    const addressModeU = stringField('addressModeU', addressModes);
    const addressModeV = stringField('addressModeV', addressModes);
    const addressModeW = stringField('addressModeW', addressModes);
    const compare = stringField('compare', compareFunctions);
    if (
      magFilter === null ||
      minFilter === null ||
      mipmapFilter === null ||
      addressModeU === null ||
      addressModeV === null ||
      addressModeW === null ||
      compare === null
    ) {
      return undefined;
    }
    const numericField = (key: string): number | undefined | null => {
      const value = payload[key];
      if (value === undefined) return undefined;
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    };
    const lodMinClamp = numericField('lodMinClamp');
    const lodMaxClamp = numericField('lodMaxClamp');
    const maxAnisotropy = numericField('maxAnisotropy');
    if (lodMinClamp === null || lodMaxClamp === null || maxAnisotropy === null) return undefined;
    return {
      kind: 'sampler',
      ...(magFilter === undefined ? {} : { magFilter }),
      ...(minFilter === undefined ? {} : { minFilter }),
      ...(mipmapFilter === undefined ? {} : { mipmapFilter }),
      ...(addressModeU === undefined ? {} : { addressModeU }),
      ...(addressModeV === undefined ? {} : { addressModeV }),
      ...(addressModeW === undefined ? {} : { addressModeW }),
      ...(lodMinClamp === undefined ? {} : { lodMinClamp }),
      ...(lodMaxClamp === undefined ? {} : { lodMaxClamp }),
      ...(compare === undefined ? {} : { compare }),
      ...(maxAnisotropy === undefined ? {} : { maxAnisotropy }),
    };
  },
};

/** skeleton loader — inverseBindMatrices stride validation.
 *
 * bug-20260611: accept both `Float32Array` (in-memory: dawn smoke / direct
 * `register` test) AND `number[]` (post-`JSON.stringify` shape: `normaliseForPack`
 * in @forgeax/engine-import flattens every typed array to a plain Array so
 * `JSON.stringify(pack)` survives the dev-server / build-mode round-trip --
 * the same dual contract `meshLoader` already honours). Without the array arm
 * the .pack.json -> fetch -> JSON.parse path lands a plain object whose
 * `instanceof Float32Array` check fails, surfacing as `asset-parse-failed`
 * for any glTF carrying a Skin (e.g. Khronos Fox.glb).
 */
export const skeletonLoader: Loader = {
  kind: 'skeleton',
  load(payload) {
    const ibmRaw = payload.inverseBindMatrices;
    const jointCount = typeof payload.jointCount === 'number' ? payload.jointCount : 0;
    let ibm: Float32Array;
    if (ibmRaw instanceof Float32Array) {
      ibm = ibmRaw;
    } else if (Array.isArray(ibmRaw)) {
      ibm = new Float32Array(ibmRaw as number[]);
    } else {
      return undefined;
    }
    if (ibm.byteLength !== jointCount * 64) return undefined;
    const boundsRaw = payload.bounds;
    const bounds =
      boundsRaw instanceof Float32Array
        ? boundsRaw
        : Array.isArray(boundsRaw)
          ? new Float32Array(boundsRaw as number[])
          : undefined;
    if (bounds !== undefined && bounds.length !== 6) return undefined;
    const shadowCapsules =
      payload.shadowCapsules === undefined
        ? undefined
        : parseShadowCapsuleSet(payload.shadowCapsules, jointCount);
    if (payload.shadowCapsules !== undefined && shadowCapsules === undefined) return undefined;
    return {
      kind: 'skeleton',
      inverseBindMatrices: ibm,
      jointCount,
      ...(bounds === undefined ? {} : { bounds }),
      ...(shadowCapsules === undefined ? {} : { shadowCapsules }),
    };
  },
};

/** skin loader — skeletonGuid + jointPaths validation. */
export const skinLoader: Loader = {
  kind: 'skin',
  load(payload) {
    const skeletonGuid = payload.skeletonGuid;
    const jointPathsRaw = payload.jointPaths;
    if (typeof skeletonGuid !== 'string') return undefined;
    if (!Array.isArray(jointPathsRaw)) return undefined;
    const jointPaths: string[] = [];
    for (const item of jointPathsRaw) {
      if (typeof item !== 'string') return undefined;
      jointPaths.push(item);
    }
    return { kind: 'skin', skeletonGuid, jointPaths };
  },
};

/** animation-clip loader — channels / sampler validation.
 *
 * bug-20260611: sampler.input / sampler.output accept both `Float32Array`
 * (in-memory) and `number[]` (post-`JSON.stringify` shape produced by
 * `normaliseForPack`). Same dual contract as `skeletonLoader` /
 * `meshLoader`; without it the dev `.pack.json` round-trip surfaces every
 * skinned-with-animation glTF as `asset-parse-failed`.
 */
export const animationClipLoader: Loader = {
  kind: 'animation-clip',
  load(payload) {
    const duration = typeof payload.duration === 'number' ? payload.duration : 0;
    if (!Number.isFinite(duration) || duration < 0) return undefined;
    const channelsRaw = payload.channels;
    if (!Array.isArray(channelsRaw)) return undefined;
    const channels: AnimationChannel[] = [];
    for (const ch of channelsRaw) {
      if (typeof ch !== 'object' || ch === null) return undefined;
      const chObj = ch as Record<string, unknown>;
      const targetId = chObj.targetId;
      const property = chObj.property;
      const samplerObj = chObj.sampler as Record<string, unknown> | undefined;
      if (
        typeof targetId !== 'string' ||
        !/^[0-9a-f]{32}$/.test(targetId) ||
        Object.keys(chObj).some(
          (key) =>
            key !== 'targetId' &&
            key !== 'property' &&
            key !== 'sampler' &&
            !(chObj.property === 'property' && key === 'binding'),
        )
      ) {
        return undefined;
      }
      if (
        property !== 'translation' &&
        property !== 'rotation' &&
        property !== 'scale' &&
        property !== 'weights' &&
        property !== 'property'
      )
        return undefined;
      if (samplerObj === undefined) return undefined;
      const inputRaw = samplerObj.input;
      const outputRaw = samplerObj.output;
      const interpolation = samplerObj.interpolation;
      let input: Float32Array;
      if (inputRaw instanceof Float32Array) {
        input = inputRaw;
      } else if (Array.isArray(inputRaw)) {
        input = new Float32Array(inputRaw as number[]);
      } else {
        return undefined;
      }
      if (
        input.length === 0 ||
        input.some(
          (time, index) =>
            !Number.isFinite(time) || time < 0 || (index > 0 && time <= (input[index - 1] ?? NaN)),
        )
      )
        return undefined;
      if (
        property === 'property' &&
        Array.isArray(outputRaw) &&
        (outputRaw.every((value) => typeof value === 'string') ||
          outputRaw.every((value) => typeof value === 'boolean'))
      ) {
        if (
          interpolation !== 'STEP' ||
          typeof chObj.binding !== 'string' ||
          chObj.binding.length === 0
        )
          return undefined;
        channels.push({
          targetId: targetId as AnimationChannel['targetId'],
          property,
          binding: chObj.binding,
          sampler: { input, output: outputRaw as string[] | boolean[], interpolation },
        });
        continue;
      }
      let output: Float32Array;
      if (outputRaw instanceof Float32Array) {
        output = outputRaw;
      } else if (Array.isArray(outputRaw)) {
        output = new Float32Array(outputRaw as number[]);
      } else {
        return undefined;
      }
      if (interpolation !== 'LINEAR' && interpolation !== 'STEP' && interpolation !== 'CUBICSPLINE')
        return undefined;
      const factor = interpolation === 'CUBICSPLINE' ? 3 : 1;
      const width = output.length / input.length / factor;
      if (
        input.length < (factor === 3 ? 2 : 1) ||
        !Number.isInteger(width) ||
        width < 1 ||
        output.some((value) => !Number.isFinite(value)) ||
        ((property === 'translation' || property === 'scale') && width !== 3) ||
        (property === 'rotation' && width !== 4) ||
        (property === 'weights' && width > 8)
      )
        return undefined;
      if (property === 'property') {
        if (typeof chObj.binding !== 'string' || chObj.binding.length === 0) return undefined;
        channels.push({
          targetId: targetId as AnimationChannel['targetId'],
          property,
          binding: chObj.binding,
          sampler: { input, output, interpolation },
        });
      } else
        channels.push({
          targetId: targetId as AnimationChannel['targetId'],
          property,
          sampler: { input, output, interpolation },
        });
    }
    if (payload.events !== undefined && !Array.isArray(payload.events)) return undefined;
    return {
      kind: 'animation-clip',
      duration,
      channels,
      ...(payload.events === undefined ? {} : { events: payload.events }),
    };
  },
};

/** animation-graph loader — pack payload -> AnimationGraph POD.
 *
 * feat-20260713-animation-state-machine-plugin M4 / w30 (plan D-4 landing (3)):
 * the inverse of `serializeAnimationGraph` (runtime). Each Clip leaf's `clip`
 * field arrives as a `refs[]` index (small int); the loader resolves it back to
 * the GUID string verbatim, leaving GUID -> handle re-resolution to the ECS/use
 * time (the same "GUID at load, handle at use" contract materialLoader honours
 * for parentGuid / values texture fields, asset-registry D-19). Blend/Add
 * node references + `root` are intra-graph node indices, validated against the
 * node count. A malformed payload (out-of-range refs / node index, bad node
 * shape, non-finite weight) returns `undefined` so the load-by-guid path
 * surfaces the existing `asset-parse-failed` error code (AC-14).
 *
 * OOS-7: reconstructs only an engine-authored graph's topology; no DCC-import
 * metadata is consumed.
 */
export const animationGraphLoader: Loader = {
  kind: 'animation-graph',
  load(payload, refs) {
    const rawNodes = payload.nodes;
    const root = payload.root;
    if (!Array.isArray(rawNodes)) return undefined;
    const nodeCount = rawNodes.length;
    const isNodeIndex = (value: unknown): value is number =>
      typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < nodeCount;
    if (!isNodeIndex(root)) return undefined;
    const refsArr = refs ?? [];

    const nodes: AnimationGraphNode[] = [];
    for (const rawNode of rawNodes) {
      if (typeof rawNode !== 'object' || rawNode === null) return undefined;
      const node = rawNode as Record<string, unknown>;
      const weight = node.weight;
      if (typeof weight !== 'number' || !Number.isFinite(weight)) return undefined;

      if (node.type === 'clip') {
        const refIndex = node.clip;
        if (typeof refIndex !== 'number' || !Number.isInteger(refIndex)) return undefined;
        if (refIndex < 0 || refIndex >= refsArr.length) return undefined;
        const guid = refsArr[refIndex];
        if (typeof guid !== 'string') return undefined;
        // GUID verbatim at load; re-resolved to a handle at use time (D-19).
        nodes.push({
          type: 'clip',
          clip: guid,
          weight,
        });
      } else if (node.type === 'blend') {
        const children = node.children;
        if (!Array.isArray(children) || !children.every(isNodeIndex)) return undefined;
        nodes.push({ type: 'blend', children: [...(children as number[])], weight });
      } else if (node.type === 'add') {
        const base = node.base;
        const additive = node.additive;
        if (!isNodeIndex(base)) return undefined;
        if (!Array.isArray(additive) || !additive.every(isNodeIndex)) return undefined;
        nodes.push({ type: 'add', base, additive: [...(additive as number[])], weight });
      } else {
        return undefined;
      }
    }

    return { kind: 'animation-graph', nodes, root } as AnimationGraph;
  },
};

/** audio loader -- restore the durable descriptor; host decode stays elsewhere. */
export const audioLoader: Loader = {
  kind: 'audio',
  load(payload) {
    const sourceKey = payload.sourceKey;
    const mediaType = payload.mediaType;
    if (typeof sourceKey !== 'string' || sourceKey.length === 0) return undefined;
    if (typeof mediaType !== 'string' || mediaType.length === 0) return undefined;
    const rawBytes = payload.bytes;
    const bytes =
      rawBytes instanceof Uint8Array
        ? rawBytes
        : Array.isArray(rawBytes)
          ? new Uint8Array(rawBytes as number[])
          : undefined;
    return {
      kind: 'audio',
      sourceKey,
      mediaType,
      ...(bytes === undefined ? {} : { bytes }),
    } as AudioClipAsset;
  },
};

/** particle loader -- restore the complete cooked program without a GPU device. */
export const particleEffectLoader: Loader = {
  kind: 'particle-effect',
  load(payload) {
    if (typeof payload.program !== 'object' || payload.program === null) return undefined;
    if (typeof (payload.program as Record<string, unknown>).fingerprint !== 'string') {
      return undefined;
    }
    return { ...payload, kind: 'particle-effect' } as ParticleEffectAsset;
  },
};

export { renderPipelineLoader, tilesetLoader } from './pack-artifact';

/**
 * The eight inline pack-payload loaders, in the historical `if`-chain order
 * (the animation-graph loader, feat-20260713 M4 / w30, appends after the clip
 * loader). `wireDefaultLoaders` (w5) registers these plus the texture / font /
 * equirect loaders (w6) and the audio placeholder (w8).
 */
export const INLINE_PACK_LOADERS: readonly Loader[] = [
  meshLoader,
  sceneLoader,
  samplerLoader,
  materialLoader,
  skeletonLoader,
  skinLoader,
  animationClipLoader,
  animationGraphLoader,
  renderPipelineLoader,
  tilesetLoader,
  audioLoader,
  particleEffectLoader,
];

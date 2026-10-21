// bridge.ts - public gltfDocToSceneAsset SSOT (M3 w9 / feat-20260518).
//
// Excises the previously inline 80-line implementation in
// apps/hello/gltf/src/main.ts. AI users get a single import path:
//
// ```ts
// import { gltfDocToSceneAsset, toMaterialAsset } from '@forgeax/engine-gltf';
// const scene = gltfDocToSceneAsset(doc, { meshHandles, materialHandles });
// ```
//
// Pure function: no fs, no fetch, no throw. Walks the default scene's
// node graph depth-first, accumulating world transforms for children (B3).
// Handles for mesh / material come from caller-supplied Map lookups so the
// bridge stays runtime-agnostic.
//
// feat-20260608-mesh-multi-section-primitive-multi-material-slot M3 / w13+w15:
// (B1) N prim per glTF mesh merged into 1 entity with MeshRenderer.materials[]
// (B2) visit recursively walks ir.children
// (B3) child world pos accumulates parent transform
// (B6) camera detection via GltfNodeIr.camera field (not legacy nodes[1] heuristic)

import {
  computeTangentVec4,
  meshMaterialSlotsFromTopology,
  packInterleavedVertexAttributes,
  writeNormalPlaneTangent,
} from '@forgeax/engine-geometry';
import type { Mat4 } from '@forgeax/engine-math';
import { box3, mat4, quat, vec3 } from '@forgeax/engine-math';
import type {
  AssetGuid,
  AssetHandle,
  LocalEntityId,
  MaterialAsset,
  MaterialError,
  MaterialPass,
  MaterialTextureValue,
  MeshAsset,
  MorphTarget,
  RenderQueue,
  Result,
  SceneAsset,
  Submesh,
  VertexAttributeMap,
} from '@forgeax/engine-types';
import {
  createMeshMaterialSlotTable,
  type MeshMaterialSlotSource,
  STANDARD_LAYER_PARAMETER_GROUPS,
  STANDARD_SURFACE_PARAM_SCHEMA,
  STANDARD_TRANSMISSION_PARAMETER_NAMES,
  standardMaterialParameters,
  unlitMaterialParameters,
} from '@forgeax/engine-types';
import { createMaterialError, err, type GltfError, gltfErr, ok } from './errors.js';
import {
  GLTF_MATERIAL_TEXTURE_SLOTS,
  type GltfMaterialTextureSlot,
  materialTextureBinding,
} from './material/parse-material.js';
import type {
  GltfDoc,
  GltfMaterialIr,
  GltfMeshIr,
  GltfPunctualLightIr,
  GltfTextureInfoIr,
} from './parse-gltf.js';
import { GLTF_UV_SET_COUNT, gltfMeshUvSet } from './parse-gltf.js';

function copyVertexStream(
  target: Float32Array | Uint16Array,
  source: Float32Array | Uint16Array,
  offset: number,
  count: number,
): void {
  // Keep the existing bounded typed-array conversion for short source lanes:
  // undefined becomes NaN in float streams and zero in joint indices.
  for (let i = 0; i < count; i++) target[offset + i] = source[i] as number;
}

/**
 * Convert one or more parsed `GltfMeshIr` primitives sharing the same glTF
 * mesh-index into a single runtime `MeshAsset` POD. Each primitive becomes one
 * `Submesh` row; per-primitive vertex data is concatenated into one big
 * interleaved vertex buffer (12 floats / vertex for unskinned meshes; 18 floats
 * / vertex when any primitive carries `joints0` + `weights0`), and per-primitive
 * index buffers are concatenated into one big index buffer. Each submesh's
 * indices are biased by the running vertex offset so they reference vertices
 * within the merged buffer.
 *
 * Per-MeshAsset stride decision (D-2): if any primitive contains skin
 * attributes, the entire MeshAsset is promoted to 18-float stride and
 * unskinned primitives' skin slots are zero-filled (joints {0,0,0,0} +
 * weights {0,0,0,0}). This avoids splitting one glTF mesh into multiple
 * MeshAsset rows when a model mixes skinned and unskinned primitives.
 *
 * AI users get a 1-to-1 mapping with `MeshRenderer.materials[]`: the i-th
 * submesh is the i-th primitive of the i-th material slot.
 *
 * Pure function (no fs / fetch / registry). Missing attributes fall back to
 * identity defaults per primitive: normal -> +Y, uv -> 0, tangent -> +X with
 * w=1.
 *
 * Invalid source data is returned as a typed `GltfError`; callers must branch
 * on `Result.ok` before publishing a MeshAsset. Caller (gltfImporter / smoke
 * driver) is responsible for grouping by `meshIr.meshIndex` before calling.
 */
export function meshIrToMeshAsset(
  prims: readonly GltfMeshIr[],
  materials: MeshMaterialSlotSource = {},
): Result<MeshAsset, GltfError> {
  if (prims.length === 0) {
    return err(
      gltfErr('gltf-mesh-bridge-invalid', {
        reason: 'empty-input',
        primitiveCount: 0,
      }),
    );
  }
  let totalVertexCount = 0;
  let totalIndexCount = 0;
  let hasAnySkin = false;
  const hasAnyColor = prims.some((p) => p.colors0 !== undefined);
  let hasAnyIndices = false;
  // feat-20260629-multi-uv-set-support m1-w3: derive the widest canonical UV
  // key list across all primitives so the geometry projection accommodates it.
  let widestUvIndex = 0;
  const morphTargetCount = prims[0]?.morphTargets?.length ?? 0;
  for (const p of prims) {
    const primVc = p.positions.length / 3;
    totalVertexCount += primVc;
    if (p.indices !== undefined) {
      totalIndexCount += p.indices.length;
      hasAnyIndices = true;
    } else {
      totalIndexCount += primVc;
    }
    if (p.joints0 !== undefined && p.weights0 !== undefined) hasAnySkin = true;
    if ((p.morphTargets?.length ?? 0) !== morphTargetCount) {
      return err(
        gltfErr('gltf-mesh-bridge-invalid', {
          meshIndex: p.meshIndex,
          primitiveIndex: prims.indexOf(p),
          reason: 'morph-count-mismatch',
          expectedTargetCount: morphTargetCount,
          actualTargetCount: p.morphTargets?.length ?? 0,
        }),
      );
    }
    // Count present UV sets in this primitive.
    for (let k = GLTF_UV_SET_COUNT - 1; k >= 1; k--) {
      if (gltfMeshUvSet(p, k) !== undefined) {
        widestUvIndex = Math.max(widestUvIndex, k);
        break;
      }
    }
  }

  const uvKeys = Array.from({ length: widestUvIndex }, (_, index) => `uv${index + 1}`);

  const positionsCat = new Float32Array(totalVertexCount * 3);
  const normalsCat = new Float32Array(totalVertexCount * 3);
  const uvsCat = new Float32Array(totalVertexCount * 2);
  const tangentsCat = new Float32Array(totalVertexCount * 4);
  const colorsCat = hasAnyColor ? new Float32Array(totalVertexCount * 4) : undefined;
  const morphTargets: MorphTarget[] = Array.from({ length: morphTargetCount }, (_, targetIndex) => {
    const source = prims[0]?.morphTargets?.[targetIndex];
    return {
      ...(source?.position === undefined
        ? {}
        : { position: new Float32Array(totalVertexCount * 3) }),
      ...(source?.normal === undefined ? {} : { normal: new Float32Array(totalVertexCount * 3) }),
      ...(source?.tangent === undefined ? {} : { tangent: new Float32Array(totalVertexCount * 4) }),
    };
  });
  // feat-20260629-multi-uv-set-support m1-w3: per-UV-set standalone typed arrays
  // for MeshAsset.attributes (uv1..uvK). Allocated only for imported sets.
  const uvCats = uvKeys.map(() => new Float32Array(totalVertexCount * 2));
  // D-2 / w8: when promoted to a skinned projection, retain canonical
  // standalone arrays; the geometry packer owns the interleaved GPU bytes.
  const skinIndicesCat = hasAnySkin ? new Uint16Array(totalVertexCount * 4) : undefined;
  const skinWeightsCat = hasAnySkin ? new Float32Array(totalVertexCount * 4) : undefined;
  // Multi-primitive merge biases each primitive's index range by the running
  // vertex offset, so the merged max index is `totalVertexCount - 1`. When a
  // glTF mesh has > 65535 vertices across all primitives (common for
  // moderately complex scenes like Sponza at ~192k verts), Uint16 overflows
  // and we must widen to Uint32. WebGPU's setIndexBuffer takes 'uint16' or
  // 'uint32' (auto-selected by the runtime via TypedArray.constructor); both
  // are supported by every WebGPU device.
  // bug-20260612 hello-skin visual layered gate: when no primitive carries
  // indices (glTF non-indexed geometry per spec — primitive.indices optional),
  // route MeshAsset.indices to undefined so the runtime takes the
  // pass.draw(vertexCount) non-indexed path. Mixed bags (some prims indexed,
  // some not) synthesize identity indices for the non-indexed prims so the
  // merged MeshAsset stays single-index-buffer. hasAnyIndices === false
  // skips the index buffer allocation entirely.
  const useUint32 = totalVertexCount > 0xffff;
  const indices: Uint16Array | Uint32Array | undefined = !hasAnyIndices
    ? undefined
    : useUint32
      ? new Uint32Array(totalIndexCount)
      : new Uint16Array(totalIndexCount);
  const submeshes: Submesh[] = [];
  const materialTable = createMeshMaterialSlotTable('gltf', materials);

  let vertexCursor = 0;
  let indexCursor = 0;
  for (const mesh of prims) {
    const materialSlot = materialTable.slotFor(mesh.materialIndex);
    const primVertexCount = mesh.positions.length / 3;
    const primIndexCount = mesh.indices === undefined ? 0 : mesh.indices.length;
    // Repair only undefined source frames; valid authored MikkTSpace tangents
    // retain their direction and handedness. All consumers receive this same MeshAsset.
    let sourceTangents = mesh.tangents;
    const invalid: number[] = [];
    if (sourceTangents !== undefined && mesh.normals !== undefined) {
      for (let i = 0; i < primVertexCount; i++) {
        const nx = mesh.normals[i * 3] ?? 0,
          ny = mesh.normals[i * 3 + 1] ?? 0,
          nz = mesh.normals[i * 3 + 2] ?? 0;
        const tx = sourceTangents[i * 4] ?? 0,
          ty = sourceTangents[i * 4 + 1] ?? 0,
          tz = sourceTangents[i * 4 + 2] ?? 0;
        if (
          Math.hypot(ny * tz - nz * ty, nz * tx - nx * tz, nx * ty - ny * tx) <=
          Math.hypot(nx, ny, nz) * Math.hypot(tx, ty, tz) * 1e-8
        )
          invalid.push(i);
      }
    }
    if (
      (sourceTangents === undefined || invalid.length > 0) &&
      mesh.normals !== undefined &&
      mesh.texcoord0 !== undefined
    ) {
      const generated = computeTangentVec4(
        mesh.positions,
        mesh.normals,
        mesh.texcoord0,
        mesh.indices,
      );
      if (generated.ok) {
        if (sourceTangents === undefined) sourceTangents = generated.value;
        else {
          sourceTangents = sourceTangents.slice();
          for (const i of invalid)
            sourceTangents.set(generated.value.subarray(i * 4, i * 4 + 4), i * 4);
        }
      }
    }
    // Collapsed UVs leave orientation undefined. For an already supplied but
    // parallel frame, use a deterministic normal-plane basis rather than a NaN.
    // This repairs the producer data; it does not infer a meaningful UV direction.
    if (invalid.length > 0 && sourceTangents !== undefined && mesh.normals !== undefined) {
      sourceTangents = sourceTangents.slice();
      for (const i of invalid) {
        const nx = mesh.normals[i * 3] ?? 0,
          ny = mesh.normals[i * 3 + 1] ?? 0,
          nz = mesh.normals[i * 3 + 2] ?? 0;
        const tx = sourceTangents[i * 4] ?? 0,
          ty = sourceTangents[i * 4 + 1] ?? 0,
          tz = sourceTangents[i * 4 + 2] ?? 0;
        if (Math.hypot(ny * tz - nz * ty, nz * tx - nx * tz, nx * ty - ny * tx) > 1e-8) continue;
        if (!writeNormalPlaneTangent(sourceTangents, i * 4, nx, ny, nz))
          return err(
            gltfErr('gltf-mesh-bridge-invalid', {
              reason: 'tangent-frame',
              meshIndex: mesh.meshIndex,
              primitiveIndex: prims.indexOf(mesh),
            }),
          );
      }
    }
    if (mesh.colors0 !== undefined && mesh.colors0.length !== primVertexCount * 4) {
      return err(
        gltfErr('gltf-mesh-bridge-invalid', {
          meshIndex: mesh.meshIndex,
          primitiveIndex: prims.indexOf(mesh),
          reason: 'color-cardinality',
          semantic: 'COLOR_0',
          vertexCount: primVertexCount,
          expectedLength: primVertexCount * 4,
          actualLength: mesh.colors0.length,
        }),
      );
    }
    copyVertexStream(positionsCat, mesh.positions, vertexCursor * 3, primVertexCount * 3);
    if (mesh.normals !== undefined) {
      copyVertexStream(normalsCat, mesh.normals, vertexCursor * 3, primVertexCount * 3);
    } else {
      for (let i = vertexCursor; i < vertexCursor + primVertexCount; i++) normalsCat[i * 3 + 1] = 1;
    }
    if (mesh.texcoord0 !== undefined)
      copyVertexStream(uvsCat, mesh.texcoord0, vertexCursor * 2, primVertexCount * 2);
    if (sourceTangents !== undefined) {
      copyVertexStream(tangentsCat, sourceTangents, vertexCursor * 4, primVertexCount * 4);
    } else {
      for (let i = vertexCursor; i < vertexCursor + primVertexCount; i++) {
        tangentsCat[i * 4] = 1;
        tangentsCat[i * 4 + 3] = 1;
      }
    }
    if (colorsCat !== undefined) {
      if (mesh.colors0 === undefined)
        colorsCat.fill(1, vertexCursor * 4, (vertexCursor + primVertexCount) * 4);
      else copyVertexStream(colorsCat, mesh.colors0, vertexCursor * 4, primVertexCount * 4);
    }
    if (
      skinIndicesCat !== undefined &&
      skinWeightsCat !== undefined &&
      mesh.joints0 !== undefined &&
      mesh.weights0 !== undefined
    ) {
      copyVertexStream(skinIndicesCat, mesh.joints0, vertexCursor * 4, primVertexCount * 4);
      copyVertexStream(skinWeightsCat, mesh.weights0, vertexCursor * 4, primVertexCount * 4);
    }
    for (let k = 1; k <= uvKeys.length; k++) {
      const source = gltfMeshUvSet(mesh, k);
      const target = uvCats[k - 1];
      if (source !== undefined && target !== undefined)
        copyVertexStream(target, source, vertexCursor * 2, primVertexCount * 2);
    }
    // Morph lanes already use bounded subarrays: absent or short lanes stay zero-filled.
    for (let targetIndex = 0; targetIndex < morphTargetCount; targetIndex++) {
      const source = mesh.morphTargets?.[targetIndex];
      const target = morphTargets[targetIndex] as MorphTarget;
      if (source?.position !== undefined && target.position !== undefined)
        target.position.set(source.position.subarray(0, primVertexCount * 3), vertexCursor * 3);
      if (source?.normal !== undefined && target.normal !== undefined)
        target.normal.set(source.normal.subarray(0, primVertexCount * 3), vertexCursor * 3);
      if (source?.tangent !== undefined && target.tangent !== undefined)
        target.tangent.set(source.tangent.subarray(0, primVertexCount * 4), vertexCursor * 4);
    }
    // Bias each submesh's indices by the running vertex offset so they
    // reference into the merged vertex buffer rather than the per-primitive
    // local 0-base. When the merged MeshAsset is non-indexed (hasAnyIndices
    // === false → `indices` is undefined here), skip the bias loop and
    // emit a vertex-only submesh (indexCount=0; runtime dispatches via
    // `pass.draw(vertexCount)`). When mixed (some prims indexed, this one
    // not), synthesize identity indices [vertexCursor..+primVertexCount-1]
    // so the merged single-index-buffer contract holds.
    if (indices !== undefined) {
      if (mesh.indices !== undefined) {
        for (let i = 0; i < primIndexCount; i++) {
          const src = mesh.indices[i] as number;
          indices[indexCursor + i] = src + vertexCursor;
        }
        submeshes.push({
          indexOffset: indexCursor,
          indexCount: primIndexCount,
          vertexCount: primVertexCount,
          topology: 'triangle-list',
          materialSlot,
        });
        indexCursor += primIndexCount;
      } else {
        // mixed bag: synthesize identity indices for this non-indexed prim
        for (let i = 0; i < primVertexCount; i++) {
          indices[indexCursor + i] = vertexCursor + i;
        }
        submeshes.push({
          indexOffset: indexCursor,
          indexCount: primVertexCount,
          vertexCount: primVertexCount,
          topology: 'triangle-list',
          materialSlot,
        });
        indexCursor += primVertexCount;
      }
    } else {
      // pure non-indexed mesh: indexCount=0, vertexCount carries draw count.
      submeshes.push({
        indexOffset: 0,
        indexCount: 0,
        vertexCount: primVertexCount,
        topology: 'triangle-list',
        materialSlot,
      });
    }
    vertexCursor += primVertexCount;
  }

  const attributes: VertexAttributeMap = {
    position: positionsCat,
    normal: normalsCat,
    uv: uvsCat,
    tangent: tangentsCat,
    ...(colorsCat === undefined ? {} : { color: colorsCat }),
    ...(skinIndicesCat === undefined ? {} : { skinIndex: skinIndicesCat }),
    ...(skinWeightsCat === undefined ? {} : { skinWeight: skinWeightsCat }),
    ...Object.fromEntries(uvCats.map((cat, idx) => [`uv${idx + 1}`, cat])),
  };
  const packed = packInterleavedVertexAttributes(attributes, totalVertexCount);
  if (!packed.ok) {
    return err(
      gltfErr('gltf-mesh-bridge-invalid', {
        meshIndex: prims[0]?.meshIndex ?? -1,
        reason: 'layout-invalid',
        cause: packed.error.detail,
      }),
    );
  }

  return ok({
    kind: 'mesh',
    vertices: packed.value.vertices,
    ...(indices === undefined ? {} : { indices }),
    submeshes,
    materialSlots: meshMaterialSlotsFromTopology(materialTable.slots),
    aabb: box3.fromPositions(box3.create(), positionsCat),
    attributes,
    ...(morphTargetCount === 0 ? {} : { morphTargets }),
    ...(prims[0]?.morphWeights === undefined
      ? {}
      : { morphWeights: new Float32Array(prims[0].morphWeights) }),
  });
}

export interface GltfBridgeContext {
  /** glTF mesh index -> registry MeshAsset handle (multi-submesh). */
  readonly meshHandles: ReadonlyMap<number, AssetHandle<'mesh'>>;
  /** glTF material index -> registry MaterialAsset handle. */
  readonly materialHandles: ReadonlyMap<number, AssetHandle<'material'>>;
  /**
   * glTF skin index -> SkeletonAsset GUID (string form). When a GltfNodeIr carries
   * a skin reference, the bridge emits `Skin: { skeleton: <guid-string> }` on
   * that node's entity; AssetRegistry._resolveSceneGuids resolves the GUID to
   * a runtime Handle at instantiate time (same protocol as MeshFilter and
   * MeshRenderer.materials[]). Optional — skinless glTFs pass an empty Map
   * (or omit the field) and the bridge does not emit Skin.
   *
   * tweak-20260611 M6 / D-7: emitting Skin from the bridge means the standard
   * source Scene loading + instantiate path Just Works for skinned glTF;
   * demos no longer need to runtime-parseGlb + post-load patch the SceneAsset.
   * postSpawnResolveJoints (called from AssetRegistry.instantiate) walks the
   * matching SkinAsset.jointPaths against the spawn subtree to fill Skin.joints[].
   */
  readonly skeletonGuidBySkinIndex?: ReadonlyMap<number, string>;
}

interface MutableSceneEntity {
  localId: LocalEntityId;
  components: Record<string, Record<string, unknown>>;
  /** Index into the external `nodes` array, set after push for ChildOf wiring. */
  localIdx: number;
}

function lightDirection(currentWorld: Mat4): readonly [number, number, number] {
  const direction = mat4.getForward(vec3.create(), currentWorld);
  return [direction[0] ?? 0, direction[1] ?? 0, direction[2] ?? -1];
}

function lightComponent(
  light: GltfPunctualLightIr,
  direction: readonly [number, number, number],
): Record<string, unknown> {
  const range = light.range ?? Number.POSITIVE_INFINITY;
  if (light.type === 'directional') {
    return { direction, color: light.color, intensity: light.intensity };
  }
  if (light.type === 'point') {
    return { color: light.color, intensity: light.intensity, range };
  }
  return {
    direction,
    color: light.color,
    intensity: light.intensity,
    range,
    innerConeDeg: ((light.spot?.innerConeAngle ?? 0) * 180) / Math.PI,
    outerConeDeg: ((light.spot?.outerConeAngle ?? Math.PI / 4) * 180) / Math.PI,
    castShadow: false,
  };
}

/**
 * Convert a local TRS (translation, rotation quat, scale) into a Mat4.
 * Uses @forgeax/engine-math out-param style. `out` is mutated in place.
 */
function composeMat4(
  out: Mat4,
  tx: number,
  ty: number,
  tz: number,
  qx: number,
  qy: number,
  qz: number,
  qw: number,
  sx: number,
  sy: number,
  sz: number,
): void {
  const t = vec3.create(tx, ty, tz);
  const r = quat.create();
  r[0] = qx;
  r[1] = qy;
  r[2] = qz;
  r[3] = qw;
  const s = vec3.create(sx, sy, sz);
  mat4.compose(out, t, r, s);
}

/**
 * Convert a parsed GltfDoc into a SceneAsset POD. Caller supplies registry
 * handles via `ctx`; the bridge does no registration of its own.
 *
 * Visits the default scene's nodes depth-first, accumulating world-space
 * transforms from parent to child (B3). Assigns sequential LocalEntityId in
 * document order for reimport-stable identity. Camera nodes are detected by
 * GltfNodeIr.camera (B6 fix).
 *
 * B1: each glTF mesh's N primitives are merged into a single entity.
 * The caller provides `ctx.meshHandles` keyed by glTF mesh index, where each
 * handle points to a MeshAsset whose `submeshes` already span all primitives.
 * `ctx.materialHandles` is keyed by glTF material index; the bridge assembles a
 * `MeshRenderer.materials[]` array from the primitives' materialIndex values
 * in the order they appear in `doc.meshes`.
 *
 * B2: visit recursively walks `ir.children`.
 *
 * D-2 (empty container): transform-only nodes (no mesh, no camera) produce
 * an entity with just Transform + optionally a Name component, preserving the
 * hierarchy for animation/picking hooks.
 */
export function gltfDocToSceneAsset(doc: GltfDoc, ctx: GltfBridgeContext): SceneAsset {
  const sceneIr = doc.scenes[doc.defaultSceneIndex];
  const resultNodes: MutableSceneEntity[] = [];
  if (sceneIr === undefined) return { kind: 'scene', entities: {} } as unknown as SceneAsset;
  const importedLights = doc.lights ?? doc.extensions?.KHR_lights_punctual?.lights ?? [];
  const animationTargetIds = new Map<number, string>();
  for (const clip of doc.animationClips) {
    for (const channel of clip.channels) {
      animationTargetIds.set(channel.targetNodeIndex, channel.targetId);
    }
  }

  // Per-node world matrix accumulator (B3 fix).
  const parentWorld = mat4.create();
  mat4.identity(parentWorld);
  const currentWorld = mat4.create();
  const localMat = mat4.create();

  // bug-20260613: SceneAsset entities also emit ChildOf when a glTF node has a
  // parent (line 547 below). Runtime propagateTransforms then derives
  // GlobalTransform.world via `parent.world * compose(child.local TRS)`. If we
  // wrote the *world* TRS into Transform here, every child node would get
  // baked twice -- once at importer time and again at propagate time --
  // collapsing the skin so vertices fly to (parent.world)^2 space and the
  // mesh appears as a scrambled silhouette. Mirror GltfNodeIr.transform's local
  // TRS verbatim; propagateTransforms is the single accumulation path.
  const pushLocalTransform = (
    transform: import('./transform.js').DecomposedTransform,
  ): Record<string, unknown> => ({
    pos: [
      transform.translation[0] ?? 0,
      transform.translation[1] ?? 0,
      transform.translation[2] ?? 0,
    ],
    // Quaternion component order [x, y, z, w] (glTF-aligned; E6).
    quat: [
      transform.rotation[0] ?? 0,
      transform.rotation[1] ?? 0,
      transform.rotation[2] ?? 0,
      transform.rotation[3] ?? 1,
    ],
    scale: [transform.scale[0] ?? 1, transform.scale[1] ?? 1, transform.scale[2] ?? 1],
  });

  const visit = (gltfNodeIdx: number, parentLocalIdx: number | null): void => {
    const ir = doc.nodes[gltfNodeIdx];
    if (ir === undefined) return;

    // Compute local transform matrix
    composeMat4(
      localMat,
      ir.transform.translation[0] ?? 0,
      ir.transform.translation[1] ?? 0,
      ir.transform.translation[2] ?? 0,
      ir.transform.rotation[0] ?? 0,
      ir.transform.rotation[1] ?? 0,
      ir.transform.rotation[2] ?? 0,
      ir.transform.rotation[3] ?? 1,
      ir.transform.scale[0] ?? 1,
      ir.transform.scale[1] ?? 1,
      ir.transform.scale[2] ?? 1,
    );

    // Accumulate world transform (B3: parent * local)
    if (parentLocalIdx === null) {
      // Root node: world = local
      for (let i = 0; i < 16; i++) {
        currentWorld[i] = localMat[i] ?? 0;
      }
    } else {
      mat4.multiply(currentWorld, parentWorld, localMat);
    }

    // B6: detect camera via GltfNodeIr.camera field (not legacy heuristic)
    const isCamera = ir.camera !== null;

    // D-2: empty container rule
    // - mesh node: MeshFilter + MeshRenderer
    // - camera node: Camera (standalone entity)
    // - transform-only node (no mesh, no camera): Transform-only entity to preserve hierarchy
    const hasMesh = ir.meshIndex !== null;

    // Always produce a node for every glTF node (preserves hierarchy).
    // Transform-only nodes carry just Transform + optionally Name.
    const components: Record<string, Record<string, unknown>> = {
      Transform: pushLocalTransform(ir.transform),
    };

    const importedLight = importedLights[ir.lightIndex ?? -1];
    if (importedLight !== undefined) {
      const componentName =
        importedLight.type === 'directional'
          ? 'DirectionalLight'
          : importedLight.type === 'point'
            ? 'PointLight'
            : 'SpotLight';
      components[componentName] = lightComponent(
        importedLight,
        lightDirection(currentWorld),
      ) as Record<string, unknown>;
    }

    if (ir.name !== undefined && ir.name !== '') {
      components.Name = { value: ir.name };
    }
    const animationTargetId = animationTargetIds.get(gltfNodeIdx);
    if (animationTargetId !== undefined) {
      components.AnimationTargetId = { value: animationTargetId };
    }

    if (hasMesh) {
      const meshHandle = ctx.meshHandles.get(ir.meshIndex as number);
      if (meshHandle !== undefined) {
        components.MeshFilter = { assetHandle: meshHandle };
      }
      const meshMorph = doc.meshes.find((mesh) => mesh.meshIndex === ir.meshIndex);
      const morphCount = meshMorph?.morphTargets?.length ?? 0;
      if (morphCount > 0) {
        const weights = ir.morphWeights ?? meshMorph?.morphWeights ?? new Float32Array(morphCount);
        if (weights.length !== morphCount) {
          throw new Error('gltfDocToSceneAsset: MorphWeights length does not match morph targets');
        }
        components.MorphWeights = { weights: new Float32Array(weights) };
      }
      // tweak-20260611 M6: when this node references a glTF skin, stamp a
      // Skin component carrying the SkeletonAsset GUID as a string. The
      // runtime AssetRegistry._resolveSceneGuids resolves the string to a
      // Handle at instantiate time (same protocol as MeshFilter/MeshRenderer).
      // postSpawnResolveJoints (called from AssetRegistry.instantiate) then
      // fills Skin.joints[] by walking the matching SkinAsset.jointPaths
      // against the spawn subtree's Name index.
      if (ir.skinIndex !== null && ctx.skeletonGuidBySkinIndex !== undefined) {
        const skeletonGuid = ctx.skeletonGuidBySkinIndex.get(ir.skinIndex);
        if (skeletonGuid !== undefined) {
          components.Skin = { skeleton: skeletonGuid };
        }
      }
      // B1: collect one material handle per primitive belonging to THIS
      // node's glTF mesh (filter by meshIr.meshIndex === ir.meshIndex), in
      // the same order primitives are emitted in `doc.meshes`. The merged
      // MeshAsset built by `meshIrToMeshAsset` walks the same filter in the
      // same order to produce one Submesh per primitive, so submeshes[i]
      // pairs with materials[i] positionally (AGENTS.md §Component naming
      // "positional materials[i] <-> submeshes[i]" + #317 multi-material
      // contract).
      //
      // A primitive with materialIndex===null (or one whose ctx.materialHandles
      // lookup misses) gets a synthetic missing-handle entry: dropping it
      // would desynchronise materials[].length vs submeshes[].length and
      // trigger the fail-fast `mesh-renderer-material-count-mismatch` at
      // register time. Falling back to the first available material handle
      // for the same mesh keeps the count alignment without inventing a
      // shared default-material handle (Tier-B scope; Sponza / BoxTextured
      // every primitive carries an explicit material so this fallback path
      // is exercised only by under-specified glTFs).
      // Mesh-owned slots carry imported defaults. Scene nodes persist only
      // true instance differences, so the canonical imported node starts with
      // an empty per-slot override vector.
      components.MeshRenderer = { materials: [] };
    }

    // Scene authoring preserves instance matrices without a Renderer.
    if (ir.instancing !== undefined) {
      components.Instances = { transforms: ir.instancing.transforms };
    }

    if (isCamera) {
      // B6: camera node detected via GltfNodeIr.camera (not heuristic).
      // Camera component sits alongside Transform (and Name if present).
      components.Camera = { ...ir.camera };
    }

    const localIdx = resultNodes.length;
    const node: MutableSceneEntity = {
      localId: localIdx as LocalEntityId,
      components,
      localIdx,
    };

    // ChildOf wiring: if this node has a parent, add ChildOf component
    if (parentLocalIdx !== null) {
      node.components.ChildOf = { parent: parentLocalIdx as LocalEntityId };
    }

    resultNodes.push(node);

    // B2: recursively visit children with accumulated world matrix.
    // B3: set parentWorld to this node's world matrix so children multiply
    // correctly (parent * childLocal = childWorld).
    const savedParent = mat4.clone(parentWorld);
    for (let i = 0; i < 16; i++) parentWorld[i] = currentWorld[i] ?? 0;

    for (const childIdx of ir.children) {
      visit(childIdx, localIdx);
    }

    // Restore parent world after visiting all children
    for (let i = 0; i < 16; i++) parentWorld[i] = savedParent[i] ?? 0;
  };

  for (const rootIdx of sceneIr.nodes) visit(rootIdx, null);

  const keyByLocalId = new Map<number, string>();
  for (const node of resultNodes) keyByLocalId.set(node.localIdx, `node-${node.localIdx}`);
  const entities: Record<string, { readonly components: Record<string, Record<string, unknown>> }> =
    {};
  for (const node of resultNodes) {
    const components = { ...node.components };
    const childOf = components.ChildOf;
    if (childOf !== undefined && typeof childOf.parent === 'number') {
      const parentKey = keyByLocalId.get(childOf.parent);
      if (parentKey === undefined)
        throw new Error(`gltfDocToSceneAsset: missing parent node ${childOf.parent}`);
      components.ChildOf = { ...childOf, parent: parentKey };
    }
    entities[`node-${node.localIdx}`] = { components };
  }
  const lightFacts = importedLights.map((light) => ({
    kind: light.type,
    intensity: light.intensity,
    ...(light.range === undefined ? {} : { range: light.range }),
    ...(light.spot === undefined ? {} : { spot: light.spot }),
  }));
  return {
    kind: 'scene',
    entities,
    ...(lightFacts.length === 0 ? {} : { lights: lightFacts }),
  } as unknown as SceneAsset;
}

export interface MaterialBridgeContext {
  /** glTF texture index -> registry TextureAsset handle. */
  readonly textureHandles?: ReadonlyMap<number, MaterialTextureValue['texture']>;
  /** glTF sampler index -> registry SamplerAsset handle. */
  readonly samplerHandles?: ReadonlyMap<number, NonNullable<MaterialTextureValue['sampler']>>;
  /** Built-in standard MaterialAsset GUID supplied by the importing project. */
  readonly standardRootGuid?: AssetGuid;
  /**
   * feat-20260611 w17-a: when any primitive consuming this material carries
   * JOINTS_0 + WEIGHTS_0, the cooker passes `skinned: true` so the emitted
   * MaterialAsset's pass[0].program.module is `forgeax::pbr-skin` instead of
   * `forgeax::default-standard-pbr`. The cooker (gltf-importer) is the only
   * site with full mesh<->material wiring info; routing here keeps shader
   * choice content-driven (not user-driven, per Q4 — runtime fail-fast in
   * render-system-extract remains the reverse-direction safety net).
   */
  readonly skinned?: boolean;
}

function textureValue(
  info: GltfTextureInfoIr | number | undefined,
  slot: GltfMaterialTextureSlot,
  ctx: MaterialBridgeContext | undefined,
): MaterialTextureValue | undefined {
  const binding = materialTextureBinding(info);
  if (binding === undefined || ctx?.textureHandles === undefined) return undefined;
  const textureHandle = ctx.textureHandles.get(binding.texture);
  if (textureHandle === undefined) return undefined;
  const samplerHandle =
    binding.sampler === undefined ? undefined : ctx.samplerHandles?.get(binding.sampler);
  const coordinates =
    binding.texCoord === undefined && binding.transform === undefined
      ? undefined
      : {
          ...(binding.texCoord === undefined ? {} : { set: binding.texCoord }),
          ...(binding.transform === undefined ? {} : { transform: binding.transform }),
        };
  const value = {
    texture: textureHandle,
    ...(samplerHandle === undefined ? {} : { sampler: samplerHandle }),
    ...(coordinates === undefined ? {} : { coordinates }),
  };
  if (slot === 'occlusionTexture') {
    const occlusion = info as GltfMaterialIr['occlusionTexture'];
    if (typeof occlusion === 'object' && occlusion?.strength !== undefined) {
      return { ...value, occlusionStrength: occlusion.strength };
    }
  }
  return value;
}

/**
 * Select the exact Standard root contract emitted by the glTF producer.
 * Numeric fields come from the shared schema; all texture slots are
 * admitted only when the source actually declares them.  A parent root is
 * retained for the legacy base-only path, while an extended glTF material
 * becomes its own root so its extension declarations own cook/ABI identity.
 */
function standardRootParameterNames(mat: GltfMaterialIr): {
  readonly names: ReadonlySet<string>;
  readonly extended: boolean;
  readonly staticSwitches: import('@forgeax/engine-types').MaterialStaticSwitches;
} {
  const names = new Set(STANDARD_SURFACE_PARAM_SCHEMA.map((entry) => entry.name));

  const addLayer = (layer: keyof typeof STANDARD_LAYER_PARAMETER_GROUPS): void => {
    for (const name of STANDARD_LAYER_PARAMETER_GROUPS[layer]) names.add(name);
  };

  const clearcoat =
    mat.clearcoatFactor !== undefined ||
    mat.clearcoatRoughnessFactor !== undefined ||
    mat.clearcoatNormalTexture !== undefined ||
    mat.clearcoatTexture !== undefined ||
    mat.clearcoatRoughnessTexture !== undefined;
  const anisotropy =
    mat.anisotropyStrength !== undefined ||
    mat.anisotropyRotation !== undefined ||
    mat.anisotropyTexture !== undefined;
  const sheen =
    mat.sheenColorFactor !== undefined ||
    mat.sheenRoughnessFactor !== undefined ||
    mat.sheenColorTexture !== undefined ||
    mat.sheenRoughnessTexture !== undefined;
  const iridescence =
    mat.iridescenceFactor !== undefined ||
    mat.iridescenceIor !== undefined ||
    mat.iridescenceThicknessMinimum !== undefined ||
    mat.iridescenceThicknessMaximum !== undefined ||
    mat.iridescenceTexture !== undefined ||
    mat.iridescenceThicknessTexture !== undefined;
  const diffuseTransmission =
    mat.diffuseTransmissionFactor !== undefined ||
    mat.diffuseTransmissionColorFactor !== undefined ||
    mat.diffuseTransmissionTexture !== undefined ||
    mat.diffuseTransmissionColorTexture !== undefined;
  if (clearcoat) addLayer('clearcoat');
  if (anisotropy) addLayer('anisotropy');
  if (sheen) addLayer('sheen');
  if (iridescence) addLayer('iridescence');
  if (diffuseTransmission) addLayer('diffuseTransmission');
  if (clearcoat && mat.clearcoatNormalTexture !== undefined) names.add('clearcoatNormalScale');

  for (const { slot } of GLTF_MATERIAL_TEXTURE_SLOTS) {
    if (mat[slot] !== undefined) names.add(slot);
  }

  const transmission =
    mat.transmissionFactor !== undefined ||
    mat.transmissionTexture !== undefined ||
    mat.ior !== undefined ||
    mat.thicknessFactor !== undefined ||
    mat.thicknessTexture !== undefined ||
    mat.attenuationColor !== undefined ||
    mat.attenuationDistance !== undefined;
  if (transmission) {
    // Transmission/volume keeps its existing paired backdrop ABI.  The
    // producer may leave either value at its neutral fallback, but the pair
    // remains part of the pre-existing transmission root contract.
    for (const name of STANDARD_TRANSMISSION_PARAMETER_NAMES) names.add(name);
  }

  return {
    names,
    staticSwitches: Object.fromEntries(
      Object.entries({
        clearcoat,
        anisotropy,
        sheen,
        iridescence,
        diffuseTransmission,
        transmission,
      }).filter(([, enabled]) => enabled),
    ),
    extended:
      clearcoat ||
      anisotropy ||
      sheen ||
      iridescence ||
      diffuseTransmission ||
      transmission ||
      mat.specularTexture !== undefined ||
      mat.specularColorTexture !== undefined,
  };
}

export function validateMaterialUvSets(
  mat: GltfMaterialIr,
  primitive: string,
  availableSets: readonly number[],
): Result<void, MaterialError> {
  const available = new Set(availableSets);
  for (const { slot } of GLTF_MATERIAL_TEXTURE_SLOTS) {
    const binding = materialTextureBinding(mat[slot]);
    if (binding === undefined) continue;
    const requestedSet = binding.texCoord ?? 0;
    if (!available.has(requestedSet)) {
      return err(
        createMaterialError('gltf-material-uv-set-missing', {
          material: mat.name ?? '<unnamed>',
          primitive,
          slot,
          requestedSet,
          availableSets,
        }),
      );
    }
  }
  return ok(undefined);
}

export function validateMaterialTangentInputs(
  mat: GltfMaterialIr,
  mesh: GltfMeshIr,
  layer = 'clearcoat',
): Result<void, MaterialError> {
  // Anisotropy changes the base GGX lobe even when it has no texture map, so
  // its tangent direction is part of the scalar layer contract.  Select UV 0
  // for the scalar-only form; a mapped form keeps the map's explicit UV set.
  const anisotropyDeclared =
    mat.anisotropyStrength !== undefined ||
    mat.anisotropyRotation !== undefined ||
    mat.anisotropyTexture !== undefined;
  const tangentSlot = anisotropyDeclared
    ? { layer: 'anisotropy', info: mat.anisotropyTexture }
    : mat.clearcoatNormalTexture !== undefined
      ? { layer: 'clearcoat', info: mat.clearcoatNormalTexture }
      : undefined;
  if (tangentSlot === undefined) return ok(undefined);
  const selected = materialTextureBinding(tangentSlot.info);
  const uvSet = selected?.texCoord ?? 0;
  const uv = gltfMeshUvSet(mesh, uvSet);
  const attributes = ['NORMAL', `TEXCOORD_${uvSet}`, 'TANGENT'];
  const fail = (reason: string): Result<void, MaterialError> =>
    err(
      createMaterialError('material-tangent-required', {
        code: 'material-tangent-required',
        material: mat.name ?? '<unnamed>',
        mesh: mesh.name ?? '<unnamed>',
        layer: tangentSlot.layer ?? layer,
        uv: `TEXCOORD_${uvSet}`,
        attributes,
        reason,
      }),
    );
  if (mesh.tangents !== undefined) {
    if (
      mesh.tangents.length !== (mesh.positions.length / 3) * 4 ||
      mesh.tangents.some((value) => !Number.isFinite(value))
    ) {
      return fail('imported TANGENT must be finite vec4 per vertex');
    }
    return ok(undefined);
  }
  if (mesh.normals === undefined) return fail('NORMAL is required to generate tangent');
  if (!(uv instanceof Float32Array))
    return fail('the selected UV set is required to generate tangent');
  const generated = computeTangentVec4(mesh.positions, mesh.normals, uv, mesh.indices);
  if (!generated.ok) {
    const detail = generated.error.detail;
    const reason =
      detail !== undefined && 'reason' in detail
        ? String(detail.reason)
        : 'tangent producer rejected topology';
    return fail(reason);
  }
  return ok(undefined);
}

/** Convert a parsed GltfMaterialIr into a standard-root derived MaterialAsset. */
export function toMaterialAsset(mat: GltfMaterialIr, ctx?: MaterialBridgeContext): MaterialAsset {
  const rootContract = standardRootParameterNames(mat);
  const values: Record<string, NonNullable<MaterialAsset['values']>[string]> = {
    baseColor: mat.baseColorFactor,
    metallic: mat.metallicFactor,
    roughness: mat.roughnessFactor,
  };
  if (mat.emissiveFactor !== undefined) {
    values.emissive = mat.emissiveFactor;
    values.emissiveIntensity = mat.emissiveStrength ?? 1;
  }
  for (const { slot } of GLTF_MATERIAL_TEXTURE_SLOTS) {
    const value = textureValue(mat[slot], slot, ctx);
    if (value !== undefined) values[slot] = value;
  }
  if (mat.occlusionTexture !== undefined && values.occlusionStrength === undefined) {
    values.occlusionStrength = 1;
  }
  if (rootContract.extended && rootContract.names.has('transmission')) {
    values.transmission = mat.transmissionFactor ?? 0;
    values.ior = mat.ior ?? 1.5;
    values.thickness = mat.thicknessFactor ?? 0;
    values.attenuationColor = mat.attenuationColor ?? [1, 1, 1];
    if (mat.attenuationDistance !== undefined) values.attenuationDistance = mat.attenuationDistance;
  }
  if (rootContract.names.has('clearcoat')) {
    values.clearcoat = mat.clearcoatFactor ?? 0;
    values.clearcoatRoughness = mat.clearcoatRoughnessFactor ?? 0;
  }
  const normal = materialTextureBinding(mat.normalTexture) as
    | (GltfTextureInfoIr & { readonly scale?: number })
    | undefined;
  if (normal?.scale !== undefined) values.normalScale = [normal.scale, normal.scale];
  const clearcoatNormal = materialTextureBinding(mat.clearcoatNormalTexture) as
    | (GltfTextureInfoIr & { readonly scale?: number })
    | undefined;
  if (clearcoatNormal?.scale !== undefined) values.clearcoatNormalScale = clearcoatNormal.scale;
  if (rootContract.names.has('anisotropyStrength')) {
    values.anisotropyStrength = mat.anisotropyStrength ?? 0;
    values.anisotropyRotation = mat.anisotropyRotation ?? 0;
  }
  if (rootContract.names.has('sheenColor')) {
    values.sheenColor = mat.sheenColorFactor ?? [0, 0, 0];
    values.sheenRoughness = mat.sheenRoughnessFactor ?? 0;
  }
  if (rootContract.names.has('iridescence')) {
    values.iridescence = mat.iridescenceFactor ?? 0;
    values.iridescenceIor = mat.iridescenceIor ?? 1.3;
    values.iridescenceThicknessMinimum = mat.iridescenceThicknessMinimum ?? 100;
    values.iridescenceThicknessMaximum = mat.iridescenceThicknessMaximum ?? 400;
  }
  if (rootContract.names.has('diffuseTransmission')) {
    values.diffuseTransmission = mat.diffuseTransmissionFactor ?? 0;
    values.diffuseTransmissionColor = mat.diffuseTransmissionColorFactor ?? [1, 1, 1];
  }
  if (mat.specularFactor !== undefined) values.specular = mat.specularFactor;
  if (mat.specularColorFactor !== undefined) values.specularColor = mat.specularColorFactor;

  const module =
    mat.unlit === true
      ? 'forgeax_material::unlit'
      : ctx?.skinned === true
        ? 'forgeax::pbr-skin'
        : 'forgeax::default-standard-pbr';

  const isMask = mat.alphaMode === 'MASK';
  const alphaCutoff = isMask ? (mat.alphaCutoff ?? 0.5) : undefined;
  if (alphaCutoff !== undefined) values.alphaCutoff = alphaCutoff;

  // glTF BLEND uses straight alpha and does not write depth.
  const isBlend = mat.alphaMode === 'BLEND';
  const straightAlphaBlend = {
    color: {
      srcFactor: 'src-alpha' as const,
      dstFactor: 'one-minus-src-alpha' as const,
      operation: 'add' as const,
    },
    alpha: {
      srcFactor: 'one' as const,
      dstFactor: 'one-minus-src-alpha' as const,
      operation: 'add' as const,
    },
  };

  // feat-city-glb Bug 5: transparent (BLEND) materials read but do NOT write
  // depth (`depthWriteEnabled: false`), matching the engine's own transparent
  // convention (learn-render 4.3 blending window material). glTF decals are
  // frequently coplanar with the opaque surface they overlay (e.g. a crosswalk
  // decal on the road); writing depth would z-fight / self-occlude. Back-to-
  // front ordering is handled by the Transparent queue + transparent sort.
  const pass = {
    name: 'Forward',
    program: { module },
    renderState: {
      tags: { LightMode: 'Forward' },
      queue: (isBlend ? 3000 : isMask ? 2450 : 2000) as RenderQueue,
      ...(isBlend || isMask || mat.doubleSided === true
        ? {
            ...(isBlend ? { blend: straightAlphaBlend, depthWriteEnabled: false } : {}),
            ...(mat.doubleSided === true ? { cullMode: 'none' as const } : {}),
          }
        : {}),
    },
  };
  // Imported Standard roots participate in the same raster consumers as
  // authored Standard materials. Physical layers and BLEND stay Forward;
  // opaque/MASK materials also provide the deferred material attachments.
  const passes: [MaterialPass, ...MaterialPass[]] = [pass];
  if (mat.unlit !== true && !isBlend && !rootContract.extended) {
    passes.push({
      ...pass,
      name: 'Deferred',
      program: { module, fragmentEntry: 'fs_gbuffer' },
      renderState: { ...pass.renderState, tags: { LightMode: 'Deferred' } },
    });
  }
  passes.push({
    name: 'ShadowCaster',
    program:
      mat.unlit === true
        ? { module, vertexEntry: 'vs_shadow' }
        : { module: 'forgeax::default-shadow-caster', fragmentEntry: 'fs_shadow' },
    renderState: {
      tags: { LightMode: 'ShadowCaster' },
      ...(mat.doubleSided === true ? { cullMode: 'none' } : {}),
    },
  });

  const child = mat.unlit !== true && !rootContract.extended && ctx?.standardRootGuid !== undefined;
  if (mat.unlit === true)
    for (const name of Object.keys(values))
      if (!['baseColor', 'baseColorTexture', 'alphaCutoff'].includes(name)) delete values[name];
  return {
    kind: 'material',
    ...(mat.unlit === true || Object.keys(rootContract.staticSwitches).length === 0
      ? {}
      : { staticSwitches: rootContract.staticSwitches }),
    ...(child
      ? { parent: ctx.standardRootGuid }
      : {
          colorSpace: 'linear' as const,
          passes,
          parameters:
            mat.unlit === true
              ? unlitMaterialParameters('linear')
              : standardMaterialParameters(rootContract.names),
        }),
    values,
  };
}

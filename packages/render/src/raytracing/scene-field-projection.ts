import {
  type AssetRegistry,
  type MaterialRenderProjection,
  resolveAssetHandle,
  runtimeMaterialShaderId,
  walkMaterialPassesOverSharedRefs,
} from '@forgeax/engine-assets-runtime';
import {
  MESH_VISIBILITY_DISTANCE_FIELD_CODEC,
  meshDistanceFieldSource,
  validateMeshDistanceField,
} from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import { admitRayMaterialValues, DEFAULT_STANDARD_SURFACE_MODULE } from '@forgeax/engine-shader';
import {
  type MaterialAsset,
  type MaterialPass,
  type MeshAsset,
  ok,
  type Result,
  toShared,
} from '@forgeax/engine-types';
import { gpuDrivenSourceDrawItemIndex } from '../extract/gpu-driven';
import type { RenderResourceScope } from '../publication/resource-scope';
import {
  type InstancesSnapshot,
  type MaterialSnapshot,
  materialStandardTextureMask,
} from '../render-system-extract';
import type { RenderSceneRecord, RenderSceneSlot } from '../scene/render-scene-types';
import { standardDisplacementRadius } from '../standard-displacement-bounds';
import { type RayReferenceError, rayReferenceFailure } from './scene';
import type { SdfMeshInstance } from './sdf-query';

type AttachedField = NonNullable<MeshAsset['distanceField']>;
type MaterialFacts = Pick<
  MaterialSnapshot,
  | 'materialShaderId'
  | 'materialProgramKeys'
  | 'materialSurfacePrograms'
  | 'renderState'
  | 'paramSnapshot'
  | 'textureHandles'
  | 'textureCoordinates'
>;

/** Actual owner references are identity witnesses; only copied facts supply query data. */
export interface SceneFieldSource extends RenderSceneRecord {
  readonly scope: RenderResourceScope;
  readonly assetHandle: number;
  readonly mesh: MeshAsset;
  readonly field: AttachedField;
  readonly fieldSnapshot: AttachedField;
  readonly firstInstance: number;
  readonly instances: Omit<InstancesSnapshot, 'transforms' | 'dirtyRanges'> | undefined;
  readonly materials: readonly {
    readonly materialSlot: number;
    readonly handle: number;
    readonly payload: MaterialAsset;
    readonly effectivePayload: MaterialAsset;
    readonly projection: MaterialRenderProjection | undefined;
    /** MASK retains sampled geometry only; the field does not evaluate alpha. */
    readonly alphaCoverageOmitted: boolean;
    readonly facts: MaterialFacts;
    /** The accepted complete material snapshot; capture never re-resolves author values. */
    readonly snapshot: MaterialSnapshot;
  }[];
}

function fieldTransform(source: ArrayLike<number>): Result<Float32Array, RayReferenceError> {
  const t = Float32Array.from(source);
  if (
    t.length !== 16 ||
    !t.every(Number.isFinite) ||
    t[3] !== 0 ||
    t[7] !== 0 ||
    t[11] !== 0 ||
    t[15] !== 1
  )
    return rayReferenceFailure('retained field requires a finite affine transform');
  const inverse = mat4.invert(mat4.create(), t);
  if (
    !inverse.every(Number.isFinite) ||
    !mat4.equals(mat4.multiply(mat4.create(), t, inverse), mat4.identity(mat4.create()), 1e-4)
  )
    return rayReferenceFailure('retained field transform is singular or ill-conditioned');
  const scales = [0, 4, 8].map((i) => Math.hypot(t[i] ?? NaN, t[i + 1] ?? NaN, t[i + 2] ?? NaN));
  if (!scales.every((scale) => Math.fround(scale) > 0 && Number.isFinite(Math.fround(scale))))
    return rayReferenceFailure('retained field transform scales must be finite positive f32');
  for (let a = 0; a < 3; a++)
    for (let b = a + 1; b < 3; b++) {
      const dot =
        (t[a * 4] ?? NaN) * (t[b * 4] ?? NaN) +
        (t[a * 4 + 1] ?? NaN) * (t[b * 4 + 1] ?? NaN) +
        (t[a * 4 + 2] ?? NaN) * (t[b * 4 + 2] ?? NaN);
      if (Math.abs(dot) > 1e-5 * (scales[a] ?? NaN) * (scales[b] ?? NaN))
        return rayReferenceFailure(
          'retained field requires orthogonal axes; shear is not qualified',
        );
    }
  return ok(t);
}

export function validateSceneFieldBudget(budget: {
  readonly maxInstances: number;
  readonly maxFieldBytes: number;
}) {
  if (
    !Number.isSafeInteger(budget.maxInstances) ||
    budget.maxInstances < 1 ||
    budget.maxInstances > 1024 ||
    !Number.isSafeInteger(budget.maxFieldBytes) ||
    budget.maxFieldBytes < 1
  )
    return rayReferenceFailure(
      'retained field requires explicit 1..1024 instance and positive byte budgets',
      true,
    );
  return ok(undefined);
}

/**
 * A deforming (skinned or morphed) source never enters the retained field: it has no
 * cooked rest-pose SDF or Card that stays valid while it animates, so it neither
 * occludes nor bounces field GI. It still receives GI and appears in screen traces.
 */
export interface SceneFieldDeformingSource {
  readonly worldId: number;
  readonly entityKey: number;
  readonly slot: number;
}

/** Complete CPU projection only: no camera filtering, device work, cache or publication. */
export function projectSceneFields(
  slots: readonly RenderSceneSlot[],
  worlds: readonly RenderResourceScope[],
  budget: { readonly maxInstances: number; readonly maxFieldBytes: number },
  assets: Pick<AssetRegistry, 'getMaterialProjectionForPayload' | 'lookup'>,
): Result<
  {
    readonly instances: readonly SdfMeshInstance[];
    readonly sources: readonly SceneFieldSource[];
    readonly deforming: readonly SceneFieldDeformingSource[];
  },
  RayReferenceError
> {
  const admittedBudget = validateSceneFieldBudget(budget);
  if (!admittedBudget.ok) return admittedBudget;
  const instances: SdfMeshInstance[] = [],
    sources: SceneFieldSource[] = [],
    deforming: SceneFieldDeformingSource[] = [];
  const fields = new Map<AttachedField, AttachedField>(),
    meshes = new Map<MeshAsset, number>();
  const seenSlots = new Set<number>(),
    seenEntities = new Set<string>();
  let fieldBytes = 0;
  for (const slot of [...slots].sort((a, b) => a.slot - b.slot)) {
    const source = slot.snapshot;
    if (source.authorVisible === false) continue;
    if (
      ![slot.slot, slot.generation, slot.worldId, slot.entityKey].every(
        (v) => Number.isInteger(v) && v >= 0 && v <= 0xffff_ffff,
      ) ||
      source.worldId !== slot.worldId ||
      source.entityKey !== slot.entityKey ||
      seenSlots.has(slot.slot) ||
      seenEntities.has(`${slot.worldId}:${slot.entityKey}`)
    )
      return rayReferenceFailure('retained field requires unique, matching scene owner identities');
    seenSlots.add(slot.slot);
    seenEntities.add(`${slot.worldId}:${slot.entityKey}`);
    const scope = worlds[slot.worldId];
    if (scope === undefined)
      return rayReferenceFailure('retained field has no matching resource scope');
    const resolved = resolveAssetHandle<MeshAsset>(scope, toShared(source.assetHandle));
    if (!resolved.ok || resolved.value.kind !== 'mesh')
      return rayReferenceFailure(
        'retained field mesh handle must resolve in its exact resource scope',
      );
    const mesh = resolved.value,
      field = mesh.distanceField;
    if (
      source.skin !== undefined ||
      source.skinPose !== undefined ||
      source.morph !== undefined ||
      mesh.morphWeights !== undefined ||
      mesh.morphTargets !== undefined
    ) {
      deforming.push({ worldId: slot.worldId, entityKey: slot.entityKey, slot: slot.slot });
      continue;
    }
    if (field === undefined)
      return rayReferenceFailure(
        'retained mesh has no admitted distance field; rebuild its producer',
      );
    if (
      source.spriteInstances !== undefined ||
      source.pointsLines !== undefined ||
      slot.pointsLines !== undefined ||
      (source.lods?.length ?? 0) > 0 ||
      (mesh.lods?.length ?? 0) > 0
    )
      return rayReferenceFailure(
        'retained fields require base meshes without LOD, sprites or points/lines',
      );
    const count = source.instances?.instanceCount ?? 1;
    if (!Number.isSafeInteger(count) || count < 1 || count > budget.maxInstances - instances.length)
      return rayReferenceFailure(
        'complete retained field roster exceeds its instance budget',
        true,
      );
    if (
      source.instances !== undefined &&
      (source.instances.transforms.length !== count * 16 ||
        source.instances.generations?.length !== count ||
        new Set(source.instances.generations).size !== count ||
        source.instances.generations.some((v) => v === 0))
    )
      return rayReferenceFailure(
        'retained instances require complete matrices and unique nonzero owner generations',
      );
    let geometryId = meshes.get(mesh);
    if (geometryId === undefined) {
      const validSource = meshDistanceFieldSource(mesh, {
        sectionSidedness: field.sectionSidedness,
      });
      if (!validSource.ok) return rayReferenceFailure(validSource.error.detail.reason);
      geometryId = meshes.size;
      meshes.set(mesh, geometryId);
    }
    let fieldSnapshot = fields.get(field);
    if (fieldSnapshot === undefined) {
      const artifact = field.artifact,
        codec = artifact?.assetCodec;
      if (
        artifact?.integrity.algorithm !== 'sha256' ||
        !/^sha256:[a-f0-9]{64}$/.test(artifact.integrity.digest) ||
        codec?.name !== MESH_VISIBILITY_DISTANCE_FIELD_CODEC.name ||
        codec.version !== MESH_VISIBILITY_DISTANCE_FIELD_CODEC.version ||
        codec.profile !== MESH_VISIBILITY_DISTANCE_FIELD_CODEC.profile ||
        codec.container !== undefined ||
        field.policy.kind !== 'sampled-visibility'
      )
        return rayReferenceFailure(
          'retained field requires its admitted sampled-visibility artifact Integrity and Codec',
        );
      const valid = validateMeshDistanceField(field);
      if (!valid.ok) return rayReferenceFailure(valid.error.detail.reason);
      const bytes = field.bricks.byteLength + field.values.byteLength;
      if (bytes > budget.maxFieldBytes - fieldBytes)
        return rayReferenceFailure(
          'complete unique retained field snapshots exceed the byte budget',
          true,
        );
      fieldBytes += bytes;
      fieldSnapshot = structuredClone(field);
      fields.set(field, fieldSnapshot);
    }
    const materials: SceneFieldSource['materials'][number][] = [];
    let first = 0;
    // Draws may be absent or filtered by backend preparation. Actual Mesh
    // sections own coverage; present draw ranges can only contradict it.
    const draws = new Map<number, NonNullable<typeof source.gpuDrivenDraws>[number]>();
    for (const [index, draw] of (source.gpuDrivenDraws ?? []).entries()) {
      const section = gpuDrivenSourceDrawItemIndex(draw, index);
      if (
        !Number.isInteger(section) ||
        section < 0 ||
        section >= mesh.submeshes.length ||
        draws.has(section)
      )
        return rayReferenceFailure('retained draw has no unique actual mesh section');
      draws.set(section, draw);
    }
    for (const [sectionIndex, section] of mesh.submeshes.entries()) {
      const material = source.materials[section.materialSlot],
        handle = material?.materialHandle;
      if (
        !Number.isInteger(section.materialSlot) ||
        section.materialSlot < 0 ||
        material === undefined ||
        handle === undefined
      )
        return rayReferenceFailure(
          'every actual mesh section must resolve its effective material slot',
        );
      const shared = toShared<'MaterialAsset'>(handle);
      const raw =
        'resolveAsset' in scope
          ? resolveAssetHandle<MaterialAsset>(scope, shared)
          : scope.sharedRefs.resolve<'MaterialAsset', MaterialAsset>(shared);
      const payload = raw.ok ? raw : resolveAssetHandle<MaterialAsset>(scope, shared);
      if (!payload.ok || payload.value.kind !== 'material')
        return rayReferenceFailure(
          'retained field material handle is unavailable in its resource scope',
        );
      const projection = assets.getMaterialProjectionForPayload(payload.value);
      const current = resolveAssetHandle<MaterialAsset>(scope, shared);
      if (!current.ok || current.value.kind !== 'material')
        return rayReferenceFailure('retained field effective material is unavailable');
      const effective = !('resolveAsset' in scope)
        ? walkMaterialPassesOverSharedRefs(scope, shared, assets)
        : current;
      if (
        !effective.ok ||
        !isNativePlacementMaterial(material, projection, effective.value) ||
        (material.surfaceModel !== undefined && material.surfaceModel !== 'standard')
      )
        return rayReferenceFailure(
          'retained field requires accepted native Standard material provenance',
        );
      const passes = projection?.passes ?? effective.value.passes ?? [];
      const color = passes.filter(
        (pass) =>
          !/shadow|depth/i.test(
            String(
              (pass.renderState?.tags as Readonly<Record<string, unknown>> | undefined)
                ?.LightMode ?? pass.name,
            ),
          ),
      );
      const values = {
        ...Object.fromEntries(
          (effective.value.parameters ?? []).map((parameter) => [
            parameter.name,
            parameter.default,
          ]),
        ),
        ...projection?.runtimeValues,
        ...effective.value.values,
      };
      const coverage = admitRayMaterialValues(values, String(handle), 'retained-mesh-field');
      if (!coverage.ok) return rayReferenceFailure(coverage.error.detail.requirement);
      const scalar = (name: string, fallback: number) =>
        values[name] === undefined
          ? fallback
          : typeof values[name] === 'number'
            ? values[name]
            : NaN;
      const alphaCutoff = scalar('alphaCutoff', 0),
        displacementScale = scalar('displacementScale', 1),
        displacementBias = scalar('displacementBias', 0);
      const clipping = values.clippingControl;
      const clipped = (value: unknown) =>
        value !== undefined && (!Array.isArray(value) || value[0] !== 0);
      const actualDisplacement = standardDisplacementRadius([
        {
          ...material,
          standardTextureMask: materialStandardTextureMask(
            effective.value.parameters,
            'forgeax::default-standard-pbr',
            values,
          ),
          paramSnapshot: { displacementScale, displacementBias },
        },
      ]);
      if (
        material.transparent === true ||
        material.renderState?.blend !== undefined ||
        color.some((pass) => pass.renderState?.blend !== undefined) ||
        standardDisplacementRadius([material]) !== 0 ||
        actualDisplacement !== 0 ||
        clipped(clipping) ||
        clipped(material.paramSnapshot?.clippingControl) ||
        !Number.isFinite(alphaCutoff) ||
        alphaCutoff < 0 ||
        alphaCutoff > 1
      )
        return rayReferenceFailure(
          'retained field rejects transparent, displaced or locally clipped material coverage',
        );
      const sidedness = field.sectionSidedness[sectionIndex];
      for (const state of [material.renderState, ...color.map((pass) => pass.renderState)]) {
        const cull = state?.cullMode ?? 'back';
        if ((cull !== 'back' && cull !== 'none') || Number(cull === 'none') !== sidedness)
          return rayReferenceFailure(
            'retained material sidedness differs from its cooked whole-mesh field; recook the producer',
          );
      }
      const draw = draws.get(sectionIndex);
      const offset = mesh.indices === undefined ? first : section.indexOffset;
      const elements = mesh.indices === undefined ? section.vertexCount : section.indexCount;
      if (
        draw !== undefined &&
        (gpuDrivenSourceDrawItemIndex(draw, sectionIndex) !== sectionIndex ||
          draw.kind !== (mesh.indices === undefined ? 'non-indexed' : 'indexed') ||
          draw.topology !== section.topology ||
          draw.materialSlot !== section.materialSlot ||
          draw.first !== offset ||
          draw.count !== elements ||
          draw.baseVertex !== 0 ||
          (draw.lodRanges?.length ?? 0) > 0)
      )
        return rayReferenceFailure(
          'retained draw subset or range disagrees with its actual whole-mesh field',
        );
      first += section.vertexCount;
      const {
        materialShaderId,
        materialProgramKeys,
        materialSurfacePrograms,
        renderState,
        paramSnapshot,
        textureHandles,
        textureCoordinates,
      } = material;
      materials.push({
        materialSlot: section.materialSlot,
        handle,
        payload: payload.value,
        effectivePayload: current.value,
        projection,
        alphaCoverageOmitted: alphaCutoff > 0,
        snapshot: material,
        facts: structuredClone({
          materialShaderId,
          materialProgramKeys,
          materialSurfacePrograms,
          renderState,
          paramSnapshot: {
            ...paramSnapshot,
            alphaCutoff,
            displacementScale,
            displacementBias,
            ...(Array.isArray(clipping) ? { clippingControl: clipping } : {}),
          },
          textureHandles,
          textureCoordinates,
        }),
      });
    }
    const root = fieldTransform(source.transform.world);
    if (!root.ok) return root;
    const firstInstance = instances.length;
    for (let ordinal = 0; ordinal < count; ordinal++) {
      const transform =
        source.instances === undefined
          ? root
          : fieldTransform(
              mat4.multiply(
                mat4.create(),
                root.value,
                source.instances.transforms.subarray(ordinal * 16, (ordinal + 1) * 16),
              ),
            );
      if (!transform.ok) return transform;
      instances.push({
        instanceId: instances.length,
        geometryId,
        mask: 255,
        transform: transform.value,
        field: fieldSnapshot,
      });
    }
    const {
      transforms: _transforms,
      dirtyRanges: _dirty,
      ...identity
    } = source.instances ?? { transforms: undefined, dirtyRanges: undefined };
    sources.push({
      worldId: slot.worldId,
      entityKey: slot.entityKey,
      slot: slot.slot,
      generation: slot.generation,
      scope,
      assetHandle: source.assetHandle,
      mesh,
      field,
      fieldSnapshot,
      firstInstance,
      instances:
        source.instances === undefined
          ? undefined
          : (structuredClone(identity) as Omit<InstancesSnapshot, 'transforms' | 'dirtyRanges'>),
      materials,
    });
  }
  return ok({ instances, sources, deforming });
}

/** Re-resolve current producer identities without copying or rescanning mesh fields.
 * Supported changes replace owner payloads/projections; arbitrary in-place array
 * mutation outside the producer publication is not a proven source transition. */
export function sceneFieldSourcesCurrent(
  sources: readonly SceneFieldSource[],
  assets: Pick<AssetRegistry, 'getMaterialProjectionForPayload'>,
): boolean {
  for (const source of sources) {
    const mesh = resolveAssetHandle<MeshAsset>(source.scope, toShared(source.assetHandle));
    if (!mesh.ok || mesh.value !== source.mesh || mesh.value.distanceField !== source.field)
      return false;
    for (const material of source.materials) {
      const handle = toShared<'MaterialAsset'>(material.handle);
      const scope = source.scope;
      const raw =
        'resolveAsset' in scope
          ? resolveAssetHandle<MaterialAsset>(scope, handle)
          : scope.sharedRefs.resolve<'MaterialAsset', MaterialAsset>(handle);
      const payload = raw.ok ? raw : resolveAssetHandle<MaterialAsset>(scope, handle);
      const effective = resolveAssetHandle<MaterialAsset>(scope, handle);
      if (
        !payload.ok ||
        payload.value !== material.payload ||
        !effective.ok ||
        effective.value !== material.effectivePayload ||
        assets.getMaterialProjectionForPayload(payload.value) !== material.projection
      )
        return false;
    }
  }
  return true;
}

/** Qualify accepted producer provenance, never a cooked hash or ABI resemblance. */
export function isNativePlacementMaterial(
  material: Pick<MaterialSnapshot, 'materialShaderId' | 'materialProgramKeys'>,
  projection: MaterialRenderProjection | undefined,
  source?: {
    readonly passes?: readonly MaterialPass[] | undefined;
    readonly surface?: MaterialAsset['surface'];
    readonly parent?: MaterialAsset['parent'];
  },
): boolean {
  if (projection === undefined) {
    if (
      source === undefined ||
      source.parent !== undefined ||
      material.materialProgramKeys !== undefined ||
      (source.surface !== undefined &&
        (source.surface.model !== 'standard' ||
          source.surface.module !== DEFAULT_STANDARD_SURFACE_MODULE ||
          source.surface.dynamicInput !== undefined))
    )
      return false;
    const color = (source.passes ?? []).filter(
      (pass) =>
        !/shadow|depth/i.test(
          String(
            (pass.renderState?.tags as Readonly<Record<string, unknown>> | undefined)?.LightMode ??
              pass.name,
          ),
        ),
    );
    return (
      color.length > 0 &&
      material.materialShaderId === 'forgeax::default-standard-pbr' &&
      color.every(
        (pass) =>
          runtimeMaterialShaderId(pass.program.module, pass.name) === material.materialShaderId &&
          (pass.program.moduleSlots?.surface ??
            source.surface?.module ??
            DEFAULT_STANDARD_SURFACE_MODULE) === DEFAULT_STANDARD_SURFACE_MODULE &&
          (pass.renderState?.tags as Readonly<Record<string, unknown>> | undefined)?.SurfaceKind !==
            'full-custom',
      )
    );
  }
  if (
    projection === undefined ||
    (projection.surface !== undefined &&
      (projection.surface.model !== 'standard' || projection.surface.dynamicInput !== undefined))
  )
    return false;
  const color = projection.passes.filter((pass) => {
    const tags = pass.renderState?.tags as Readonly<Record<string, unknown>> | undefined;
    return !/shadow|depth/i.test(String(tags?.LightMode ?? pass.name));
  });
  const first = color[0];
  if (
    first === undefined ||
    material.materialShaderId !==
      (material.materialProgramKeys?.[first.name] ??
        runtimeMaterialShaderId(first.module, first.name))
  )
    return false;
  return (
    color.length > 0 &&
    color.every((pass) => {
      const key = material.materialProgramKeys?.[pass.name];
      const tags = pass.renderState?.tags as Readonly<Record<string, unknown>> | undefined;
      return (
        runtimeMaterialShaderId(pass.module, pass.name) === 'forgeax::default-standard-pbr' &&
        (pass.moduleSlots?.surface ??
          projection.surface?.module ??
          DEFAULT_STANDARD_SURFACE_MODULE) === DEFAULT_STANDARD_SURFACE_MODULE &&
        tags?.SurfaceKind !== 'full-custom' &&
        (key === undefined
          ? material.materialShaderId === 'forgeax::default-standard-pbr'
          : pass.programs.some((program) => program.specializationKey === key))
      );
    })
  );
}

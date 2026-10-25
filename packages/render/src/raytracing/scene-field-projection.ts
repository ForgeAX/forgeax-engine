import {
  type AssetRegistry,
  type MaterialRenderProjection,
  runtimeMaterialShaderId,
} from '@forgeax/engine-assets-runtime';

import {
  MESH_VISIBILITY_DISTANCE_FIELD_CODEC,
  meshDistanceFieldSource,
  validateMeshDistanceField,
} from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import { admitRayMaterialValues, DEFAULT_STANDARD_SURFACE_MODULE } from '@forgeax/engine-shader';
import type { AssetHandle } from '@forgeax/engine-types';
import {
  type MaterialAsset,
  type MaterialPass,
  type MeshAsset,
  ok,
  type Result,
} from '@forgeax/engine-types';
import { gpuDrivenSourceDrawItemIndex } from '../extract/gpu-driven';
import type { MaterialResource } from '../material-resource';
import type { RenderResourceScope } from '../publication/resource-scope';
import {
  type InstancesSnapshot,
  type MaterialSnapshot,
  materialStandardTextureMask,
} from '../render-system-extract';
import type { FrameList } from '../scene/frame-list';
import { MaterialFrame } from '../scene/material-dispatch';
import { MeshFrame } from '../scene/mesh-frame';
import { effectiveMeshMaterials, meshMaterialGeometry } from '../scene/mesh-materials';
import type { RenderSceneRecord, RenderSceneSlot } from '../scene/render-scene-types';
import { type ProjectedRows, type ReadAsset, RowProjection } from '../scene/row-projection';
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
  readonly assetRevision: number;
  readonly mesh: MeshAsset;
  readonly field: AttachedField;
  readonly fieldSnapshot: AttachedField;
  readonly firstInstance: number;
  readonly instances: Omit<InstancesSnapshot, 'transforms' | 'dirtyRanges'> | undefined;
  readonly materials: readonly {
    readonly resource: MaterialResource;
    readonly materialSlot: number;
    readonly handle: number;
    readonly payload: MaterialAsset;
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

type FieldBudget = { readonly maxInstances: number; readonly maxFieldBytes: number };
type FieldSceneSource = RenderSceneSlot['snapshot'];
type FieldDraw = NonNullable<FieldSceneSource['gpuDrivenDraws']>[number];
type FieldSection = MeshAsset['submeshes'][number];
type FieldMaterial = SceneFieldSource['materials'][number];

/** Failure stage ranks preserve the complete projection's check order across rows. */
enum FieldStage {
  /** Owner identity, scope, mesh and geometry qualification (before the instance budget). */
  Source = 0,
  /** Instance matrices and owner generations. */
  Roster = 1,
  /** Whole-mesh field source qualification. */
  Geometry = 2,
  /** Attached field artifact and codec (before the byte budget). */
  Field = 3,
  /** Section materials and instance transforms. */
  Placement = 4,
}

interface FieldRowFailure {
  readonly kind: 'failure';
  readonly stage: FieldStage;
  readonly result: Result<never, RayReferenceError>;
  /** Instance count and field, once known, still charge the budgets checked before `stage`. */
  readonly count?: number;
  readonly field?: AttachedField;
}

interface FieldRow {
  readonly kind: 'field';
  readonly record: RenderSceneRecord;
  readonly scope: RenderResourceScope;
  readonly assetHandle: number;
  readonly assetRevision: number;
  readonly mesh: MeshAsset;
  readonly field: AttachedField;
  readonly instances: SceneFieldSource['instances'];
  readonly materials: readonly FieldMaterial[];
  /** Admitted world transform of each instance ordinal. */
  readonly transforms: readonly Float32Array[];
}

type FieldRowEntry =
  | FieldRow
  | { readonly kind: 'deforming'; readonly source: SceneFieldDeformingSource }
  | FieldRowFailure;

interface FieldContext {
  readonly worlds: readonly RenderResourceScope[];
  readonly budget: FieldBudget;
  readonly assets: Pick<AssetRegistry, 'getMaterialProjectionForPayload'>;
}

interface SceneFieldProjection {
  readonly instances: readonly SdfMeshInstance[];
  readonly sources: readonly SceneFieldSource[];
  readonly deforming: readonly SceneFieldDeformingSource[];
}

const fail = (
  stage: FieldStage,
  result: Result<never, RayReferenceError>,
  charged?: { readonly count: number; readonly field?: AttachedField },
): FieldRowFailure => ({ kind: 'failure', stage, result, ...charged });

function sameFieldEntry(before: FieldRowEntry, after: FieldRowEntry): boolean {
  // A deforming row only names its owner; its animated pose is not a field input.
  return (
    before.kind === 'deforming' &&
    after.kind === 'deforming' &&
    before.source.worldId === after.source.worldId &&
    before.source.entityKey === after.source.entityKey &&
    before.source.slot === after.source.slot
  );
}

/**
 * The retained field roster kept current from row change evidence. A row
 * edit re-admits only that row; the roster, bounded by the field budget, is
 * re-assembled only when an admitted entry changed. Rows the field does not
 * admit cost nothing at steady state. A cold or {@link reset} projection
 * admits every row once through the same path.
 */
export class SceneFieldRows {
  #context: FieldContext | undefined;
  readonly #rows = new RowProjection<FieldRowEntry>((slot, rows, read) => {
    const context = this.#context;
    return context === undefined ? undefined : this.#admit(slot, rows, context, read);
  }, sameFieldEntry);
  /** Per-asset qualification is shared by every row that references the asset. */
  #geometry = new WeakMap<MeshAsset, Result<never, RayReferenceError> | undefined>();
  #fields = new WeakMap<AttachedField, Result<never, RayReferenceError> | undefined>();
  /** Detached field snapshots, cloned once per field version rather than per projection. */
  #snapshots = new Map<
    AttachedField,
    { readonly revision: number; readonly value: AttachedField }
  >();
  #projection: Result<SceneFieldProjection, RayReferenceError> | undefined;
  #assembled = -1;

  /** Scene rows admitted since construction. */
  get visits(): number {
    return this.#rows.visits;
  }

  /** Increments whenever an admitted entry changed. */
  get revision(): number {
    return this.#rows.revision;
  }

  /** Clear every derived entry; the next update admits every scene row again. */
  reset(): void {
    this.#rows.reset();
    this.#geometry = new WeakMap();
    this.#fields = new WeakMap();
    this.#snapshots.clear();
    this.#projection = undefined;
    this.#assembled = -1;
  }

  update(
    rows: ProjectedRows,
    worlds: readonly RenderResourceScope[],
    budget: FieldBudget,
    assets: Pick<AssetRegistry, 'getMaterialProjectionForPayload'>,
  ): Result<SceneFieldProjection, RayReferenceError> {
    const admittedBudget = validateSceneFieldBudget(budget);
    if (!admittedBudget.ok) return admittedBudget;
    const before = this.#context;
    if (
      before === undefined ||
      before.assets !== assets ||
      before.budget.maxInstances !== budget.maxInstances ||
      before.budget.maxFieldBytes !== budget.maxFieldBytes ||
      before.worlds.length !== worlds.length ||
      before.worlds.some((world, index) => world !== worlds[index])
    )
      this.reset();
    this.#context = { worlds, budget, assets };
    this.#rows.sync(rows);
    if (this.#projection === undefined || this.#assembled !== this.#rows.revision) {
      this.#projection = this.#assemble(budget);
      this.#assembled = this.#rows.revision;
    }
    return this.#projection;
  }

  /** O(admitted rows): unique geometry, field snapshots and owner indices in slot order. */
  #assemble(budget: FieldBudget): Result<SceneFieldProjection, RayReferenceError> {
    const entries = [...this.#rows.entries()].sort(([a], [b]) => a - b);
    const instances: SdfMeshInstance[] = [];
    const sources: SceneFieldSource[] = [];
    const deforming: SceneFieldDeformingSource[] = [];
    const geometries = new Map<MeshAsset, number>();
    const snapshots = new Map<AttachedField, { revision: number; value: AttachedField }>();
    let fieldBytes = 0;
    for (const [, entry] of entries) {
      if (entry.kind === 'deforming') {
        deforming.push(entry.source);
        continue;
      }
      if (entry.kind === 'failure' && entry.stage === FieldStage.Source) return entry.result;
      const count = entry.kind === 'field' ? entry.transforms.length : (entry.count ?? 1);
      if (count > budget.maxInstances - instances.length)
        return rayReferenceFailure(
          'complete retained field roster exceeds its instance budget',
          true,
        );
      if (entry.kind === 'failure' && entry.stage < FieldStage.Placement) return entry.result;
      const field = entry.field;
      let snapshot = field === undefined ? undefined : snapshots.get(field);
      if (field !== undefined && snapshot === undefined) {
        const bytes = field.bricks.byteLength + field.values.byteLength;
        if (bytes > budget.maxFieldBytes - fieldBytes)
          return rayReferenceFailure(
            'complete unique retained field snapshots exceed the byte budget',
            true,
          );
        fieldBytes += bytes;
        if (entry.kind === 'field') {
          const retained = this.#snapshots.get(field);
          snapshot =
            retained?.revision === entry.assetRevision
              ? retained
              : { revision: entry.assetRevision, value: structuredClone(field) };
          snapshots.set(field, snapshot);
        }
      }
      if (entry.kind === 'failure') return entry.result;
      if (snapshot === undefined) continue;
      let geometryId = geometries.get(entry.mesh);
      if (geometryId === undefined) {
        geometryId = geometries.size;
        geometries.set(entry.mesh, geometryId);
      }
      const firstInstance = instances.length;
      for (const transform of entry.transforms)
        instances.push({
          instanceId: instances.length,
          geometryId,
          mask: 255,
          transform,
          field: snapshot.value,
        });
      sources.push({
        ...entry.record,
        scope: entry.scope,
        assetHandle: entry.assetHandle,
        assetRevision: entry.assetRevision,
        mesh: entry.mesh,
        field: entry.field,
        fieldSnapshot: snapshot.value,
        firstInstance,
        instances: entry.instances,
        materials: entry.materials,
      });
    }
    this.#snapshots = snapshots;
    return ok({ instances, sources, deforming });
  }

  /** Admit one scene row independently of every other row. */
  #admit(
    slot: RenderSceneSlot,
    rows: ProjectedRows,
    { worlds, assets }: FieldContext,
    read: ReadAsset,
  ): FieldRowEntry | undefined {
    const source = slot.snapshot;
    if (source.glyph !== undefined) return undefined;
    if (source.assetHandle === undefined)
      return fail(FieldStage.Source, rayReferenceFailure('retained field has no Mesh source'));
    if (source.authorVisible === false) return undefined;
    if (
      ![slot.slot, slot.generation, slot.worldId, slot.entityKey].every(
        (v) => Number.isInteger(v) && v >= 0 && v <= 0xffff_ffff,
      ) ||
      source.worldId !== slot.worldId ||
      source.entityKey !== slot.entityKey
    )
      return fail(
        FieldStage.Source,
        rayReferenceFailure('retained field requires unique, matching scene owner identities'),
      );
    const scope = worlds[slot.worldId];
    if (scope === undefined)
      return fail(
        FieldStage.Source,
        rayReferenceFailure('retained field has no matching resource scope'),
      );
    read(scope, source.assetHandle);
    const assetRevision = scope.assetRevision(source.assetHandle);
    const resolved = scope.resolveAsset<MeshAsset>(source.assetHandle);
    if (assetRevision === undefined || !resolved.ok || resolved.value.kind !== 'mesh')
      return fail(
        FieldStage.Source,
        rayReferenceFailure('retained field mesh handle must resolve in its exact resource scope'),
      );
    const mesh = resolved.value,
      field = mesh.distanceField;
    if (isDeformingFieldSource(source, mesh))
      return {
        kind: 'deforming',
        source: { worldId: slot.worldId, entityKey: slot.entityKey, slot: slot.slot },
      };
    if (field === undefined)
      return fail(
        FieldStage.Source,
        rayReferenceFailure('retained mesh has no admitted distance field; rebuild its producer'),
      );
    if (hasUnqualifiedFieldGeometry(slot, mesh))
      return fail(
        FieldStage.Source,
        rayReferenceFailure(
          'retained fields require base meshes without LOD, sprites or points/lines',
        ),
      );
    const count = source.instances?.instanceCount ?? 1;
    if (!Number.isSafeInteger(count) || count < 1)
      return fail(
        FieldStage.Source,
        rayReferenceFailure('complete retained field roster exceeds its instance budget', true),
      );
    if (
      source.instances !== undefined &&
      (source.instances.transforms.length !== count * 16 ||
        source.instances.generations?.length !== count ||
        new Set(source.instances.generations).size !== count ||
        source.instances.generations.some((v) => v === 0))
    )
      return fail(
        FieldStage.Roster,
        rayReferenceFailure(
          'retained instances require complete matrices and unique nonzero owner generations',
        ),
        { count },
      );
    const geometry = this.#qualifyGeometry(mesh, field);
    if (geometry !== undefined) return fail(FieldStage.Geometry, geometry, { count });
    const qualified = this.#qualifyField(field);
    if (qualified !== undefined) return fail(FieldStage.Field, qualified, { count });
    const shared = rows.meshes.get(slot.worldId, source.assetHandle);
    const bindings =
      shared === undefined
        ? source
        : effectiveMeshMaterials(source, shared, meshMaterialGeometry(source));
    const materials = sectionMaterials(source, bindings, mesh, field, scope, assets, rows, read);
    if (!materials.ok) return fail(FieldStage.Placement, materials, { count, field });
    const transforms = instanceTransforms(source, count);
    if (!transforms.ok) return fail(FieldStage.Placement, transforms, { count, field });
    return {
      kind: 'field',
      record: {
        worldId: slot.worldId,
        entityKey: slot.entityKey,
        slot: slot.slot,
        generation: slot.generation,
      },
      scope,
      assetHandle: source.assetHandle,
      assetRevision,
      mesh,
      field,
      instances: detachedInstanceIdentity(source),
      materials: materials.value,
      transforms: transforms.value,
    };
  }

  #qualifyGeometry(mesh: MeshAsset, field: AttachedField) {
    if (this.#geometry.has(mesh)) return this.#geometry.get(mesh);
    const validSource = meshDistanceFieldSource(mesh, {
      sectionSidedness: field.sectionSidedness,
    });
    const result = validSource.ok
      ? undefined
      : rayReferenceFailure(validSource.error.detail.reason);
    this.#geometry.set(mesh, result);
    return result;
  }

  #qualifyField(field: AttachedField) {
    if (this.#fields.has(field)) return this.#fields.get(field);
    let result: Result<never, RayReferenceError> | undefined;
    if (!hasAdmittedFieldArtifact(field))
      result = rayReferenceFailure(
        'retained field requires its admitted sampled-visibility artifact Integrity and Codec',
      );
    else {
      const valid = validateMeshDistanceField(field);
      if (!valid.ok) result = rayReferenceFailure(valid.error.detail.reason);
    }
    this.#fields.set(field, result);
    return result;
  }
}

/** One cold projection of a fixed composition; persistent consumers keep a {@link SceneFieldRows}. */
export function projectSceneFields(
  slots: FrameList<RenderSceneSlot>,
  worlds: readonly RenderResourceScope[],
  budget: FieldBudget,
  assets: Pick<AssetRegistry, 'getMaterialProjectionForPayload'>,
  frame?: { readonly materials: MaterialFrame; readonly meshes: MeshFrame },
): Result<SceneFieldProjection, RayReferenceError> {
  return new SceneFieldRows().update(
    {
      identity: {},
      slots,
      materials: frame?.materials ?? new MaterialFrame(undefined),
      meshes: frame?.meshes ?? new MeshFrame(),
    },
    worlds,
    budget,
    assets,
  );
}

function sectionMaterials(
  source: FieldSceneSource,
  bindings: Pick<FieldSceneSource, 'material' | 'materials'>,
  mesh: MeshAsset,
  field: AttachedField,
  scope: RenderResourceScope,
  assets: Pick<AssetRegistry, 'getMaterialProjectionForPayload'>,
  rows: ProjectedRows,
  read: ReadAsset,
): Result<FieldMaterial[], RayReferenceError> {
  const draws = sectionDraws(source, mesh);
  if (!draws.ok) return draws;
  const materials: FieldMaterial[] = [];
  let first = 0;
  for (const [sectionIndex, section] of mesh.submeshes.entries()) {
    const resource = bindings.materials[section.materialSlot] ?? bindings.material;
    const material = sectionMaterial(resource, section, field, sectionIndex, scope, assets, rows);
    const handle = (rows.materials.get(resource)?.snapshot ?? resource.snapshot).materialHandle;
    if (handle !== undefined) read(scope, handle);
    if (!material.ok) return material;
    const draw = draws.value.get(sectionIndex);
    if (draw !== undefined && !drawMatchesSection(draw, sectionIndex, mesh, section, first))
      return rayReferenceFailure(
        'retained draw subset or range disagrees with its actual whole-mesh field',
      );
    first += section.vertexCount;
    materials.push(material.value);
  }
  return ok(materials);
}

/** Resolve and qualify one section's effective native Standard material. */
function sectionMaterial(
  resource: MaterialResource,
  section: FieldSection,
  field: AttachedField,
  sectionIndex: number,
  scope: RenderResourceScope,
  assets: Pick<AssetRegistry, 'getMaterialProjectionForPayload'>,
  rows: ProjectedRows,
): Result<FieldMaterial, RayReferenceError> {
  const material = rows.materials.get(resource)?.snapshot ?? resource.snapshot,
    handle = material.materialHandle;
  if (
    !Number.isInteger(section.materialSlot) ||
    section.materialSlot < 0 ||
    material === undefined ||
    handle === undefined
  )
    return rayReferenceFailure(
      'every actual mesh section must resolve its effective material slot',
    );
  const payload = scope.resolveAsset<MaterialAsset>(handle as AssetHandle<'material'>);
  if (!payload.ok || payload.value.kind !== 'material')
    return rayReferenceFailure(
      'retained field material handle is unavailable in its resource scope',
    );
  const projection = assets.getMaterialProjectionForPayload(payload.value);
  if (
    !isNativePlacementMaterial(material, projection, payload.value) ||
    (material.surfaceModel !== undefined && material.surfaceModel !== 'standard')
  )
    return rayReferenceFailure(
      'retained field requires accepted native Standard material provenance',
    );
  const color = (projection?.passes ?? payload.value.passes ?? []).filter((pass) =>
    isColorPass(pass),
  );
  const values = materialFieldValues(payload.value);
  const coverage = admitRayMaterialValues(values, String(handle), 'retained-mesh-field');
  if (!coverage.ok) return rayReferenceFailure(coverage.error.detail.requirement);
  const alphaCutoff = materialScalar(values, 'alphaCutoff', 0),
    displacementScale = materialScalar(values, 'displacementScale', 1),
    displacementBias = materialScalar(values, 'displacementBias', 0);
  const clipping = values.clippingControl;
  if (
    rejectsOpaqueCoverage(material, color, clipping) ||
    displacedCoverage(material, payload.value, values, displacementScale, displacementBias) ||
    !isUnitInterval(alphaCutoff)
  )
    return rayReferenceFailure(
      'retained field rejects transparent, displaced or locally clipped material coverage',
    );
  if (!matchesFieldSidedness(material, color, field.sectionSidedness[sectionIndex]))
    return rayReferenceFailure(
      'retained material sidedness differs from its cooked whole-mesh field; recook the producer',
    );
  const {
    materialShaderId,
    materialProgramKeys,
    materialSurfacePrograms,
    renderState,
    paramSnapshot,
    textureHandles,
    textureCoordinates,
  } = material;
  return ok({
    resource,
    materialSlot: section.materialSlot,
    handle,
    payload: payload.value,
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

function instanceTransforms(
  source: FieldSceneSource,
  count: number,
): Result<Float32Array[], RayReferenceError> {
  const root = fieldTransform(source.transform.world);
  if (!root.ok) return root;
  const transforms: Float32Array[] = [];
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
    transforms.push(transform.value);
  }
  return ok(transforms);
}

/** Skinned or morphed sources have no rest-pose field that stays valid while animating. */
function isDeformingFieldSource(source: FieldSceneSource, mesh: MeshAsset): boolean {
  return (
    source.skinBinding !== undefined ||
    source.morph !== undefined ||
    mesh.morphWeights !== undefined ||
    mesh.morphTargets !== undefined
  );
}

function hasUnqualifiedFieldGeometry(slot: RenderSceneSlot, mesh: MeshAsset): boolean {
  const source = slot.snapshot;
  return (
    source.spriteInstances !== undefined ||
    source.pointsLines !== undefined ||
    (source.lods?.length ?? 0) > 0 ||
    (mesh.lods?.length ?? 0) > 0
  );
}

function hasAdmittedFieldArtifact(field: AttachedField): boolean {
  const artifact = field.artifact,
    codec = artifact?.assetCodec;
  return (
    artifact?.integrity.algorithm === 'sha256' &&
    /^sha256:[a-f0-9]{64}$/.test(artifact.integrity.digest) &&
    codec?.name === MESH_VISIBILITY_DISTANCE_FIELD_CODEC.name &&
    codec.version === MESH_VISIBILITY_DISTANCE_FIELD_CODEC.version &&
    codec.profile === MESH_VISIBILITY_DISTANCE_FIELD_CODEC.profile &&
    codec.container === undefined &&
    field.policy.kind === 'sampled-visibility'
  );
}

// Draws may be absent or filtered by backend preparation. Actual Mesh
// sections own coverage; present draw ranges can only contradict it.
function sectionDraws(
  source: FieldSceneSource,
  mesh: MeshAsset,
): Result<Map<number, FieldDraw>, RayReferenceError> {
  const draws = new Map<number, FieldDraw>();
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
  return ok(draws);
}

/** Does a present draw cover exactly this whole section of the actual mesh? */
function drawMatchesSection(
  draw: FieldDraw,
  sectionIndex: number,
  mesh: MeshAsset,
  section: FieldSection,
  first: number,
): boolean {
  const indexed = mesh.indices !== undefined;
  return (
    gpuDrivenSourceDrawItemIndex(draw, sectionIndex) === sectionIndex &&
    draw.kind === (indexed ? 'indexed' : 'non-indexed') &&
    draw.topology === section.topology &&
    draw.materialSlot === section.materialSlot &&
    draw.first === (indexed ? section.indexOffset : first) &&
    draw.count === (indexed ? section.indexCount : section.vertexCount) &&
    draw.baseVertex === 0 &&
    (draw.lodRanges?.length ?? 0) === 0
  );
}

/** Shadow and depth passes never contribute color coverage. */
function isColorPass(pass: {
  readonly name: string;
  readonly renderState?: { readonly tags?: unknown } | undefined;
}): boolean {
  return !/shadow|depth/i.test(
    String(
      (pass.renderState?.tags as Readonly<Record<string, unknown>> | undefined)?.LightMode ??
        pass.name,
    ),
  );
}

/** Declared parameter defaults overlaid by authored values. */
function materialFieldValues(payload: MaterialAsset): Record<string, unknown> {
  return {
    ...Object.fromEntries(
      (payload.parameters ?? []).map((parameter) => [
        parameter.name,
        'default' in parameter ? parameter.default : undefined,
      ]),
    ),
    ...payload.values,
  };
}

function materialScalar(
  values: Readonly<Record<string, unknown>>,
  name: string,
  fallback: number,
): number {
  const value = values[name];
  if (value === undefined) return fallback;
  return typeof value === 'number' ? value : NaN;
}

function isUnitInterval(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Instance owner identity without per-frame transforms, detached from the source. */
function detachedInstanceIdentity(
  source: FieldSceneSource,
): Omit<InstancesSnapshot, 'transforms' | 'dirtyRanges'> | undefined {
  if (source.instances === undefined) return undefined;
  const { transforms: _transforms, dirtyRanges: _dirty, ...identity } = source.instances;
  return structuredClone(identity);
}

function isLocallyClipped(value: unknown): boolean {
  return value !== undefined && (!Array.isArray(value) || value[0] !== 0);
}

/** Transparent, blended or locally clipped coverage cannot be a closed field surface. */
function rejectsOpaqueCoverage(
  material: MaterialSnapshot,
  color: readonly { readonly renderState?: { readonly blend?: unknown } | undefined }[],
  clipping: unknown,
): boolean {
  return (
    material.transparent === true ||
    material.renderState?.blend !== undefined ||
    color.some((pass) => pass.renderState?.blend !== undefined) ||
    isLocallyClipped(clipping) ||
    isLocallyClipped(material.paramSnapshot?.clippingControl)
  );
}

/** Does either the accepted or the authored Standard displacement move the surface? */
function displacedCoverage(
  material: MaterialSnapshot,
  payload: MaterialAsset,
  values: Readonly<Record<string, unknown>>,
  displacementScale: number,
  displacementBias: number,
): boolean {
  const actualDisplacement = standardDisplacementRadius([
    {
      ...material,
      standardTextureMask: materialStandardTextureMask(
        payload.parameters,
        'forgeax::default-standard-pbr',
        values,
      ),
      paramSnapshot: { displacementScale, displacementBias },
    },
  ]);
  return standardDisplacementRadius([material]) !== 0 || actualDisplacement !== 0;
}

function matchesFieldSidedness(
  material: MaterialSnapshot,
  color: readonly { readonly renderState?: MaterialSnapshot['renderState'] }[],
  sidedness: number | undefined,
): boolean {
  for (const state of [material.renderState, ...color.map((pass) => pass.renderState)]) {
    const cull = state?.cullMode ?? 'back';
    if ((cull !== 'back' && cull !== 'none') || Number(cull === 'none') !== sidedness) return false;
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
    const color = (source.passes ?? []).filter((pass) => isColorPass(pass));
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
  const color = projection.passes.filter((pass) => isColorPass(pass));
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

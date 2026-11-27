import type { MaterialResource } from '../material-resource';
import { getOpaqueResourceIdentity } from '../record/frame-snapshot';
import type { GpuDrivenDrawSnapshot } from '../render-system-extract';
import { changes, type Node } from '../scene/frame-tree';
import { TreeFrame } from '../scene/frame-tree-list';
import type { MaterialFrame } from '../scene/material-dispatch';
import type { MeshFrame, MeshGeometry } from '../scene/mesh-frame';
import { defaultMeshMaterial, effectiveMeshMaterials } from '../scene/mesh-materials';
import { StableRangeAllocator } from '../stable-range-allocator';
import { type BatchGeometry, batchVertexLayout, captureBatchGeometry } from './batch-execution';
import { captureMeshBatch } from './batch-key';
import { batchLodLevelCount, GPU_DRIVEN_INDIRECT_COMMAND_BYTES } from './batch-layout';
import { BatchSources } from './batch-members';
import type {
  EligibleGpuDrivenDraw,
  GpuDrivenBatch,
  MeshBatchSource,
  SubmissionPlan,
} from './batch-topology';
import { captureTaskMembership, materialBindingLayout } from './fixed-task-plan';
import { rowMaterialSlot } from './row-materials';
import { sealSourceDraws } from './source-draw-indices';

/** These branches come only from this owner's path-copying execution tree. */
function sealPublishedTasks(root: Node<GpuDrivenBatch> | undefined): void {
  if (root === undefined || Object.isFrozen(root)) return;
  sealPublishedTasks(root.left);
  sealPublishedTasks(root.right);
  Object.freeze(root);
}

interface MeshSections {
  readonly rows: readonly { readonly materialSlot: number; readonly geometry: BatchGeometry }[];
  readonly pipelineClass: string;
  readonly bindings: WeakMap<readonly MaterialResource[], readonly GpuDrivenDrawSnapshot[]>;
}

const meshSections = new WeakMap<
  MeshGeometry,
  Partial<Record<BatchGeometry['deformation'], MeshSections>>
>();

/** Ranges, vertex declarations and deformation belong to the accepted Mesh revision. */
function captureMeshSections(
  mesh: MeshGeometry,
  deformation: BatchGeometry['deformation'],
): MeshSections {
  const { layout, vertexInputs } = batchVertexLayout(mesh.layout);
  const identity = `${mesh.handle}:${layout.digest}`;
  let firstVertex = 0;
  const rows = mesh.submeshes.map((submesh) => {
    const count = mesh.indexed ? submesh.indexCount : submesh.vertexCount;
    const first = mesh.indexed ? submesh.indexOffset : firstVertex;
    if (!mesh.indexed) firstVertex += count;
    const geometry = captureBatchGeometry({
      receipt: { identity, vertexInputs, topology: submesh.topology, indexed: mesh.indexed },
      layout,
      draw: {
        kind: mesh.indexed ? 'indexed' : 'non-indexed',
        first,
        count,
        baseVertex: 0,
        topology: submesh.topology,
      },
      deformation,
    });
    return { materialSlot: submesh.materialSlot, geometry };
  });
  return { rows, pipelineClass: `${identity}|${deformation}`, bindings: new WeakMap() };
}

/** Binding a material table preserves each physical section and its issued ABI. */
export function meshGeometryDraws(
  mesh: MeshGeometry,
  materials: readonly MaterialResource[],
  deformation: BatchGeometry['deformation'],
): readonly GpuDrivenDrawSnapshot[] {
  let owner = meshSections.get(mesh);
  if (owner === undefined) {
    owner = {};
    meshSections.set(mesh, owner);
  }
  owner[deformation] ??= captureMeshSections(mesh, deformation);
  const sections = owner[deformation];
  const bound = sections.bindings.get(materials);
  if (bound !== undefined) return bound;
  const draws = sections.rows.map(({ geometry, materialSlot }, drawItemIndex) => {
    const material = materials[materialSlot] ?? defaultMeshMaterial;
    return {
      ...geometry.draw,
      drawItemIndex,
      materialSlot,
      pipelineClass: sections.pipelineClass,
      materialResourceClass: String(getOpaqueResourceIdentity(material)),
      geometry,
    };
  });
  const result = sealSourceDraws(draws);
  sections.bindings.set(materials, result);
  return result;
}

const meshExecutions = new WeakMap<
  MeshBatchSource,
  WeakMap<
    MeshGeometry,
    {
      readonly materials: readonly MaterialResource[];
      readonly draws: readonly EligibleGpuDrivenDraw[];
    }
  >
>();
/** Expand shared Mesh facts, without reading or copying source members. */
function meshDraws(source: MeshBatchSource, mesh: MeshGeometry): readonly EligibleGpuDrivenDraw[] {
  let versions = meshExecutions.get(source);
  if (versions === undefined) {
    versions = new WeakMap();
    meshExecutions.set(source, versions);
  }
  const template = source.draws[0];
  if (template === undefined) return [];
  const materials = effectiveMeshMaterials(
    source,
    mesh,
    template.binding.geometry.deformation === 'skin' ? 'skinned' : 'mesh',
  );
  const cached = versions.get(mesh);
  if (cached?.materials === materials.materials) return cached.draws;
  // Morphed members deform LOD0 vertices; their batch carries no LOD chain.
  const morph = template.binding.morph;
  const rowGroup = template.binding.rowGroup;
  const rowClass = rowGroup?.text;
  const lods = morph === undefined ? mesh.lods?.map((level) => level.mesh) : undefined;
  const lod =
    mesh.lods === undefined || morph !== undefined
      ? undefined
      : Object.freeze({
          coverages: Object.freeze([1, ...mesh.lods.map((level) => level.screenCoverage)]),
          ...(mesh.lodHysteresis === undefined ? {} : { hysteresis: mesh.lodHysteresis }),
        });
  const draws = meshGeometryDraws(
    mesh,
    materials.materials,
    template.binding.geometry.deformation,
  ).map((draw): EligibleGpuDrivenDraw => {
    const drawItemIndex = draw.drawItemIndex ?? 0;
    return Object.freeze({
      sourceDrawIndex: drawItemIndex,
      binding: Object.freeze({
        assetHandle: mesh.handle,
        ...(lods === undefined ? {} : { lods }),
        material: materials.materials[draw.materialSlot] ?? materials.material,
        geometry: draw.geometry,
        drawItemIndex,
        ...(morph === undefined ? {} : { morph }),
        ...(rowGroup !== undefined && rowMaterialSlot(source, draw.materialSlot)
          ? { rowGroup }
          : {}),
      }),
      key: Object.freeze({
        drawItemIndex,
        assetHandle: mesh.handle,
        ...(template.key.residencyGroup === undefined
          ? {}
          : { residencyGroup: template.key.residencyGroup }),
        drawKind: draw.kind,
        first: draw.first,
        count: draw.count,
        baseVertex: draw.baseVertex,
        materialSlot: draw.materialSlot,
        topology: draw.topology,
        ...(template.key.reflected ? { reflected: true } : {}),
        ...(morph === undefined ? {} : { morph }),
        pipelineClass: draw.pipelineClass,
        // One-entry overrides address only slot 0 per row; other slots are Mesh defaults.
        ...(rowClass !== undefined && rowMaterialSlot(source, draw.materialSlot)
          ? { rowMaterial: true as const, materialResourceClass: rowClass }
          : { materialResourceClass: draw.materialResourceClass }),
      }),
      ...(lod === undefined ? {} : { lod }),
    });
  });
  const result = Object.freeze(draws);
  versions.set(mesh, { materials: materials.materials, draws: result });
  return result;
}

/** Parameter versions keep execution bindings; resource replacement changes the join. */
function materialBindingsChanged(
  previous: MaterialFrame | undefined,
  current: MaterialFrame | undefined,
): boolean {
  if (previous === current) return false;
  if (previous === undefined || current === undefined) return true;
  let changed = false;
  current.changesSince(previous, (before, after) => {
    if (before === undefined || after === undefined) changed = true;
  });
  return changed;
}

function querySources(source: SubmissionPlan): BatchSources {
  // Raw callers supply live facts. Only the producer-owned fixed domain may
  // retain its identity instead of capturing the actual task roster again.
  if (BatchSources.isFixed(source.batches)) return source.batches;
  let batches = new BatchSources();
  for (const batch of source.batches) batches = batches.with(batch);
  return batches;
}

interface ExecutionWindow {
  readonly batchId: number;
  readonly generation: number;
  ordinal: number;
  visibleStart: number;
  levelCapacity: number;
  indirectStart: number;
  levels: number;
  published: GpuDrivenBatch | undefined;
}

interface ExecutionGroup {
  readonly generation: number;
  readonly windows: Map<number, ExecutionWindow>;
}

/** Both outputs belong to one source join and share its physical command windows. */
export interface MeshExecutionPlans {
  readonly resident: SubmissionPlan;
  readonly active: SubmissionPlan;
}

interface PreviousWindowSelection {
  readonly source: BatchSources;
  readonly active: TreeFrame<GpuDrivenBatch>;
  readonly resident: TreeFrame<GpuDrivenBatch>;
}

interface SelectedSourceRoots {
  readonly source: BatchSources;
  readonly complete: BatchSources;
}

function validateExecutionSelection(
  selected: BatchSources,
  complete: BatchSources,
  before: SelectedSourceRoots | undefined,
): void {
  const validate = (candidate: GpuDrivenBatch | undefined) => {
    if (candidate !== undefined && complete.get(candidate.batchId) !== candidate)
      throw new Error('Execution selection must retain the exact resident source batch');
  };
  selected.changesSince(before?.source ?? complete, (_before, after) => validate(after));
  // A previously selected source can become stale through a resident edit even
  // when the selected tree kept its identity. Check only those edited keys.
  if (before !== undefined) {
    complete.changesSince(before.complete, (left, right) => {
      const id = (right ?? left)?.batchId;
      if (id !== undefined) validate(selected.get(id));
    });
  }
}

function previousWindowSelection(
  source: BatchSources | undefined,
  execution: MeshExecutionPlans | undefined,
): PreviousWindowSelection | undefined {
  return source !== undefined &&
    execution?.active.batches instanceof TreeFrame &&
    execution.resident.batches instanceof TreeFrame
    ? { source, active: execution.active.batches, resident: execution.resident.batches }
    : undefined;
}

/** Stable physical command windows for the last actual task query, never source maintenance. */
export class MeshBatchProjection {
  private readonly groups = new Map<number, ExecutionGroup>();
  private readonly visibleRanges = new StableRangeAllocator();
  private readonly indirectRanges = new StableRangeAllocator();
  private readonly generations: number[] = [];
  private readonly freeIds: number[] = [];
  private published = new TreeFrame<GpuDrivenBatch>();
  private bindingLayout: symbol | undefined;
  private sourceRoot: BatchSources | undefined;
  private plan: SubmissionPlan | undefined;
  private selection: SelectedSourceRoots | undefined;
  private execution: MeshExecutionPlans | undefined;
  // Lookup qualification only: neither this memo nor GC owns output windows.
  // It deliberately cannot retain an unrelated MeshFrame's payload closure.
  private queriedMeshes = new WeakSet<MeshFrame>();
  private queriedWithoutMeshes = false;
  /** Meshes of the last full or patched query; a mesh edit re-joins only its bindings. */
  private meshes: MeshFrame | undefined;
  private materials: MaterialFrame | undefined;
  private meshKnown = false;
  private readonly sourcesByMesh = new Map<string, Map<number, GpuDrivenBatch>>();
  private readonly meshKeyBySource = new Map<number, string>();
  readonly windowCompactions = 0;
  windowRelocations = 0;

  /** Explicit new/recovered baseline; keep generations, discard all allocation facts. */
  reset(): void {
    this.groups.clear();
    this.visibleRanges.reset();
    this.indirectRanges.reset();
    this.published = new TreeFrame();
    this.bindingLayout = undefined;
    this.sourceRoot = undefined;
    this.plan = undefined;
    this.selection = undefined;
    this.execution = undefined;
    this.queriedMeshes = new WeakSet();
    this.queriedWithoutMeshes = false;
    this.meshes = undefined;
    this.materials = undefined;
    this.meshKnown = false;
    this.sourcesByMesh.clear();
    this.meshKeyBySource.clear();
    this.freeIds.length = 0;
    for (let id = this.generations.length - 1; id >= 0; id--) this.freeIds.push(id);
  }

  /** Enumerate tasks for a real executed view; source publication never calls this. */
  query(
    source: SubmissionPlan,
    meshes: MeshFrame | undefined,
    materials?: MaterialFrame,
  ): MeshExecutionPlans {
    const baseline = source.resident;
    if (baseline === undefined) {
      this.selection = undefined;
      const resident = this.queryResident(source, meshes, materials);
      if (this.execution?.resident === resident && this.execution.active === resident)
        return this.execution;
      this.execution = Object.freeze({ resident, active: resident });
      return this.execution;
    }
    if (baseline.resident !== undefined)
      throw new Error('Execution selection requires one resident source baseline');
    const selected = querySources(source);
    const complete = querySources(baseline);
    const previous = this.selection;
    const execution = this.execution;
    validateExecutionSelection(selected, complete, previous);
    const resident = this.queryResident(baseline, meshes, materials);
    if (execution?.resident === resident && previous?.source === selected) return execution;
    const active = this.selectWindows(
      previousWindowSelection(previous?.source, execution),
      complete,
      selected,
      resident,
    );
    this.selection = { source: selected, complete };
    this.execution = Object.freeze({ resident, active });
    return this.execution;
  }

  private selectWindows(
    before: PreviousWindowSelection | undefined,
    complete: BatchSources,
    selected: BatchSources,
    resident: SubmissionPlan,
  ): SubmissionPlan {
    // Physical windows are already resident. The selection only changes references to them.
    let batches = before?.active ?? this.published;
    let layout = materialBindingLayout(batches);
    if (before !== undefined) {
      // Only previously selected sources can have stale windows in the active
      // tree. Native changes to dormant sources leave that tree untouched.
      changes(before.resident.root, this.published.root, (left, right, ordinal, sourceId) => {
        if (before.source.get(sourceId) === undefined) return;
        if (right !== undefined && selected.get(sourceId) !== undefined) {
          if (left === undefined || left.binding !== right.binding) layout = undefined;
          batches = batches.with(right, sourceId, ordinal, right.candidates.length);
        } else if (left !== undefined) {
          layout = undefined;
          batches = batches.without(sourceId, ordinal);
        }
      });
    }
    selected.changesSince(before?.source ?? complete, (left, right) => {
      if (left !== undefined && right !== undefined) return;
      const id = (right ?? left)?.batchId;
      if (id === undefined) return;
      for (const window of this.groups.get(id)?.windows.values() ?? []) {
        layout = undefined;
        if (right === undefined) batches = batches.without(id, window.ordinal);
        else {
          const batch = window.published;
          if (batch === undefined) throw new Error('Execution selection lost its resident window');
          batches = batches.with(batch, id, window.ordinal, batch.candidates.length);
        }
      }
    });
    sealPublishedTasks(batches.root);
    Object.freeze(batches);
    return captureTaskMembership(
      Object.freeze({
        revision: resident.revision,
        batches,
        candidateCount: batches.weight,
        visibleCapacity: resident.visibleCapacity,
        sourceGroups: selected,
      }),
      layout ?? Symbol(),
      resident,
    );
  }

  private queryResident(
    source: SubmissionPlan,
    meshes: MeshFrame | undefined,
    materials: MaterialFrame | undefined,
  ): SubmissionPlan {
    const batches = querySources(source);
    if (this.sourceRoot !== batches) {
      this.selection = undefined;
      this.execution = undefined;
    }
    const rebindMaterials = materialBindingsChanged(this.materials, materials);
    if (
      this.plan !== undefined &&
      this.sourceRoot === batches &&
      !rebindMaterials &&
      (meshes === undefined ? this.queriedWithoutMeshes : this.queriedMeshes.has(meshes))
    ) {
      this.materials = materials;
      return this.plan;
    }
    // Each join supplies an actual selector/raster task, including tasks whose
    // GPU cull produces zero visible instances. No resource-version polling or
    // group repair runs from Mesh adoption, publication, or a skipped view.
    // A retained baseline re-joins only edited sources and sources whose Mesh
    // changed; every other window and publication is unchanged by definition.
    this.reconcileSources(batches, meshes, rebindMaterials);
    this.meshes = meshes;
    this.materials = materials;
    this.meshKnown = true;
    sealPublishedTasks(this.published.root);
    Object.freeze(this.published);
    const previous = this.plan;
    this.bindingLayout ??= Symbol();
    const plan =
      previous?.batches === this.published && previous.sourceGroups === batches
        ? previous
        : captureTaskMembership(
            Object.freeze({
              revision: (previous?.revision ?? -1) + 1,
              batches: this.published,
              candidateCount: this.published.weight,
              visibleCapacity: this.visibleRanges.requiredCapacity() * 64,
              sourceGroups: batches,
            }),
            this.bindingLayout,
          );
    this.sourceRoot = batches;
    this.queriedMeshes = new WeakSet();
    this.queriedWithoutMeshes = meshes === undefined;
    if (meshes !== undefined) this.queriedMeshes.add(meshes);
    this.plan = plan;
    return plan;
  }

  /** Exact current complete execution output, excluding active selections and other owners. */
  isResidentPlan(plan: SubmissionPlan): boolean {
    return this.meshKnown && this.plan === plan;
  }

  private reconcileSources(
    batches: BatchSources,
    meshes: MeshFrame | undefined,
    rebindMaterials: boolean,
  ): void {
    const baseline = this.sourceRoot;
    const patch =
      baseline !== undefined &&
      this.meshKnown &&
      !rebindMaterials &&
      (meshes === undefined) === (this.meshes === undefined);
    // A failed join leaves partial windows; the next query then rejoins all.
    this.meshKnown = false;
    if (patch) {
      const touched = new Map<number, GpuDrivenBatch>();
      if (baseline !== batches)
        batches.changesSince(baseline, (before, after) => {
          if (after !== undefined) touched.set(after.batchId, after);
          else if (before !== undefined) {
            this.remove(before.batchId);
            this.unindex(before.batchId);
          }
        });
      if (meshes !== undefined && this.meshes !== undefined && meshes !== this.meshes)
        meshes.changesSince(this.meshes, (before, after) => {
          const geometry = after ?? before;
          if (geometry === undefined) return;
          for (const member of this.sourcesByMesh.get(`${geometry.handle}`)?.values() ?? [])
            if (batches.get(member.batchId) === member) touched.set(member.batchId, member);
        });
      for (const member of touched.values()) this.update(member, meshes);
    } else {
      if (baseline !== undefined && baseline !== batches) {
        batches.changesSince(baseline, (before, after) => {
          if (before !== undefined && after === undefined) {
            this.remove(before.batchId);
            this.unindex(before.batchId);
          }
        });
      }
      for (const member of batches) this.update(member, meshes);
    }
  }

  private unindex(batchId: number): void {
    const key = this.meshKeyBySource.get(batchId);
    if (key === undefined) return;
    this.meshKeyBySource.delete(batchId);
    const sources = this.sourcesByMesh.get(key);
    sources?.delete(batchId);
    if (sources?.size === 0) this.sourcesByMesh.delete(key);
  }

  private index(member: GpuDrivenBatch): void {
    const binding = member.binding;
    if (binding === undefined) return;
    const key = `${binding.assetHandle}`;
    const previous = this.meshKeyBySource.get(member.batchId);
    if (previous !== undefined && previous !== key) this.unindex(member.batchId);
    this.meshKeyBySource.set(member.batchId, key);
    let sources = this.sourcesByMesh.get(key);
    if (sources === undefined) {
      sources = new Map();
      this.sourcesByMesh.set(key, sources);
    }
    sources.set(member.batchId, member);
  }

  private remove(batchId: number): void {
    const group = this.groups.get(batchId);
    if (group === undefined) return;
    for (const window of group.windows.values()) this.retire(batchId, window);
    this.groups.delete(batchId);
  }

  private retire(sourceId: number, window: ExecutionWindow): void {
    this.visibleRanges.release(window.visibleStart, window.levelCapacity * window.levels);
    this.indirectRanges.release(window.indirectStart, window.levels);
    this.freeIds.push(window.batchId);
    this.bindingLayout = undefined;
    this.published = this.published.without(sourceId, window.ordinal);
  }

  private update(member: GpuDrivenBatch, meshes: MeshFrame | undefined): void {
    const binding = member.binding;
    if (binding === undefined) throw new Error('Mesh membership requires its source binding');
    this.index(member);
    const authored = binding.source;
    const mesh = meshes?.get(binding.assetHandle);
    const draws =
      authored === undefined ? [] : mesh === undefined ? authored.draws : meshDraws(authored, mesh);
    let group = this.groups.get(member.batchId);
    if (group !== undefined && group.generation !== member.generation) {
      this.remove(member.batchId);
      group = undefined;
    }
    if (group === undefined) {
      group = { generation: member.generation, windows: new Map() };
      this.groups.set(member.batchId, group);
    }
    // These are the authored executions of one changed source, not its instances.
    const reordered = draws.some(
      (descriptor, ordinal) => group.windows.get(descriptor.sourceDrawIndex)?.ordinal !== ordinal,
    );
    if (reordered || group.windows.size !== draws.length) {
      this.bindingLayout = undefined;
      const live = new Set<number>();
      for (const descriptor of draws) {
        if (live.has(descriptor.sourceDrawIndex))
          throw new Error('Duplicate authored Mesh draw identity');
        live.add(descriptor.sourceDrawIndex);
      }
      for (const [draw, window] of group.windows) {
        if (live.has(draw)) continue;
        this.retire(member.batchId, window);
        group.windows.delete(draw);
      }
    }
    if (reordered) {
      // Remove all previous keys before publishing the reordered local group.
      for (const window of group.windows.values()) {
        this.published = this.published.without(member.batchId, window.ordinal);
        window.published = undefined;
      }
    }
    for (let ordinal = 0; ordinal < draws.length; ordinal++) {
      const descriptor = draws[ordinal];
      if (descriptor === undefined) continue;
      const draw = descriptor.sourceDrawIndex;
      const levels = batchLodLevelCount(descriptor);
      const required = Math.max(1, Math.ceil(member.candidates.length / 64));
      let window = group.windows.get(draw);
      if (window === undefined) {
        const visibleStart = this.visibleRanges.allocate(required * levels);
        let indirectStart: number;
        try {
          indirectStart = this.indirectRanges.allocate(levels);
        } catch (cause) {
          this.visibleRanges.release(visibleStart, required * levels);
          throw cause;
        }
        const reused = this.freeIds.pop();
        const batchId = reused ?? this.generations.length;
        const generation = reused === undefined ? 0 : (this.generations[batchId] ?? -1) + 1;
        this.generations[batchId] = generation;
        window = {
          batchId,
          generation,
          ordinal,
          visibleStart,
          levelCapacity: required,
          indirectStart,
          levels,
          published: undefined,
        };
        try {
          group.windows.set(draw, window);
        } catch (cause) {
          this.visibleRanges.release(visibleStart, required * levels);
          this.indirectRanges.release(indirectStart, levels);
          this.freeIds.push(batchId);
          throw cause;
        }
      } else {
        const published = window.published;
        if (published?.binding !== descriptor.binding) this.bindingLayout = undefined;
        if (
          published?.binding !== descriptor.binding ||
          published.key !== descriptor.key ||
          published.candidates !== member.candidates ||
          published.contentEpoch !== member.contentEpoch
        )
          window.published = undefined;
        window.ordinal = ordinal;
        if (
          window.levelCapacity < required ||
          window.levelCapacity > required * 4 ||
          window.levels !== levels
        ) {
          // Growth reserves 1.5x of the outgrown window: amortized O(1) relocations.
          const reserved =
            window.levels === levels && window.levelCapacity < required
              ? Math.max(required, Math.ceil(window.levelCapacity * 1.5))
              : required;
          const start = this.visibleRanges.allocate(reserved * levels);
          let indirectStart = window.indirectStart;
          try {
            if (window.levels !== levels) indirectStart = this.indirectRanges.allocate(levels);
          } catch (cause) {
            this.visibleRanges.release(start, reserved * levels);
            throw cause;
          }
          this.visibleRanges.release(window.visibleStart, window.levelCapacity * window.levels);
          if (window.levels !== levels)
            this.indirectRanges.release(window.indirectStart, window.levels);
          window.visibleStart = start;
          window.indirectStart = indirectStart;
          window.levelCapacity = reserved;
          window.levels = levels;
          window.published = undefined;
          this.windowRelocations++;
        }
      }
      if (window.published === undefined) {
        window.published = captureMeshBatch({
          batchId: window.batchId,
          generation: window.generation,
          key: descriptor.key,
          binding: descriptor.binding,
          candidates: member.candidates,
          ...(member.members === undefined ? {} : { members: member.members }),
          visibleBase: window.visibleStart * 64,
          visibleCapacity: member.candidates.length,
          visibleAllocationCapacity: window.levelCapacity * 64,
          indirectOffset: window.indirectStart * GPU_DRIVEN_INDIRECT_COMMAND_BYTES,
          ...(descriptor.lod === undefined ? {} : { lod: descriptor.lod }),
          contentEpoch: member.contentEpoch,
        });
        this.published = this.published.with(
          window.published,
          member.batchId,
          ordinal,
          member.candidates.length,
        );
      }
    }
  }
}

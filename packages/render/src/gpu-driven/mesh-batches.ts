import type { MaterialResource } from '../material-resource';
import { getOpaqueResourceIdentity } from '../record/frame-snapshot';
import type { GpuDrivenDrawSnapshot } from '../render-system-extract';
import { TreeFrame } from '../scene/frame-tree-list';
import type { MeshFrame, MeshGeometry } from '../scene/mesh-frame';
import { defaultMeshMaterial, effectiveMeshMaterials } from '../scene/mesh-materials';
import { StableRangeAllocator } from '../stable-range-allocator';
import { captureBatchGeometry } from './batch-execution';
import { captureMeshBatch } from './batch-key';
import { batchLodLevelCount, GPU_DRIVEN_INDIRECT_COMMAND_BYTES } from './batch-layout';
import { BatchSources } from './batch-members';
import type {
  EligibleGpuDrivenDraw,
  GpuDrivenBatch,
  MeshBatchSource,
  SubmissionPlan,
} from './batch-topology';

const geometryDraws = new WeakMap<
  MeshGeometry,
  WeakMap<readonly MaterialResource[], Map<string, readonly GpuDrivenDrawSnapshot[]>>
>();

/** Shared CPU/GPU geometry projection from one accepted Mesh and material table. */
export function meshGeometryDraws(
  mesh: MeshGeometry,
  materials: readonly MaterialResource[],
  deformation: 'rigid' | 'skin',
): readonly GpuDrivenDrawSnapshot[] {
  let bindings = geometryDraws.get(mesh);
  if (bindings === undefined) {
    bindings = new WeakMap();
    geometryDraws.set(mesh, bindings);
  }
  let versions = bindings.get(materials);
  if (versions === undefined) {
    versions = new Map();
    bindings.set(materials, versions);
  }
  const cached = versions.get(deformation);
  if (cached !== undefined) return cached;
  const vertexInputs = mesh.layout.attributes.map((attribute) => ({
    semantic: attribute.key,
    location: attribute.shaderLocation,
    format: attribute.format,
  }));
  const identity = `${mesh.worldId}:${mesh.handle}:${mesh.layout.digest}`;
  let vertexStart = 0;
  const draws = mesh.submeshes.map((submesh, drawItemIndex): GpuDrivenDrawSnapshot => {
    const material = materials[submesh.materialSlot] ?? defaultMeshMaterial;
    const draw = Object.freeze({
      kind: mesh.indexed ? ('indexed' as const) : ('non-indexed' as const),
      first: mesh.indexed ? submesh.indexOffset : vertexStart,
      count: mesh.indexed ? submesh.indexCount : submesh.vertexCount,
      baseVertex: 0,
      topology: submesh.topology,
    });
    vertexStart += submesh.vertexCount;
    return Object.freeze({
      ...draw,
      drawItemIndex,
      materialSlot: submesh.materialSlot,
      pipelineClass: `${identity}|${deformation}`,
      materialResourceClass: String(getOpaqueResourceIdentity(material)),
      geometry: captureBatchGeometry({
        receipt: { identity, vertexInputs, topology: submesh.topology, indexed: mesh.indexed },
        layout: mesh.layout,
        draw,
        deformation,
      }),
    });
  });
  const result = Object.freeze(draws);
  versions.set(deformation, result);
  return result;
}

const meshExecutions = new WeakMap<
  MeshBatchSource,
  WeakMap<MeshGeometry, readonly EligibleGpuDrivenDraw[]>
>();
/** Expand shared Mesh facts, without reading or copying source members. */
function meshDraws(source: MeshBatchSource, mesh: MeshGeometry): readonly EligibleGpuDrivenDraw[] {
  let versions = meshExecutions.get(source);
  if (versions === undefined) {
    versions = new WeakMap();
    meshExecutions.set(source, versions);
  }
  const cached = versions.get(mesh);
  if (cached !== undefined) return cached;
  const template = source.draws[0];
  if (template === undefined) return [];
  const materials = effectiveMeshMaterials(
    source,
    mesh,
    template.binding.geometry.deformation === 'skin' ? 'skinned' : 'mesh',
  );
  // Morphed members deform LOD0 vertices; their batch carries no LOD chain.
  const morph = template.binding.morph;
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
        worldId: mesh.worldId,
        assetHandle: mesh.handle,
        ...(lods === undefined ? {} : { lods }),
        material: materials.materials[draw.materialSlot] ?? materials.material,
        geometry: draw.geometry,
        drawItemIndex,
        ...(morph === undefined ? {} : { morph }),
      }),
      key: Object.freeze({
        drawItemIndex,
        worldId: mesh.worldId,
        assetHandle: mesh.handle,
        drawKind: draw.kind,
        first: draw.first,
        count: draw.count,
        baseVertex: draw.baseVertex,
        materialSlot: draw.materialSlot,
        topology: draw.topology,
        ...(template.key.reflected ? { reflected: true } : {}),
        ...(morph === undefined ? {} : { morph }),
        pipelineClass: draw.pipelineClass,
        materialResourceClass: draw.materialResourceClass,
      }),
      ...(lod === undefined ? {} : { lod }),
    });
  });
  const result = Object.freeze(draws);
  versions.set(mesh, result);
  return result;
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

/** Stable physical command windows for the last actual task query, never source maintenance. */
export class MeshBatchProjection {
  private readonly groups = new Map<number, ExecutionGroup>();
  private readonly visibleRanges = new StableRangeAllocator();
  private readonly indirectRanges = new StableRangeAllocator();
  private readonly generations: number[] = [];
  private readonly freeIds: number[] = [];
  private published = new TreeFrame<GpuDrivenBatch>();
  private sourceRoot: BatchSources | undefined;
  private plan: SubmissionPlan | undefined;
  // Lookup qualification only: neither this memo nor GC owns output windows.
  // It deliberately cannot retain an unrelated MeshFrame's payload closure.
  private queriedMeshes = new WeakSet<MeshFrame>();
  private queriedWithoutMeshes = false;
  /** Meshes of the last full or patched query; a mesh edit re-joins only its bindings. */
  private meshes: MeshFrame | undefined;
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
    this.sourceRoot = undefined;
    this.plan = undefined;
    this.queriedMeshes = new WeakSet();
    this.queriedWithoutMeshes = false;
    this.meshes = undefined;
    this.meshKnown = false;
    this.sourcesByMesh.clear();
    this.meshKeyBySource.clear();
    this.freeIds.length = 0;
    for (let id = this.generations.length - 1; id >= 0; id--) this.freeIds.push(id);
  }

  /** Enumerate tasks for a real executed view; source publication never calls this. */
  query(source: SubmissionPlan, meshes: MeshFrame | undefined): SubmissionPlan {
    // A raw caller supplies live facts, so capture its actual task roster on each
    // query. Only the producer-owned source domain may take an identity shortcut.
    let batches: BatchSources;
    if (BatchSources.isFixed(source.batches)) batches = source.batches;
    else {
      batches = new BatchSources();
      for (const batch of source.batches) batches = batches.with(batch);
    }
    if (
      this.plan !== undefined &&
      this.sourceRoot === batches &&
      (meshes === undefined ? this.queriedWithoutMeshes : this.queriedMeshes.has(meshes))
    )
      return this.plan;
    // Each join supplies an actual selector/raster task, including tasks whose
    // GPU cull produces zero visible instances. No resource-version polling or
    // group repair runs from Mesh adoption, publication, or a skipped view.
    // A retained baseline re-joins only edited sources and sources whose Mesh
    // changed; every other window and publication is unchanged by definition.
    const baseline = this.sourceRoot;
    const patch =
      baseline !== undefined &&
      this.meshKnown &&
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
          for (const member of this.sourcesByMesh
            .get(`${geometry.worldId}:${geometry.handle}`)
            ?.values() ?? [])
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
    this.meshes = meshes;
    this.meshKnown = true;
    const previous = this.plan;
    const plan =
      previous?.batches === this.published && previous.sourceGroups === batches
        ? previous
        : Object.freeze({
            revision: (previous?.revision ?? -1) + 1,
            batches: this.published,
            candidateCount: this.published.weight,
            visibleCapacity: this.visibleRanges.requiredCapacity() * 64,
            sourceGroups: batches,
          });
    this.sourceRoot = batches;
    this.queriedMeshes = new WeakSet();
    this.queriedWithoutMeshes = meshes === undefined;
    if (meshes !== undefined) this.queriedMeshes.add(meshes);
    this.plan = plan;
    return plan;
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
    const key = `${binding.worldId}:${binding.assetHandle}`;
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
    this.published = this.published.without(sourceId, window.ordinal);
  }

  private update(member: GpuDrivenBatch, meshes: MeshFrame | undefined): void {
    const binding = member.binding;
    if (binding === undefined) throw new Error('Mesh membership requires its source binding');
    this.index(member);
    const authored = binding.source;
    const mesh = meshes?.get(binding.worldId, binding.assetHandle);
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
    const live = new Set(draws.map((descriptor) => descriptor.sourceDrawIndex));
    if (live.size !== draws.length) throw new Error('Duplicate authored Mesh draw identity');
    const reordered = draws.some(
      (descriptor, ordinal) => group.windows.get(descriptor.sourceDrawIndex)?.ordinal !== ordinal,
    );
    if (reordered) {
      // Remove all previous keys before publishing the reordered local group.
      for (const window of group.windows.values()) {
        this.published = this.published.without(member.batchId, window.ordinal);
        window.published = undefined;
      }
    }
    for (const [draw, window] of group.windows) {
      if (live.has(draw)) continue;
      this.retire(member.batchId, window);
      group.windows.delete(draw);
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

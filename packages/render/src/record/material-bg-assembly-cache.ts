import type { CompiledRenderGraph } from '@forgeax/engine-render-graph';
import {
  type BindGroup,
  type BindGroupEntry,
  type BindGroupLayout,
  err,
  ok,
  type Result,
  RhiError,
} from '@forgeax/engine-rhi';
import type { GpuViewInputPreparation } from '../gpu-driven/view-input-bindings';
import type { GpuSceneTableBindingTarget } from '../gpu-scene';
import { materialResource } from '../material-resource';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { MaterialFrame } from '../scene/material-dispatch';
import type { BindGroupCounts, MaterialBgAssemblyCacheEntry } from './frame-snapshot';
import {
  type GraphBindingViews,
  graphBindingViewsCurrent,
  sameGraphBindingViews,
} from './graph-binding-views';
import type { RenderSystemRuntime } from './render-context';

interface PhysicalGroups {
  parent?: PhysicalGroups;
  key?: object;
  children?: Map<object, PhysicalGroups>;
  issued?: { ranges: BindingRanges; group: BindGroup };
  used?: boolean;
}

function physicalChild(parent: PhysicalGroups, key: object): PhysicalGroups {
  parent.children ??= new Map();
  let child = parent.children.get(key);
  if (child === undefined) {
    child = { parent, key };
    parent.children.set(key, child);
  }
  return child;
}

type BindingRanges = (number | BindGroupEntry['resource']['kind'] | undefined)[];

// Layout and GPU objects already identify the path. Detach the scalar shape
// once at issue so later edits to caller-owned byte ranges stay observable.
function captureBindingRanges(entries: readonly BindGroupEntry[]): BindingRanges {
  const shape: BindingRanges = [];
  for (const { binding, resource } of entries) {
    shape.push(binding, resource.kind);
    if (resource.kind === 'buffer') shape.push(resource.value.offset ?? 0, resource.value.size);
  }
  return shape;
}

function sameBindingRanges(shape: BindingRanges, entries: readonly BindGroupEntry[]): boolean {
  let index = 0;
  for (const { binding, resource } of entries) {
    if (shape[index++] !== binding || shape[index++] !== resource.kind) return false;
    if (
      resource.kind === 'buffer' &&
      (shape[index++] !== (resource.value.offset ?? 0) || shape[index++] !== resource.value.size)
    )
      return false;
  }
  return index === shape.length;
}

type VariantEntries = Map<GraphBindingViews | undefined, MaterialBgAssemblyCacheEntry>;
type LayoutEntries = Map<number, VariantEntries>;
type ProbeEntries = Map<number | undefined, LayoutEntries>;
type ShaderEntries = Map<string, ProbeEntries>;
type DiscardBinding = (
  entry: MaterialBgAssemblyCacheEntry,
  variants: VariantEntries,
  key: GraphBindingViews | undefined,
) => boolean;

export interface MaterialTableBindingPreparation extends GpuViewInputPreparation {
  replacement(group: BindGroup): BindGroup | undefined;
}
function stale(): RhiError {
  return new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'current actual material binding assemblies and exact Scene table target',
    hint: 'release the private replacement and retry after source or material changes settle',
  });
}

/** The existing material binding owner, indexed by its scalar identities. */
export class MaterialBgAssemblyCache {
  /** Synchronous return storage. Callers consume both numbers before the next native call. */
  readonly uniformOffsets = { absolute: 0, local: 0 };
  private physical: PhysicalGroups = {};
  private readonly recordingLeaves = new Set<PhysicalGroups>();
  private groups = new WeakMap<BindGroup, PhysicalGroups>();

  /** An installed material also submits its existing physical group. */
  use(group: BindGroup): void {
    const leaf = this.groups.get(group);
    if (leaf !== undefined) leaf.used = true;
  }

  /** Keep the completed recording's groups available to the next recording.
   * Prune unused paths even when every texture, buffer and layout remains live. */
  finishRecording(): void {
    for (const leaf of this.recordingLeaves) {
      if (leaf.used) {
        leaf.used = false;
        continue;
      }
      this.recordingLeaves.delete(leaf);
      if (leaf.issued !== undefined) this.groups.delete(leaf.issued.group);
      delete leaf.issued;
      let node = leaf;
      while (
        node.parent !== undefined &&
        node.key !== undefined &&
        node.issued === undefined &&
        (node.children?.size ?? 0) === 0
      ) {
        node.parent.children?.delete(node.key);
        node = node.parent;
      }
    }
  }

  /** Layout and resource lifetimes bound native groups. One range is current at each leaf. */
  issue(
    runtime: RenderSystemRuntime,
    layout: BindGroupLayout,
    entries: readonly BindGroupEntry[],
    backdrop: boolean,
    counts: BindGroupCounts,
  ): BindGroup {
    let leaf: PhysicalGroups | undefined;
    if (!backdrop) {
      leaf = physicalChild(this.physical, layout);
      for (const entry of entries) {
        const resource = entry.resource;
        leaf = physicalChild(
          leaf,
          resource.kind === 'buffer' ? resource.value.buffer : resource.value,
        );
      }
      leaf.used = true;
      this.recordingLeaves.add(leaf);
      if (leaf.issued !== undefined && sameBindingRanges(leaf.issued.ranges, entries))
        return leaf.issued.group;
    }
    const ranges = leaf === undefined ? undefined : captureBindingRanges(entries);
    const created = runtime.device.createBindGroup({
      label: 'pbr-material-skylight-bg',
      layout,
      entries,
    });
    if (!created.ok) throw created.error;
    if (leaf !== undefined && ranges !== undefined && this.recordingLeaves.has(leaf)) {
      if (leaf.issued !== undefined) this.groups.delete(leaf.issued.group);
      leaf.issued = { ranges, group: created.value };
      this.groups.set(created.value, leaf);
    }
    counts.createBindGroup++;
    counts.keys.push(
      `material-shared:${entries
        .map(({ binding, resource }) =>
          resource.kind === 'buffer'
            ? `${binding}:buffer:${resource.value.offset ?? 0}:${resource.value.size ?? 'rest'}`
            : `${binding}:${resource.kind}`,
        )
        .join(',')}`,
    );
    return created.value;
  }

  private preparation: MaterialTableBindingPreparation | undefined;
  private sourceIdentity: string | undefined;
  private readonly materials = new Map<number, ShaderEntries>();
  private frame?: MaterialFrame | undefined;

  /** Release rows at the same transition that retires a material or its pass roster. */
  adoptMaterials(frame: MaterialFrame): void {
    const prior = this.frame;
    if (prior === frame) return;
    this.frame = frame;
    if (prior === undefined || this.materials.size === 0) return;
    frame.changesSince(prior, (before, after) => {
      const handle = before?.snapshot.materialHandle;
      if (
        before === undefined ||
        handle === undefined ||
        (after !== undefined &&
          after.snapshot.materialHandle === handle &&
          after.snapshot.materialShaderId === before.snapshot.materialShaderId &&
          before.passes === after.passes)
      )
        return;
      const shaders = this.materials.get(handle);
      if (shaders !== undefined)
        if (
          this.pruneMaterial(
            handle,
            shaders,
            (entry) =>
              entry.material === before.snapshot ||
              materialResource(entry.material) === before.resource,
          )
        )
          this.preparation?.release();
    });
  }

  get(
    sourceIdentity: string | undefined,
    materialHandle: number | undefined,
    shaderId: string | undefined,
    probeIndex?: number,
    graphViews?: GraphBindingViews,
    standardMaterialLayoutIndex = 0,
  ): MaterialBgAssemblyCacheEntry | undefined {
    if (
      sourceIdentity === undefined ||
      this.sourceIdentity !== sourceIdentity ||
      materialHandle === undefined
    )
      return undefined;
    const variants = this.materials
      .get(materialHandle)
      ?.get(shaderId ?? '')
      ?.get(probeIndex)
      ?.get(standardMaterialLayoutIndex);
    if (graphViews === undefined) return variants?.get(undefined);
    if (variants !== undefined)
      for (const entry of variants.values())
        if (sameGraphBindingViews(entry.graphViews, graphViews)) return entry;
    return undefined;
  }

  set(
    sourceIdentity: string,
    materialHandle: number,
    shaderId: string | undefined,
    probeIndex: number | undefined,
    entry: MaterialBgAssemblyCacheEntry,
    standardMaterialLayoutIndex = 0,
  ): MaterialBgAssemblyCacheEntry {
    if (entry.graphViews !== undefined && !graphBindingViewsCurrent(entry.graphViews))
      throw stale();
    // Only a static binding can enter a prepared recording.
    if (entry.canvas === undefined) this.preparation?.release();
    if (this.sourceIdentity !== sourceIdentity) {
      this.preparation?.release();
      this.materials.clear();
      this.sourceIdentity = sourceIdentity;
    }
    const materials = this.materials;
    let shaders = materials.get(materialHandle);
    if (shaders === undefined) {
      shaders = new Map();
      materials.set(materialHandle, shaders);
    }
    const shader = shaderId ?? '';
    let probes = shaders.get(shader);
    if (probes === undefined) {
      probes = new Map();
      shaders.set(shader, probes);
    }
    let layouts = probes.get(probeIndex);
    if (layouts === undefined) {
      layouts = new Map();
      probes.set(probeIndex, layouts);
    }
    let variants = layouts.get(standardMaterialLayoutIndex);
    if (variants === undefined) {
      variants = new Map();
      layouts.set(standardMaterialLayoutIndex, variants);
    }
    if (entry.graphViews === undefined) {
      if (
        this.preparation &&
        variants.get(undefined)?.canvas === undefined &&
        variants.has(undefined)
      )
        this.preparation.release();
      variants.set(undefined, entry);
      return entry;
    }
    for (const key of variants.keys())
      if (sameGraphBindingViews(key, entry.graphViews)) {
        if (this.preparation && variants.get(key)?.canvas === undefined) this.preparation.release();
        variants.set(key, entry);
        return entry;
      }
    variants.set(entry.graphViews, entry);
    return entry;
  }

  *values(): IterableIterator<MaterialBgAssemblyCacheEntry> {
    for (const shaders of this.materials.values())
      for (const probes of shaders.values())
        for (const layouts of probes.values())
          for (const variants of layouts.values()) yield* variants.values();
  }

  /** An installed logical binding owns its readiness even when draws share a physical group. */
  captureBindingCurrent(
    source: string | undefined,
    material: number | undefined,
    shader: string | undefined,
    probe: number | undefined,
    layout: number | undefined,
    entry: MaterialBgAssemblyCacheEntry | undefined,
  ): (() => boolean) | undefined {
    if (entry === undefined || entry.canvas !== undefined) return undefined;
    const installed = () =>
      this.get(source, material, shader, probe, entry.graphViews, layout) === entry;
    return () => installed() && entry.bindingsCurrent() && installed();
  }

  /** Prepare only existing fully resident assemblies; publication remains a pure cache update. */
  prepareTableBindings(
    runtime: RenderSystemRuntime,
    target: GpuSceneTableBindingTarget,
    current: () => boolean,
  ): Result<MaterialTableBindingPreparation, RhiError> {
    if (this.preparation !== undefined) return err(stale());
    let scope:
      | {
          owner: MaterialBgAssemblyCache;
          runtime: RenderSystemRuntime;
          target: GpuSceneTableBindingTarget;
          current: () => boolean;
        }
      | undefined = { owner: this, runtime, target, current };
    const identity = this.sourceIdentity;
    const rows: {
      leaf: VariantEntries;
      key: GraphBindingViews | undefined;
      entry: MaterialBgAssemblyCacheEntry;
      next?: MaterialBgAssemblyCacheEntry;
    }[] = [];
    const replacements = new Map<BindGroup, BindGroup>();
    let observing = false;
    let ready = false;
    const targetCurrent = () => {
      const source = scope;
      if (
        source === undefined ||
        source.owner.preparation !== api ||
        source.owner.sourceIdentity !== identity ||
        !source.current() ||
        scope !== source ||
        !source.target.owner.capacityTargetMatches(source.target)
      )
        return false;
      return true;
    };
    const rowCurrent = (row: (typeof rows)[number]) =>
      row.leaf.get(row.key) === row.entry &&
      row.entry.bindingsCurrent() &&
      row.leaf.get(row.key) === row.entry;
    const live = () => {
      if (!targetCurrent()) return false;
      for (const row of rows) if (!rowCurrent(row)) return false;
      return scope !== undefined;
    };
    const release = () => {
      if (scope?.owner.preparation === api) scope.owner.preparation = undefined;
      scope = undefined;
      rows.length = 0;
      replacements.clear();
      ready = false;
    };
    const api: MaterialTableBindingPreparation = Object.freeze({
      isCurrent: () => {
        if (observing) return false;
        observing = true;
        try {
          return ready && live();
        } finally {
          observing = false;
        }
      },
      replacement: (group: BindGroup) =>
        ready && scope !== undefined ? replacements.get(group) : undefined,
      publish: () => {
        if (observing) return err(stale());
        observing = true;
        try {
          if (!ready || !live() || scope === undefined) return err(stale());
          for (const row of rows) {
            if (row.next === undefined) return err(stale());
            row.leaf.set(row.key, row.next);
          }
          release();
          return ok(undefined);
        } finally {
          observing = false;
        }
      },
      release,
    });
    this.preparation = api;
    let accepted = false;
    try {
      this.removeEntries((entry, leaf, key) => {
        if (entry.sceneMaterialBuffer !== target.owner.materialBuffer) return false;
        // An expired asset's old binding cannot contribute to a Scene table successor.
        if (!entry.bindingsCurrent()) return true;
        rows.push({ leaf, key, entry });
        return false;
      });
      if (!live()) return err(stale());
      for (const row of rows) {
        if (!targetCurrent() || scope === undefined || !rowCurrent(row)) return err(stale());
        const source: NonNullable<typeof scope> = scope;
        const descriptor = replaceMaterialTable(row.entry, source.target);
        let group = replacements.get(row.entry.bindGroup);
        if (group === undefined) {
          const created = source.runtime.device.createBindGroup(descriptor);
          if (!created.ok) return created;
          if (scope !== source || !targetCurrent()) return err(stale());
          group = created.value;
          replacements.set(row.entry.bindGroup, group);
        }
        row.next = {
          ...row.entry,
          descriptor,
          iblMaterial: undefined,
          bindGroup: group,
          sceneMaterialBuffer: source.target.materialBuffer,
        };
      }
      // Device callbacks may retire a different row. Check the complete set once before exposure.
      if (!live()) return err(stale());
      ready = true;
      accepted = true;
      return ok(api);
    } finally {
      if (!accepted) release();
    }
  }

  /** Forget graph-specific native views at the same owner event as graph retirement. */
  retireGraph(graph: CompiledRenderGraph<RenderPipelineFrame>): void {
    this.preparation?.release();
    this.removeEntries((entry) => entry.graphViews?.graph === graph);
  }

  /** Retire a changed physical source even when its successor uses a fallback or fails. */
  releaseBinding(handle: number, issued: MaterialBgAssemblyCacheEntry): void {
    const shaders = this.materials.get(handle);
    if (shaders !== undefined && this.pruneMaterial(handle, shaders, (entry) => entry === issued))
      this.preparation?.release();
  }

  private removeEntries(discard: DiscardBinding): void {
    for (const [material, shaders] of this.materials)
      this.pruneMaterial(material, shaders, discard);
  }

  private pruneMaterial(
    material: number,
    shaders: ShaderEntries,
    discard: DiscardBinding,
  ): boolean {
    let removedStatic = false;
    for (const [shader, probes] of shaders) {
      for (const [probe, layouts] of probes) {
        for (const [kind, variants] of layouts) {
          for (const [key, entry] of variants)
            if (discard(entry, variants, key) && variants.get(key) === entry) {
              variants.delete(key);
              if (entry.canvas === undefined) removedStatic = true;
            }
          if (variants.size === 0) layouts.delete(kind);
        }
        if (layouts.size === 0) probes.delete(probe);
      }
      if (probes.size === 0) shaders.delete(shader);
    }
    if (shaders.size === 0 && this.materials.get(material) === shaders)
      this.materials.delete(material);
    return removedStatic;
  }

  clear(): void {
    this.preparation?.release();
    this.materials.clear();
    this.frame = undefined;
    this.physical = {};
    this.recordingLeaves.clear();
    this.groups = new WeakMap();
    this.sourceIdentity = undefined;
  }
}

function replaceMaterialTable(
  entry: MaterialBgAssemblyCacheEntry,
  target: GpuSceneTableBindingTarget,
) {
  return {
    ...entry.descriptor,
    entries: [...entry.descriptor.entries].map((binding) =>
      binding.resource.kind === 'buffer' &&
      binding.resource.value.buffer === entry.sceneMaterialBuffer
        ? {
            ...binding,
            resource: {
              kind: 'buffer' as const,
              value: { ...binding.resource.value, buffer: target.materialBuffer },
            },
          }
        : binding,
    ),
  };
}

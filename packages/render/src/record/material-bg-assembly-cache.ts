import type { CompiledRenderGraph } from '@forgeax/engine-render-graph';
import { type BindGroup, err, ok, type Result, RhiError } from '@forgeax/engine-rhi';
import type { GpuViewInputPreparation } from '../gpu-driven/view-input-bindings';
import type { GpuSceneTableBindingTarget } from '../gpu-scene';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { MaterialBgAssemblyCacheEntry } from './frame-snapshot';
import {
  type GraphBindingViews,
  graphBindingViewsCurrent,
  sameGraphBindingViews,
} from './graph-binding-views';
import type { RenderSystemRuntime } from './render-context';

type VariantEntries = Map<GraphBindingViews | undefined, MaterialBgAssemblyCacheEntry>;
type ProbeEntries = Map<number | undefined, VariantEntries>;
type ShaderEntries = Map<string, ProbeEntries>;

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
  private preparation: MaterialTableBindingPreparation | undefined;
  private sourceIdentity: string | undefined;
  private readonly materials = new Map<number, ShaderEntries>();

  get(
    sourceIdentity: string | undefined,
    materialHandle: number | undefined,
    shaderId: string | undefined,
    probeIndex?: number,
    graphViews?: GraphBindingViews,
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
      ?.get(probeIndex);
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
  ): void {
    if (entry.graphViews !== undefined && !graphBindingViewsCurrent(entry.graphViews))
      throw stale();
    // A newly issued variant changes the preparation roster, including during native callbacks.
    this.preparation?.release();
    if (this.sourceIdentity !== sourceIdentity) {
      this.clear();
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
    let variants = probes.get(probeIndex);
    if (variants === undefined) {
      variants = new Map();
      probes.set(probeIndex, variants);
    }
    for (const key of variants.keys())
      if (sameGraphBindingViews(key, entry.graphViews)) {
        variants.set(key, entry);
        return;
      }
    variants.set(entry.graphViews, entry);
  }

  *values(): IterableIterator<MaterialBgAssemblyCacheEntry> {
    for (const shaders of this.materials.values())
      for (const probes of shaders.values())
        for (const variants of probes.values()) yield* variants.values();
  }

  /** Capture the actual issued leaf once; later currency checks do not scan or allocate. */
  captureBindingCurrent(group: BindGroup): (() => boolean) | undefined {
    const source = this.sourceIdentity;
    for (const [material, shaders] of this.materials)
      for (const [shader, probes] of shaders)
        for (const [probe, variants] of probes)
          for (const [key, entry] of variants) {
            if (entry.bindGroup !== group) continue;
            return () =>
              this.sourceIdentity === source &&
              this.materials.get(material)?.get(shader)?.get(probe) === variants &&
              variants.get(key) === entry &&
              entry.bindingsCurrent();
          }
    return undefined;
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
    const live = () => {
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
      for (const row of rows)
        if (row.leaf.get(row.key) !== row.entry || !row.entry.bindingsCurrent()) return false;
      return scope === source;
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
        if (!live() || scope === undefined) return err(stale());
        const source: NonNullable<typeof scope> = scope;
        const descriptor = replaceMaterialTable(row.entry, source.target);
        let group = replacements.get(row.entry.bindGroup);
        if (group === undefined) {
          const created = source.runtime.device.createBindGroup(descriptor);
          if (!created.ok) return created;
          if (scope !== source || !live()) return err(stale());
          group = created.value;
          replacements.set(row.entry.bindGroup, group);
        }
        row.next = {
          ...row.entry,
          descriptor,
          bindGroup: group,
          sceneMaterialBuffer: source.target.materialBuffer,
        };
      }
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

  private removeEntries(
    discard: (
      entry: MaterialBgAssemblyCacheEntry,
      variants: VariantEntries,
      key: GraphBindingViews | undefined,
    ) => boolean,
  ): void {
    for (const [material, shaders] of this.materials) {
      for (const [shader, probes] of shaders) {
        for (const [probe, variants] of probes) {
          for (const [key, entry] of variants)
            if (discard(entry, variants, key)) variants.delete(key);
          if (variants.size === 0) probes.delete(probe);
        }
        if (probes.size === 0) shaders.delete(shader);
      }
      if (shaders.size === 0) this.materials.delete(material);
    }
  }

  clear(): void {
    this.preparation?.release();
    this.materials.clear();
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

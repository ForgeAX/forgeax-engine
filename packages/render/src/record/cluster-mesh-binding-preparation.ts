import type { CompiledRenderGraph } from '@forgeax/engine-render-graph';
import {
  type BindGroup,
  type BindGroupDescriptor,
  err,
  ok,
  type Result,
  RhiError,
} from '@forgeax/engine-rhi';
import type { GpuViewInputPreparation } from '../gpu-driven/view-input-bindings';
import type { GpuSceneTableBindingTarget } from '../gpu-scene';
import { type HdrpBuffers, hdrpBuffersCurrent } from '../hdrp-buffers';
import type { RenderPipelineFrame } from '../render-pipeline';
import {
  type GraphBindingViews,
  graphBindingViewsCurrent,
  sameGraphBindingViews,
} from './graph-binding-views';
import { bindGroupByteRangeLeaf4, bindGroupSkinRangeLeaf6 } from './mesh-ssbo';
import type { RenderSystemRuntime } from './render-context';
import type { SkinTaskBinding } from './skin-tasks';

const ISSUED = Symbol('cluster-mesh-binding');
const COHORTS = Object.freeze({});
interface GraphObservation {
  readonly views: GraphBindingViews | undefined;
  readonly volatileViews: boolean;
}
type Cohorts = Map<CompiledRenderGraph<RenderPipelineFrame>, Map<BindGroup, GraphObservation>>;
interface ClusterMeshFacts {
  readonly issuer: typeof ISSUED;
  readonly runtime: RenderSystemRuntime;
  readonly hdrp: HdrpBuffers;
  readonly lightingKey: object;
  readonly descriptor: BindGroupDescriptor;
  readonly task?: SkinTaskBinding;
  readonly leaf: Map<number, BindGroup>;
  readonly key: number;
}

/** The exact original cache entry, not a recreated descriptor or a new native request. */
export function clusterMeshBindingCurrent(
  cache: WeakMap<object, unknown>,
  group: BindGroup,
): boolean {
  const facts = cache.get(group) as ClusterMeshFacts | undefined;
  return (
    facts?.issuer === ISSUED &&
    facts.leaf.get(facts.key) === group &&
    hdrpBuffersCurrent(facts.runtime, facts.hdrp)
  );
}

/** Provenance lives in the existing View mesh cache, under its actual issued group. */
export function rememberClusterMeshBinding(
  cache: WeakMap<object, unknown>,
  group: BindGroup,
  facts: Omit<ClusterMeshFacts, 'issuer'>,
): void {
  cache.set(group, {
    ...facts,
    issuer: ISSUED,
    descriptor: { ...facts.descriptor, entries: [...facts.descriptor.entries] },
    ...(facts.task === undefined ? {} : { task: { ...facts.task } }),
  });
}

/** Index only actual current graph consumers, including imperative draws without bundles. */
export function observeClusterMeshBinding(
  cache: WeakMap<object, unknown>,
  group: BindGroup,
  graph: CompiledRenderGraph<RenderPipelineFrame> | undefined,
  graphViews: GraphBindingViews | undefined,
  volatileViews: boolean,
): Result<void, RhiError> {
  const facts = cache.get(group) as ClusterMeshFacts | undefined;
  if (facts?.issuer !== ISSUED || graph === undefined) return ok(undefined);
  if (
    graph.isRetired() ||
    (graphViews !== undefined &&
      (graphViews.graph !== graph || !graphBindingViewsCurrent(graphViews)))
  )
    return err(stale());
  let cohorts = cache.get(COHORTS) as Cohorts | undefined;
  if (cohorts === undefined) {
    cohorts = new Map();
    cache.set(COHORTS, cohorts);
  }
  let groups = cohorts.get(graph);
  if (groups === undefined) {
    groups = new Map();
    cohorts.set(graph, groups);
  }
  const before = groups.get(group);
  if (
    before === undefined ||
    before.volatileViews !== volatileViews ||
    !sameGraphBindingViews(before.views, graphViews)
  )
    groups.set(group, { views: graphViews, volatileViews });
  return ok(undefined);
}

export function retireClusterMeshBindings(
  cache: WeakMap<object, unknown>,
  graph: CompiledRenderGraph<RenderPipelineFrame>,
): void {
  (cache.get(COHORTS) as Cohorts | undefined)?.delete(graph);
}

export interface ClusterMeshBindingPreparation extends GpuViewInputPreparation {
  replacement(group: BindGroup): Result<BindGroup | undefined, RhiError>;
  prepareIssued(graph: CompiledRenderGraph<RenderPipelineFrame>): Result<void, RhiError>;
}

function stale(): RhiError {
  return new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'the actual current View clustered-lighting mesh binding issuer',
    hint: 'release this private cohort and retry after lighting, graph or Scene changes settle',
  });
}

/** Reuses exact issued descriptors; never cold-creates lighting or retains a frame callback. */
export function prepareClusterMeshBindings(
  runtime: RenderSystemRuntime,
  cache: WeakMap<object, unknown>,
  target: GpuSceneTableBindingTarget,
  current: () => boolean,
): ClusterMeshBindingPreparation {
  let scope:
    | {
        runtime: RenderSystemRuntime;
        cache: WeakMap<object, unknown>;
        target: GpuSceneTableBindingTarget;
        current: () => boolean;
      }
    | undefined = { runtime, cache, target, current };
  const pending = new Map<
    BindGroup,
    {
      group: BindGroup;
      facts: ClusterMeshFacts;
      next: Map<number, BindGroup>;
      key: number;
      before: BindGroup | undefined;
      descriptor: BindGroupDescriptor;
    }
  >();
  const issued = new Map<
    CompiledRenderGraph<RenderPipelineFrame>,
    {
      groups: Map<BindGroup, GraphObservation> | undefined;
      members: readonly (readonly [BindGroup, GraphObservation])[];
    }
  >();
  let observing = false;
  const live = () => {
    const owner = scope;
    if (
      owner === undefined ||
      !owner.current() ||
      scope !== owner ||
      !owner.target.owner.capacityTargetMatches(owner.target)
    )
      return false;
    for (const [graph, cohort] of issued) {
      if (
        (owner.cache.get(COHORTS) as Cohorts | undefined)?.get(graph) !== cohort.groups ||
        (cohort.groups?.size ?? 0) !== cohort.members.length ||
        graph.isRetired() ||
        cohort.members.some(
          ([group, observation]) =>
            cohort.groups?.get(group) !== observation ||
            (observation.views !== undefined && !graphBindingViewsCurrent(observation.views)),
        )
      )
        return false;
    }
    for (const [group, item] of pending) {
      if (
        owner.cache.get(group) !== item.facts ||
        item.facts.runtime !== owner.runtime ||
        !hdrpBuffersCurrent(owner.runtime, item.facts.hdrp) ||
        item.facts.leaf.get(item.facts.key) !== group ||
        item.next.get(item.key) !== item.before
      )
        return false;
    }
    return scope === owner;
  };
  const release = () => {
    scope = undefined;
    pending.clear();
    issued.clear();
  };
  const api: ClusterMeshBindingPreparation = Object.freeze({
    prepareIssued: (graph: CompiledRenderGraph<RenderPipelineFrame>) => {
      if (scope === undefined || observing || !live()) return err(stale());
      const owner = scope;
      const groups = (owner.cache.get(COHORTS) as Cohorts | undefined)?.get(graph);
      issued.set(graph, { groups, members: groups === undefined ? [] : [...groups] });
      for (const [group, observation] of groups ?? []) {
        const facts = scope?.cache.get(group) as ClusterMeshFacts | undefined;
        const transform =
          facts === undefined
            ? undefined
            : [...facts.descriptor.entries].find((entry) => entry.binding === 0);
        if (
          transform?.resource.kind !== 'buffer' ||
          transform.resource.value.buffer !== owner.target.owner.transformBuffer
        )
          continue;
        if (observation.volatileViews) return err(stale());
        const result = api.replacement(group);
        if (!result.ok) return result;
      }
      return live() ? ok(undefined) : err(stale());
    },
    isCurrent: () => {
      if (observing) return false;
      observing = true;
      try {
        return live();
      } finally {
        observing = false;
      }
    },
    replacement: (group: BindGroup) => {
      if (observing) return err(stale());
      observing = true;
      try {
        if (!live() || scope === undefined) return err(stale());
        const cached = pending.get(group);
        if (cached !== undefined) return ok(cached.group);
        const owner = scope;
        const facts = owner.cache.get(group) as ClusterMeshFacts | undefined;
        if (facts?.issuer !== ISSUED) return ok(undefined);
        if (
          facts.runtime !== owner.runtime ||
          !hdrpBuffersCurrent(owner.runtime, facts.hdrp) ||
          facts.leaf.get(facts.key) !== group
        )
          return err(stale());
        const task = facts.task;
        const next =
          task === undefined
            ? bindGroupByteRangeLeaf4(
                owner.cache,
                owner.target.transformBuffer,
                facts.descriptor.layout,
                facts.hdrp,
                facts.lightingKey,
              )
            : bindGroupSkinRangeLeaf6(
                owner.cache,
                owner.target.transformBuffer,
                task.data,
                task.auxiliary,
                facts.descriptor.layout,
                facts.hdrp,
                facts.lightingKey,
                owner.target.transformBytes,
                task.dataSize,
              );
        const key = task === undefined ? owner.target.transformBytes : task.auxiliarySize;
        const before = next.get(key);
        const descriptor: BindGroupDescriptor = {
          ...facts.descriptor,
          entries: [...facts.descriptor.entries].map((entry) =>
            entry.binding === 0
              ? {
                  binding: 0,
                  resource: {
                    kind: 'buffer',
                    value: {
                      buffer: owner.target.transformBuffer,
                      offset: 0,
                      size: owner.target.transformBytes,
                    },
                  },
                }
              : entry,
          ),
        };
        const created =
          before === undefined ? owner.runtime.device.createBindGroup(descriptor) : ok(before);
        if (!created.ok) return created;
        // Native creation or the owner observation can close this cohort.
        // Never repopulate a released handle's retained facts.
        if (scope !== owner || !live()) return err(stale());
        pending.set(group, { group: created.value, facts, next, key, before, descriptor });
        return live() ? created : err(stale());
      } finally {
        observing = false;
      }
    },
    publish: () => {
      if (observing) return err(stale());
      observing = true;
      try {
        if (!live() || scope === undefined) return err(stale());
        for (const [old, item] of pending) {
          item.next.set(item.key, item.group);
          rememberClusterMeshBinding(scope.cache, item.group, {
            ...item.facts,
            descriptor: item.descriptor,
            leaf: item.next,
            key: item.key,
          });
          const cohorts = scope.cache.get(COHORTS) as Cohorts | undefined;
          for (const groups of cohorts?.values() ?? []) {
            const observation = groups.get(old);
            if (observation !== undefined) {
              groups.delete(old);
              groups.set(item.group, observation);
            }
          }
        }
        release();
        return ok(undefined);
      } finally {
        observing = false;
      }
    },
    release,
  });
  return api;
}

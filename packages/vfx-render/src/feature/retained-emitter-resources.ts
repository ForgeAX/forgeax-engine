import type { VfxGpuTickIntent } from '@forgeax/engine-vfx';
import { VFX_PARTICLE_CORE_STRIDE } from '@forgeax/engine-vfx';
import type { RenderFeatureResourceDeclaration } from '../../../render/src/features/plan';
import type {
  RenderFeatureNativeResourceAdmission,
  RenderFeatureNativeResourceDomain,
} from '../../../render/src/features/prepared-gpu-work';
import type { VfxComputeBatchProgram } from './batched-compute-program';
import type { createVfxInstanceArena, VfxArenaInstance, VfxArenaRange } from './instance-arena';

type Resource = RenderFeatureResourceDeclaration;
type Binding = Extract<Resource, { readonly kind: 'compute-bindings' }>;
type ArenaFrame = ReturnType<ReturnType<typeof createVfxInstanceArena>['beginRetainedFrame']>;
export interface RetainedEmitterResources {
  readonly token: RenderFeatureNativeResourceDomain;
  readonly batch?: VfxComputeBatchProgram;
  readonly emitter: VfxGpuTickIntent['emitter'];
  readonly tickCapacity: number;
  readonly ranges: readonly VfxArenaRange[];
  readonly byName: ReadonlyMap<string, VfxArenaRange>;
  readonly bindings: readonly Binding[];
  readonly views: Map<string, Map<number, RetainedProjectionResources>>;
}

interface RetainedProjectionResources {
  readonly batch?: VfxComputeBatchProgram;
  readonly program: string;
  readonly token: RenderFeatureNativeResourceDomain;
  readonly ranges: readonly VfxArenaRange[];
  /** Legacy uniform ABI only; batch projection reads its frame-private job table. */
  readonly runtime?: VfxArenaRange;
  readonly binding?: Binding;
  readonly byName: ReadonlyMap<string, VfxArenaRange>;
  readonly instanceBytes: number;
  readonly historyBytes: number;
  readonly indirectBytes: number;
}

/** The emitter's resource owner is also its prepared admission. Only current
 * runtime bytes pass through this object after the cold declaration boundary. */
export function retainEmitterResources(input: {
  readonly previous: RetainedEmitterResources | undefined;
  readonly batch?: VfxComputeBatchProgram;
  readonly emitter: VfxGpuTickIntent['emitter'];
  readonly instance: VfxArenaInstance;
  readonly program: string;
  readonly tickCapacity: number;
  readonly customStride: number;
  readonly sharedInstanceBytes: number;
  readonly indirectBytes: number;
  readonly arena: ArenaFrame;
  readonly admission: RenderFeatureNativeResourceAdmission;
}): RetainedEmitterResources | undefined {
  const previous = input.previous;
  if (
    previous?.emitter === input.emitter &&
    previous.batch === input.batch &&
    previous.tickCapacity === input.tickCapacity &&
    input.arena.retain(previous.ranges) &&
    input.admission.retain('frame', previous.token)
  )
    return previous;
  const maximum = Math.max(
    input.emitter.capacity * VFX_PARTICLE_CORE_STRIDE,
    input.emitter.capacity * input.customStride,
    input.sharedInstanceBytes,
    input.indirectBytes,
    (input.emitter.capacity * 2 + Math.ceil(input.emitter.capacity / 256)) * 4,
    24,
    ...input.emitter.renderers.map((renderer) =>
      renderer.enabled !== false && renderer.kind === 'trail'
        ? input.emitter.capacity * (Math.max(2, renderer.historyLength) + 1) * 16
        : 0,
    ),
  );
  if (!input.arena.supports(maximum, ['storage']) || !input.arena.supports(304, ['uniform']))
    return undefined;
  const { instance, emitter, program } = input;
  const prefix = instance.prefix;
  const resources: Resource[] = [];
  const ranges: VfxArenaRange[] = [];
  const byName = new Map<string, VfxArenaRange>();
  const physical = new Set<string>();
  const bindings: Binding[] = [];
  const buffer = (
    name: string,
    size: number,
    usage: Extract<Resource, { kind: 'buffer' }>['usage'],
    elementStride = 4,
  ) => {
    const range = input.arena.acquire(
      instance,
      name,
      size,
      usage,
      'frame',
      input.batch === undefined ? 4 : elementStride,
    );
    ranges.push(range);
    byName.set(name, range);
    if (!physical.has(range.name)) {
      physical.add(range.name);
      resources.push(input.arena.declaration(range));
    }
  };
  const bind = (name: string, runtime: string, scratch: string) => {
    const declared = new Set(
      (emitter.reflection.bindings[0]?.entries ?? [])
        .filter((entry) => entry.buffer !== undefined)
        .map((entry) => entry.binding),
    );
    const entries = [
      { binding: 0, resource: `${prefix}.particles` },
      { binding: 1, resource: runtime },
      { binding: 2, resource: `${prefix}.alive-indices` },
      { binding: 3, resource: `${prefix}.counters` },
      { binding: 4, resource: `${prefix}.indirect` },
      { binding: 5, resource: scratch },
      { binding: 6, resource: `${prefix}.shared-instances` },
      ...(input.customStride === 0 ? [] : [{ binding: 11, resource: `${prefix}.custom` }]),
    ].filter((entry) => declared.has(entry.binding));
    const source: Binding = { kind: 'compute-bindings', name, program, entries };
    bindings.push(source);
    if (input.batch === undefined)
      resources.push({
        ...source,
        entries: entries.map((entry) => {
          const range = byName.get(entry.resource);
          if (range === undefined)
            throw new Error(`Retained emitter buffer missing: ${entry.resource}`);
          return {
            binding: entry.binding,
            resource: range.name,
            offset: range.offset,
            size: range.size,
          };
        }),
      });
  };
  buffer(
    `${prefix}.particles`,
    emitter.capacity * VFX_PARTICLE_CORE_STRIDE,
    ['storage'],
    VFX_PARTICLE_CORE_STRIDE,
  );
  if (input.customStride > 0)
    buffer(
      `${prefix}.custom`,
      emitter.capacity * input.customStride,
      ['storage'],
      input.customStride,
    );
  buffer(`${prefix}.alive-indices`, emitter.capacity * 4, ['storage', 'copy-src']);
  buffer(`${prefix}.counters`, 24, ['storage', 'copy-src'], 24);
  buffer(`${prefix}.indirect`, input.indirectBytes, ['storage', 'indirect', 'copy-src'], 20);
  buffer(`${prefix}.indirect-initial`, input.indirectBytes, ['copy-src']);
  buffer(`${prefix}.scratch`, (emitter.capacity * 2 + Math.ceil(emitter.capacity / 256)) * 4, [
    'storage',
  ]);
  buffer(`${prefix}.shared-instances`, input.sharedInstanceBytes, ['storage', 'vertex']);
  for (const [index, renderer] of emitter.renderers.entries())
    if (renderer.enabled !== false && renderer.kind === 'trail')
      buffer(
        `${prefix}.renderer-${index}.history`,
        emitter.capacity * (Math.max(2, renderer.historyLength) + 1) * 16,
        ['storage', 'copy-src'],
      );
  if (input.batch === undefined)
    for (let tick = 0; tick < input.tickCapacity; tick++) {
      const tickPrefix = `${prefix}.tick-${tick}`;
      buffer(`${tickPrefix}.runtime`, 304, ['uniform']);
      bind(`${tickPrefix}.simulation-bindings`, `${tickPrefix}.runtime`, `${prefix}.scratch`);
      for (const [index, renderer] of emitter.renderers.entries()) {
        if (
          renderer.enabled === false ||
          renderer.kind !== 'trail' ||
          !emitter.reflection.entryPoints.includes('forgeax_vfx_trail_history_main')
        )
          continue;
        const runtime = `${tickPrefix}.renderer-${index}.history-runtime`;
        buffer(runtime, 304, ['uniform']);
        bind(
          `${tickPrefix}.renderer-${index}.history-bindings`,
          runtime,
          `${prefix}.renderer-${index}.history`,
        );
      }
    }
  return {
    token: input.admission.admit('frame', resources),
    ...(input.batch === undefined ? {} : { batch: input.batch }),
    emitter,
    tickCapacity: input.tickCapacity,
    ranges,
    byName,
    bindings,
    views: new Map(),
  };
}

export function retainProjectionResources(input: {
  readonly batch?: VfxComputeBatchProgram;
  readonly frame: RetainedEmitterResources;
  readonly instance: VfxArenaInstance;
  readonly program: string;
  readonly view: string;
  readonly renderer: number;
  readonly instanceBytes: number;
  readonly historyBytes: number;
  readonly indirectBytes: number;
  readonly arena: ArenaFrame;
  readonly admission: RenderFeatureNativeResourceAdmission;
}): RetainedProjectionResources | undefined {
  const scope = { view: input.view };
  let view = input.frame.views.get(input.view);
  if (view === undefined) {
    view = new Map();
    input.frame.views.set(input.view, view);
  }
  const previous = view.get(input.renderer);
  if (
    previous !== undefined &&
    previous.batch === input.batch &&
    previous.program === input.program &&
    previous.instanceBytes === input.instanceBytes &&
    previous.historyBytes === input.historyBytes &&
    previous.indirectBytes === input.indirectBytes &&
    input.arena.retain(previous.ranges) &&
    input.admission.retain(scope, previous.token)
  )
    return previous;
  if (
    !input.arena.supports(
      Math.max(
        input.instanceBytes,
        input.historyBytes,
        input.indirectBytes,
        input.frame.emitter.capacity * 4,
        24,
      ),
      ['storage'],
    ) ||
    !input.arena.supports(304, ['uniform'])
  )
    return undefined;
  const prefix = input.instance.prefix;
  const rendererPrefix = `${prefix}.view.renderer-${input.renderer}`;
  const resources: Resource[] = [];
  const ranges: VfxArenaRange[] = [];
  const byName = new Map<string, VfxArenaRange>();
  const physical = new Set<string>();
  const buffer = (
    suffix: string,
    size: number,
    usage: Extract<Resource, { kind: 'buffer' }>['usage'],
    elementStride = 4,
  ) => {
    const name = `${rendererPrefix}.${suffix}`;
    const range = input.arena.acquire(
      input.instance,
      name,
      size,
      usage,
      `view:${input.view}`,
      input.batch === undefined ? 4 : elementStride,
    );
    ranges.push(range);
    byName.set(name, range);
    if (!physical.has(range.name)) {
      physical.add(range.name);
      resources.push(input.arena.declaration(range));
    }
    return range;
  };
  buffer('instances', input.instanceBytes, ['storage', 'vertex']);
  buffer('history', input.historyBytes, ['storage']);
  buffer('alive-indices', input.frame.emitter.capacity * 4, ['storage']);
  buffer('counters', 24, ['storage'], 24);
  buffer('indirect', input.indirectBytes, ['storage', 'indirect'], 20);
  // Job-table projection has no binding for an emitter-local runtime uniform.
  const runtime = input.batch === undefined ? buffer('runtime', 304, ['uniform']) : undefined;
  let binding: Binding | undefined;
  if (input.batch === undefined) {
    const reflected = new Set(
      (input.frame.emitter.reflection.bindings[0]?.entries ?? [])
        .filter((entry) => entry.buffer !== undefined)
        .map((entry) => entry.binding),
    );
    const entries = [
      { binding: 0, resource: `${prefix}.particles` },
      { binding: 1, resource: `${rendererPrefix}.runtime` },
      { binding: 2, resource: `${rendererPrefix}.alive-indices` },
      { binding: 3, resource: `${rendererPrefix}.counters` },
      { binding: 4, resource: `${rendererPrefix}.indirect` },
      { binding: 5, resource: `${rendererPrefix}.history` },
      { binding: 6, resource: `${rendererPrefix}.instances` },
      { binding: 11, resource: `${prefix}.custom` },
    ].filter((entry) => reflected.has(entry.binding));
    binding = {
      kind: 'compute-bindings',
      name: `${rendererPrefix}.compute-bindings`,
      program: input.program,
      entries,
    };
    if (input.batch === undefined)
      resources.push({
        ...binding,
        entries: entries.map((entry) => {
          const range = byName.get(entry.resource) ?? input.frame.byName.get(entry.resource);
          if (range === undefined)
            throw new Error(`Retained projection buffer missing: ${entry.resource}`);
          return {
            binding: entry.binding,
            resource: range.name,
            offset: range.offset,
            size: range.size,
          };
        }),
      });
  }
  const result = {
    token: input.admission.admit(scope, resources),
    ...(input.batch === undefined ? {} : { batch: input.batch }),
    program: input.program,
    ranges,
    ...(runtime === undefined ? {} : { runtime }),
    byName,
    ...(binding === undefined ? {} : { binding }),
    instanceBytes: input.instanceBytes,
    historyBytes: input.historyBytes,
    indirectBytes: input.indirectBytes,
  };
  view.set(input.renderer, result);
  return result;
}

export function uploadEmitterResource(
  admission: RenderFeatureNativeResourceAdmission,
  domain: RetainedEmitterResources,
  name: string,
  data: ArrayBufferView,
): void {
  const range = domain.byName.get(name);
  if (range === undefined || data.byteLength > range.size || data.byteLength % 4 !== 0)
    throw new RangeError(`Invalid retained emitter upload: ${name}`);
  admission.upload('frame', range.name, range.offset, data);
}

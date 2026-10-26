import {
  err,
  ok,
  type PipelineLibrary,
  type PipelineLibraryCompute,
  type PipelineLibraryInspection,
  type PipelineLibraryManifest,
  type PipelineLibraryPrepareOptions,
  type PipelineLibraryRender,
  type Result,
  RhiError,
} from '@forgeax/engine-rhi';
import { addLoadWork, beginLoadTimeline, sha256 } from '@forgeax/engine-types';

type Recipe = PipelineLibraryRender | PipelineLibraryCompute;
type NativePipeline = GPURenderPipeline | GPUComputePipeline;
interface Program {
  readonly recipe: Recipe;
  readonly kind: 'render' | 'compute';
  handle?: NativePipeline;
  ready: boolean;
  pending?: Promise<NativePipeline>;
  pendingSince?: number;
  startedAt?: number;
  origin?: 'runtime' | 'startup-warmup' | 'background-warmup';
  semanticIdentity?: string;
  /** Library membership on the existing recipe owner, independent of native readiness. */
  preload?: number;
}
const MAX_ENTRIES = 4096;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
/**
 * Native async compilation runs on the browser's GPU-process task pool. Four
 * outstanding requests left most cores idle (1,121 game recipes took ~32 s on a
 * 32-thread host); keep enough in flight to use half the logical processors.
 */
export function pipelineWarmupConcurrency(hardwareConcurrency: number | undefined): number {
  const cores = Number.isSafeInteger(hardwareConcurrency) ? (hardwareConcurrency as number) : 0;
  return Math.max(4, Math.min(16, Math.floor(cores / 2)));
}

/**
 * The background lane overlaps menu frames and Engine Worker CPU work;
 * native requests are capped independently of machine core count. Foreground
 * frames share the browser GPU process with this optional work.
 */
export function backgroundPipelineWarmupConcurrency(
  hardwareConcurrency: number | undefined,
): number {
  const cores = Number.isSafeInteger(hardwareConcurrency) ? (hardwareConcurrency as number) : 0;
  return Math.max(1, Math.min(4, Math.floor(cores / 8)));
}

const BACKGROUND_REQUEST_GAP_MS = 8;
const backgroundTurn = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, BACKGROUND_REQUEST_GAP_MS));

function warmupConcurrency(options: PipelineLibraryPrepareOptions): number {
  const cores = globalThis.navigator?.hardwareConcurrency;
  const background = options.background === true;
  const concurrency =
    options.concurrency ??
    (background ? backgroundPipelineWarmupConcurrency(cores) : pipelineWarmupConcurrency(cores));
  const limit = background ? 4 : 16;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > limit)
    throw new Error(`Pipeline warmup concurrency must be an integer in 1..${limit}`);
  return concurrency;
}

function entry<T>(rows: readonly T[], index: number): T {
  const value = rows[index];
  if (value === undefined) throw new Error('Missing pipeline library dependency');
  return value;
}

/** Snapshot WebIDL dictionaries/iterables; never stringify opaque GPU handles. */
function pod(value: unknown, depth = 0): unknown {
  if (depth > 24) throw new Error('Pipeline descriptor nesting exceeds 24');
  if (
    value === undefined ||
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  )
    return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object')
    throw new Error('Pipeline descriptor must contain finite POD values');
  if (Symbol.iterator in value)
    return Array.from(value as Iterable<unknown>, (v) => pod(v, depth + 1));
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error('Unknown native pipeline dependency');
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype')
      throw new Error('Invalid descriptor key');
    const child = pod((value as Record<string, unknown>)[key], depth + 1);
    if (child !== undefined) result[key] = child;
  }
  return result;
}
function identity(value: object): string {
  const { label: _label, ...semantic } = value as Record<string, unknown>;
  return JSON.stringify(pod(semantic));
}
/** One native preparation request and its load progress item. */
type WarmRequest = {
  readonly label: string;
  readonly run: () => NativePipeline | Promise<NativePipeline>;
};
/**
 * Warm order follows manifest position across both tables (render 0, compute 0,
 * render 1, ...), so recipes a producer places first are compiled first in
 * either table; a long render table no longer delays the first compute recipe.
 */
function interleaveManifestOrder<T>(render: readonly T[], compute: readonly T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < Math.max(render.length, compute.length); i++) {
    if (i < render.length) out.push(render[i] as T);
    if (i < compute.length) out.push(compute[i] as T);
  }
  return out;
}
function failure(cause: unknown): RhiError {
  return cause instanceof RhiError
    ? cause
    : new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'a complete current WebGPU pipeline library',
        hint: cause instanceof Error ? cause.message : String(cause),
      });
}

let realmPipelineCreations = 0;

/**
 * Realm-lifetime count of native pipelines created (synchronous plus
 * asynchronous) across every WebGPU pipeline library. Engine-owned frame
 * diagnostics read it before and after a draw; it is not a stable public API.
 * @internal
 */
export function webGpuPipelineCreationCount(): number {
  return realmPipelineCreations;
}

/** All ordinary WebGPU RHI factories use this one physical-device owner. */
export class WebGpuPipelineLibrary implements PipelineLibrary {
  private closed = false;
  private shaderInfo = new WeakMap<GPUShaderModule, Promise<GPUCompilationInfo>>();
  private readonly shaderIds = new WeakMap<object, number>();
  private readonly shaderByCode = new Map<string, number>();
  private readonly shaders: {
    descriptor: GPUShaderModuleDescriptor;
    handle: GPUShaderModule;
    sourceDigest?: string;
  }[] = [];
  private readonly groupIds = new WeakMap<object, number>();
  private readonly groupKeys = new Map<string, number>();
  private readonly groups: {
    descriptor: GPUBindGroupLayoutDescriptor;
    handle: GPUBindGroupLayout;
  }[] = [];
  private readonly layoutIds = new WeakMap<object, number>();
  private readonly layoutKeys = new Map<string, number>();
  private readonly layouts: { groups: number[]; handle: GPUPipelineLayout }[] = [];
  private readonly programs = new Map<string, Program>();
  private readonly computeEntryModules = new Map<number, Map<string, number>>();
  private readonly counts = {
    shaderHits: 0,
    pipelineHits: 0,
    synchronousCreations: 0,
    asynchronousCreations: 0,
    compilationCompleted: 0,
    compilationPending: 0,
    failures: 0,
    unrecordable: 0,
    overflow: 0,
    sourceBytes: 0,
  };
  private readonly warmup = { requested: 0, completed: 0, failed: 0, elapsedMs: 0 };
  private readonly backgroundWarmup = {
    requested: 0,
    completed: 0,
    failed: 0,
    elapsedMs: 0,
    state: 'idle' as PipelineLibraryInspection['backgroundWarmup']['state'],
  };
  private backgroundRunning = 0;
  private backgroundFailed = false;
  private unidentifiedPending = 0;
  private indexingLibraries = 0;
  private preparingLibraries = 0;

  constructor(private readonly device: GPUDevice) {}

  private active(): void {
    if (this.closed) throw new Error('Pipeline library device is disposed');
  }
  createShaderModule(descriptor: GPUShaderModuleDescriptor): GPUShaderModule {
    this.active();
    const id = this.shaderByCode.get(descriptor.code);
    if (id !== undefined) {
      this.counts.shaderHits++;
      return entry(this.shaders, id).handle;
    }
    const endShader = beginLoadTimeline('shader', descriptor.label ?? 'shader');
    const handle = this.device.createShaderModule(descriptor);
    endShader(descriptor.code.length);
    const bytes = descriptor.code.length * 2;
    if (this.shaders.length >= MAX_ENTRIES || this.counts.sourceBytes + bytes > MAX_SOURCE_BYTES) {
      this.counts.overflow++;
      return handle;
    }
    this.shaderIds.set(handle, this.shaders.length);
    this.shaderByCode.set(descriptor.code, this.shaders.length);
    this.shaders.push({
      descriptor: {
        code: descriptor.code,
        ...(descriptor.label === undefined ? {} : { label: descriptor.label }),
      },
      handle,
    });
    this.counts.sourceBytes += bytes;
    return handle;
  }
  // forgeax-async-whitelist: dom-native - native shader diagnostic completion; adapter owns Result.
  getCompilationInfo(module: GPUShaderModule): Promise<GPUCompilationInfo> {
    this.active();
    const known = this.shaderInfo.get(module);
    if (known !== undefined) return known;
    // A repeated native getCompilationInfo can remain pending in Chromium/Dawn.
    // One source module owns both its handle and its completed diagnostics.
    const pending = Promise.resolve()
      .then(() => module.getCompilationInfo())
      .catch((cause) => {
        this.shaderInfo.delete(module);
        throw cause;
      });
    this.shaderInfo.set(module, pending);
    return pending;
  }
  createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor): GPUBindGroupLayout {
    this.active();
    const snapshot = pod({
      ...descriptor,
      entries: Array.from(descriptor.entries).sort((a, b) => a.binding - b.binding),
    }) as GPUBindGroupLayoutDescriptor;
    const key = identity(snapshot),
      known = this.groupKeys.get(key);
    if (known !== undefined) return entry(this.groups, known).handle;
    const handle = this.device.createBindGroupLayout(snapshot);
    if (this.groups.length >= MAX_ENTRIES) {
      this.counts.overflow++;
      return handle;
    }
    this.groupIds.set(handle, this.groups.length);
    this.groupKeys.set(key, this.groups.length);
    this.groups.push({ descriptor: snapshot, handle });
    return handle;
  }
  createPipelineLayout(descriptor: GPUPipelineLayoutDescriptor): GPUPipelineLayout {
    this.active();
    const nativeGroups = Array.from(descriptor.bindGroupLayouts);
    descriptor = { ...descriptor, bindGroupLayouts: nativeGroups };
    const groups = nativeGroups.map((group) =>
      group == null ? undefined : this.groupIds.get(group),
    );
    if (groups.some((id) => id === undefined)) {
      this.counts.unrecordable++;
      return this.device.createPipelineLayout(descriptor);
    }
    const key = JSON.stringify(groups),
      known = this.layoutKeys.get(key);
    if (known !== undefined) return entry(this.layouts, known).handle;
    const handle = this.device.createPipelineLayout(descriptor);
    if (this.layouts.length >= MAX_ENTRIES) {
      this.counts.overflow++;
      return handle;
    }
    this.layoutIds.set(handle, this.layouts.length);
    this.layoutKeys.set(key, this.layouts.length);
    this.layouts.push({ groups: groups as number[], handle });
    return handle;
  }
  private program(
    kind: 'render' | 'compute',
    descriptor: GPURenderPipelineDescriptor | GPUComputePipelineDescriptor,
  ): Program | undefined {
    this.active();
    const layout = descriptor.layout === 'auto' ? 'auto' : this.layoutIds.get(descriptor.layout);
    const stage = (input: GPUProgrammableStage) => {
      const module = this.shaderIds.get(input.module);
      if (module === undefined) throw new Error('Unknown shader module');
      return { ...input, module };
    };
    let recipe: Recipe;
    try {
      if (layout === undefined) throw new Error('Unknown pipeline layout');
      recipe = pod(
        'vertex' in descriptor
          ? {
              ...descriptor,
              layout,
              vertex: stage(descriptor.vertex),
              ...(descriptor.fragment === undefined
                ? {}
                : { fragment: stage(descriptor.fragment) }),
            }
          : { ...descriptor, layout, compute: stage(descriptor.compute) },
      ) as Recipe;
    } catch {
      this.counts.unrecordable++;
      return undefined;
    }
    const key = `${kind}:${identity(recipe)}`;
    let program = this.programs.get(key);
    if (program === undefined) {
      if (this.programs.size >= MAX_ENTRIES) {
        this.counts.overflow++;
        return undefined;
      }
      program = { kind, recipe, ready: false };
      this.programs.set(key, program);
    }
    return program;
  }
  createRenderPipeline(descriptor: GPURenderPipelineDescriptor): GPURenderPipeline {
    return this.createSync('render', descriptor) as GPURenderPipeline;
  }
  createComputePipeline(descriptor: GPUComputePipelineDescriptor): GPUComputePipeline {
    return this.createSync('compute', this.computeDescriptor(descriptor)) as GPUComputePipeline;
  }
  private computeDescriptor(
    descriptor: GPUComputePipelineDescriptor,
  ): GPUComputePipelineDescriptor {
    const id = this.shaderIds.get(descriptor.compute.module);
    const specialized =
      id === undefined || descriptor.compute.entryPoint === undefined
        ? undefined
        : this.computeEntryModules.get(id)?.get(descriptor.compute.entryPoint);
    return specialized === undefined
      ? descriptor
      : {
          ...descriptor,
          compute: { ...descriptor.compute, module: entry(this.shaders, specialized).handle },
        };
  }
  private createSync(
    kind: 'render' | 'compute',
    descriptor: GPURenderPipelineDescriptor | GPUComputePipelineDescriptor,
  ): NativePipeline {
    const program = this.program(kind, descriptor);
    if (program?.handle !== undefined) {
      this.counts.pipelineHits++;
      return program.handle;
    }
    const endPipeline = beginLoadTimeline('pipeline', descriptor.label ?? kind, {
      mode: 'sync',
      kind,
    });
    try {
      this.counts.synchronousCreations++;
      realmPipelineCreations++;
      const handle =
        kind === 'render'
          ? this.device.createRenderPipeline(descriptor as GPURenderPipelineDescriptor)
          : this.device.createComputePipeline(descriptor as GPUComputePipelineDescriptor);
      endPipeline();
      if (program !== undefined) program.handle = handle;
      // A synchronous handle is usable, but it is never compilation-completion evidence.
      return handle;
    } catch (cause) {
      endPipeline(undefined, { failed: true });
      this.counts.failures++;
      throw cause;
    }
  }
  // forgeax-async-whitelist: dom-native — exact native pipeline completion, adapter wraps failures in Result.
  createRenderPipelineAsync(
    descriptor: GPURenderPipelineDescriptor,
  ): GPURenderPipeline | Promise<GPURenderPipeline> {
    return this.createAsync('render', descriptor, true) as
      | GPURenderPipeline
      | Promise<GPURenderPipeline>;
  }
  // forgeax-async-whitelist: dom-native — exact native pipeline completion, adapter wraps failures in Result.
  createComputePipelineAsync(
    descriptor: GPUComputePipelineDescriptor,
  ): GPUComputePipeline | Promise<GPUComputePipeline> {
    return this.createAsync('compute', this.computeDescriptor(descriptor), true) as
      | GPUComputePipeline
      | Promise<GPUComputePipeline>;
  }
  // forgeax-async-whitelist: dom-native — exact native pipeline completion.
  private createAsync(
    kind: 'render' | 'compute',
    descriptor: GPURenderPipelineDescriptor | GPUComputePipelineDescriptor,
    /** Report this compilation as load work; preparation reports its whole batch upfront. */
    counted: boolean,
    origin: 'runtime' | 'startup-warmup' | 'background-warmup' = 'runtime',
  ): NativePipeline | Promise<NativePipeline> {
    const program = this.program(kind, descriptor);
    if (program?.ready && program.handle !== undefined) {
      this.counts.pipelineHits++;
      return program.handle;
    }
    if (program?.pending !== undefined) {
      this.counts.pipelineHits++;
      return program.pending;
    }
    if (counted) addLoadWork('pipelines', { total: 1 });
    if (program === undefined) this.unidentifiedPending++;
    else {
      program.pendingSince = performance.now();
      program.origin = origin;
    }
    const create = async () => {
      let started = false;
      let endPipeline: ReturnType<typeof beginLoadTimeline> | undefined;
      try {
        this.active();
        if (program !== undefined) program.startedAt = performance.now();
        this.counts.asynchronousCreations++;
        realmPipelineCreations++;
        this.counts.compilationPending++;
        started = true;
        endPipeline = beginLoadTimeline('pipeline', descriptor.label ?? kind, {
          mode: 'async',
          kind,
        });
        const handle =
          kind === 'render'
            ? await this.device.createRenderPipelineAsync(descriptor as GPURenderPipelineDescriptor)
            : await this.device.createComputePipelineAsync(
                descriptor as GPUComputePipelineDescriptor,
              );
        endPipeline();
        this.active();
        if (program !== undefined) {
          program.handle = handle;
          program.ready = true;
        }
        this.counts.compilationCompleted++;
        return handle;
      } catch (cause) {
        endPipeline?.(undefined, { failed: true });
        if (program !== undefined) {
          delete program.handle;
          program.ready = false;
        }
        this.counts.failures++;
        throw cause;
      } finally {
        if (started) this.counts.compilationPending--;
        if (program === undefined) this.unidentifiedPending--;
        else {
          delete program.pending;
          delete program.pendingSince;
          delete program.startedAt;
          delete program.origin;
        }
        if (counted) addLoadWork('pipelines', { done: 1, item: descriptor.label ?? kind });
      }
    };
    const pending = Promise.resolve().then(create);
    if (program !== undefined) program.pending = pending;
    return pending;
  }
  inspect(): PipelineLibraryInspection {
    return {
      state: this.closed ? 'disposed' : 'active',
      shaders: this.shaders.length,
      renderPipelines: [...this.programs.values()].filter((p) => p.kind === 'render').length,
      computePipelines: [...this.programs.values()].filter((p) => p.kind === 'compute').length,
      ...this.counts,
      pending: {
        unidentified: this.unidentifiedPending,
        pipelines: [...this.programs.values()]
          .filter((program) => program.pending !== undefined)
          .map((program) => this.inspectCompilation(program)),
      },
      warmup: { ...this.warmup },
      backgroundWarmup: { ...this.backgroundWarmup },
    };
  }
  private inspectCompilation(
    program: Program,
  ): NonNullable<PipelineLibraryInspection['pending']>['pipelines'][number] {
    const recipe = program.recipe;
    const modules =
      'vertex' in recipe
        ? [recipe.vertex.module, ...(recipe.fragment === undefined ? [] : [recipe.fragment.module])]
        : [recipe.compute.module];
    const digest = (module: number): string => {
      const source = entry(this.shaders, module);
      source.sourceDigest ??= `sha256:${sha256(source.descriptor.code)}`;
      return source.sourceDigest;
    };
    const shaders = [...new Set(modules)].map((module) => ({
      module,
      label: entry(this.shaders, module).descriptor.label ?? null,
      sourceDigest: digest(module),
    }));
    const bindGroupLayouts =
      recipe.layout === 'auto'
        ? ('auto' as const)
        : entry(this.layouts, recipe.layout).groups.map((id) => entry(this.groups, id).descriptor);
    const stage = <T extends { module: number }>(value: T) => ({
      ...value,
      module: digest(value.module),
    });
    const layout =
      bindGroupLayouts === 'auto'
        ? 'auto'
        : bindGroupLayouts.map(({ label: _label, ...value }) => value);
    const semantic =
      'vertex' in recipe
        ? {
            ...recipe,
            layout,
            vertex: stage(recipe.vertex),
            ...(recipe.fragment === undefined ? {} : { fragment: stage(recipe.fragment) }),
          }
        : { ...recipe, layout, compute: stage(recipe.compute) };
    program.semanticIdentity ??= `sha256:${sha256(`${program.kind}:${identity(semantic)}`)}`;
    return {
      identity: program.semanticIdentity,
      kind: program.kind,
      origin: program.origin ?? 'runtime',
      preload:
        program.preload === 3
          ? 'both'
          : program.preload === 1
            ? 'startup'
            : program.preload === 2
              ? 'background'
              : this.indexingLibraries > 0
                ? 'indexing'
                : 'absent',
      stage: program.startedAt === undefined ? 'queued' : 'compiling',
      elapsedMs: Math.max(0, performance.now() - (program.pendingSince ?? performance.now())),
      recipe: pod(recipe) as Recipe,
      shaders,
      bindGroupLayouts: pod(bindGroupLayouts) as typeof bindGroupLayouts,
    };
  }
  export(): Result<PipelineLibraryManifest, RhiError> {
    try {
      this.active();
      if (this.counts.overflow || this.counts.unrecordable)
        throw new Error(
          'Incomplete pipeline library: inspect overflow and unrecordable counts before exporting',
        );
      if (
        this.preparingLibraries > 0 ||
        [...this.programs.values()].some((p) => p.pending !== undefined)
      )
        throw new Error('Pipeline compilation is pending; export after preparation settles');
      const used = [...this.programs.values()].filter((p) => p.handle !== undefined);
      const shaderIds = new Map<number, number>(),
        groupIds = new Map<number, number>(),
        layoutIds = new Map<number, number>();
      const intern = (ids: Map<number, number>, id: number) => {
        let known = ids.get(id);
        if (known === undefined) {
          known = ids.size;
          ids.set(id, known);
        }
        return known;
      };
      const stage = <T extends { module: number }>(s: T): T => ({
        ...s,
        module: intern(shaderIds, s.module),
      });
      const layout = (id: number | 'auto') => {
        if (id === 'auto') return id;
        for (const group of entry(this.layouts, id).groups) intern(groupIds, group);
        return intern(layoutIds, id);
      };
      const renderPipelines = used
        .filter((p) => p.kind === 'render')
        .map((p) => {
          const { fragment, ...d } = p.recipe as PipelineLibraryRender;
          return {
            ...d,
            layout: layout(d.layout),
            vertex: stage(d.vertex),
            ...(fragment === undefined ? {} : { fragment: stage(fragment) }),
          };
        });
      const computePipelines = used
        .filter((p) => p.kind === 'compute')
        .map((p) => {
          const d = p.recipe as PipelineLibraryCompute;
          return { ...d, layout: layout(d.layout), compute: stage(d.compute) };
        });
      const computeEntryModules = [...this.computeEntryModules].flatMap(([module, entries]) =>
        [...entries].map(([entryPoint, specializedModule]) => ({
          module: intern(shaderIds, module),
          entryPoint,
          specializedModule: intern(shaderIds, specializedModule),
        })),
      );
      return ok(
        structuredClone({
          version: 1,
          backend: 'webgpu',
          shaders: [...shaderIds.keys()].map((id) => entry(this.shaders, id).descriptor),
          bindGroupLayouts: [...groupIds.keys()].map((id) => entry(this.groups, id).descriptor),
          pipelineLayouts: [...layoutIds.keys()].map((id) =>
            entry(this.layouts, id).groups.map((group) => intern(groupIds, group)),
          ),
          renderPipelines,
          computePipelines,
          ...(computeEntryModules.length === 0 ? {} : { computeEntryModules }),
        }),
      );
    } catch (cause) {
      return err(failure(cause));
    }
  }
  async prepare(
    input: PipelineLibraryManifest,
    options: PipelineLibraryPrepareOptions = {},
  ): Promise<Result<PipelineLibraryInspection, RhiError>> {
    const started = performance.now();
    const background = options.background === true;
    this.indexingLibraries++;
    this.preparingLibraries++;
    let indexed = false;
    const lane = background ? this.backgroundWarmup : this.warmup;
    if (background) {
      this.backgroundRunning++;
      this.backgroundWarmup.state = 'running';
    }
    const settle = (failed: boolean) => {
      this.preparingLibraries--;
      lane.elapsedMs += performance.now() - started;
      if (!background) return;
      this.backgroundFailed ||= failed;
      if (--this.backgroundRunning === 0)
        this.backgroundWarmup.state = this.backgroundFailed ? 'failed' : 'done';
    };
    try {
      this.active();
      const concurrency = warmupConcurrency(options);
      if (background) await backgroundTurn();
      const manifest = validateManifest(input);
      if (
        typeof this.device.createRenderPipelineAsync !== 'function' ||
        typeof this.device.createComputePipelineAsync !== 'function'
      )
        throw new Error('Native asynchronous pipeline compilation is unavailable');
      const shaders = background
        ? await this.backgroundShaders(manifest.shaders, concurrency)
        : manifest.shaders.map((d) => this.createShaderModule(d));
      for (const projection of manifest.computeEntryModules ?? []) {
        const module = this.shaderIds.get(entry(shaders, projection.module));
        const specializedModule = this.shaderIds.get(entry(shaders, projection.specializedModule));
        if (module === undefined || specializedModule === undefined)
          throw new Error('Compute entry projection exceeds shader capacity');
        let entries = this.computeEntryModules.get(module);
        if (entries === undefined) {
          entries = new Map();
          this.computeEntryModules.set(module, entries);
        }
        const previous = entries.get(projection.entryPoint);
        if (previous !== undefined && previous !== specializedModule)
          throw new Error('Conflicting compute entry projection');
        entries.set(projection.entryPoint, specializedModule);
      }
      const groups: GPUBindGroupLayout[] = [];
      for (const descriptor of manifest.bindGroupLayouts) {
        if (background) await backgroundTurn();
        groups.push(this.createBindGroupLayout(descriptor));
      }
      const layouts: GPUPipelineLayout[] = [];
      for (const ids of manifest.pipelineLayouts) {
        if (background) await backgroundTurn();
        layouts.push(
          this.createPipelineLayout({ bindGroupLayouts: ids.map((id) => entry(groups, id)) }),
        );
      }
      const stage = <T extends { module: number }>(
        s: T,
      ): Omit<T, 'module'> & { module: GPUShaderModule } => ({
        ...s,
        module: entry(shaders, s.module),
      });
      const requests = interleaveManifestOrder<WarmRequest>(
        manifest.renderPipelines.map(({ fragment, ...d }) => ({
          label: d.label ?? 'render',
          run: this.indexWarmRequest(
            'render',
            {
              ...d,
              layout: d.layout === 'auto' ? 'auto' : entry(layouts, d.layout),
              vertex: stage(d.vertex),
              ...(fragment === undefined ? {} : { fragment: stage(fragment) }),
            },
            background,
          ),
        })),
        manifest.computePipelines.map((d) => ({
          label: d.label ?? 'compute',
          run: this.indexWarmRequest(
            'compute',
            this.computeDescriptor({
              ...d,
              layout: d.layout === 'auto' ? 'auto' : entry(layouts, d.layout),
              compute: stage(d.compute),
            }),
            background,
          ),
        })),
      );
      // Every library recipe has an owner before native requests are issued.
      // A runtime request can then distinguish an absent recipe from a later
      // entry of an in-progress background warmup without guessing from labels.
      this.indexingLibraries--;
      indexed = true;
      lane.requested += requests.length;
      addLoadWork('pipelines', { total: requests.length });
      await this.warmRequests(requests, concurrency, background, lane);
      this.active();
      const inspection = this.inspect();
      settle(false);
      return ok({
        ...inspection,
        warmup: { ...this.warmup },
        backgroundWarmup: { ...this.backgroundWarmup },
      });
    } catch (cause) {
      if (!indexed) this.indexingLibraries--;
      settle(true);
      return err(failure(cause));
    }
  }

  private indexWarmRequest(
    kind: 'render' | 'compute',
    descriptor: GPURenderPipelineDescriptor | GPUComputePipelineDescriptor,
    background: boolean,
  ): WarmRequest['run'] {
    const program = this.program(kind, descriptor);
    if (program !== undefined) program.preload = (program.preload ?? 0) | (background ? 2 : 1);
    return () =>
      this.createAsync(
        kind,
        descriptor,
        false,
        background ? 'background-warmup' : 'startup-warmup',
      );
  }

  private async backgroundShaders(
    descriptors: readonly GPUShaderModuleDescriptor[],
    concurrency: number,
  ): Promise<GPUShaderModule[]> {
    const shaders = new Array<GPUShaderModule>(descriptors.length);
    let cursor = 0,
      firstError: unknown;
    // Validation shares the pipeline lane's bound. Retain manifest order even
    // when native modules finish out of order, and settle every started request.
    await Promise.all(
      Array.from({ length: Math.min(concurrency, descriptors.length) }, async () => {
        while (cursor < descriptors.length && !this.closed) {
          await backgroundTurn();
          if (this.closed || cursor >= descriptors.length) break;
          const index = cursor++;
          try {
            const module = this.createShaderModule(entry(descriptors, index));
            shaders[index] = module;
            await this.getCompilationInfo(module);
          } catch (cause) {
            firstError ??= cause;
          }
        }
      }),
    );
    this.active();
    if (firstError !== undefined) throw firstError;
    return shaders;
  }

  private async warmRequests(
    requests: readonly WarmRequest[],
    concurrency: number,
    background: boolean,
    lane: { completed: number; failed: number },
  ): Promise<void> {
    let cursor = 0,
      firstError: unknown;
    // Every started request settles; each completed program is immediately a hit.
    await Promise.all(
      Array.from({ length: Math.min(concurrency, requests.length) }, async () => {
        while (cursor < requests.length && !this.closed) {
          // Cache hits also yield. Native work already submitted cannot be reprioritized.
          if (background) await backgroundTurn();
          if (this.closed || cursor >= requests.length) break;
          const index = cursor++;
          const request = entry(requests, index);
          try {
            await request.run();
            lane.completed++;
          } catch (cause) {
            lane.failed++;
            firstError ??= cause;
          }
          addLoadWork('pipelines', { done: 1, item: request.label });
        }
      }),
    );
    if (cursor < requests.length) addLoadWork('pipelines', { done: requests.length - cursor });
    if (firstError !== undefined) throw firstError;
  }
  dispose(): void {
    this.closed = true;
    this.programs.clear();
    this.computeEntryModules.clear();
    this.shaderInfo = new WeakMap();
    this.shaderByCode.clear();
    this.groupKeys.clear();
    this.layoutKeys.clear();
    this.shaders.length = 0;
    this.groups.length = 0;
    this.layouts.length = 0;
    this.counts.sourceBytes = 0;
  }
}

/** Validate the entire dependency graph before the first native creation. */
function validateManifest(input: PipelineLibraryManifest): PipelineLibraryManifest {
  const m = pod(input) as PipelineLibraryManifest;
  if (m?.version !== 1 || m.backend !== 'webgpu')
    throw new Error('Unsupported pipeline library version/backend');
  for (const rows of [
    m.shaders,
    m.bindGroupLayouts,
    m.pipelineLayouts,
    m.renderPipelines,
    m.computePipelines,
  ])
    if (!Array.isArray(rows) || rows.length > MAX_ENTRIES)
      throw new Error('Invalid pipeline library population');
  if (m.renderPipelines.length + m.computePipelines.length > MAX_ENTRIES)
    throw new Error('Pipeline library population exceeds device capacity');
  const ref = (id: unknown, rows: readonly unknown[]) => {
    if (!Number.isInteger(id) || (id as number) < 0 || (id as number) >= rows.length)
      throw new Error('Invalid pipeline library dependency');
  };
  let bytes = 0;
  for (const s of m.shaders) {
    if (typeof s.code !== 'string') throw new Error('Missing shader source');
    bytes += s.code.length * 2;
  }
  if (bytes > MAX_SOURCE_BYTES) throw new Error('Pipeline library source capacity exceeded');
  for (const g of m.bindGroupLayouts)
    if (!Array.isArray(g.entries)) throw new Error('Missing bind group layout entries');
  for (const ids of m.pipelineLayouts) {
    if (!Array.isArray(ids)) throw new Error('Invalid pipeline layout');
    for (const id of ids) ref(id, m.bindGroupLayouts);
  }
  for (const p of m.renderPipelines) {
    if (p.layout !== 'auto') ref(p.layout, m.pipelineLayouts);
    if ('compute' in p) throw new Error('Compute stage in render pipeline');
    ref(p.vertex?.module, m.shaders);
    if (p.fragment !== undefined) {
      ref(p.fragment.module, m.shaders);
      if (!Array.isArray(p.fragment.targets)) throw new Error('Missing color targets');
    }
  }
  for (const p of m.computePipelines) {
    if (p.layout !== 'auto') ref(p.layout, m.pipelineLayouts);
    if ('vertex' in p || 'fragment' in p) throw new Error('Render stage in compute pipeline');
    ref(p.compute?.module, m.shaders);
  }
  if (m.computeEntryModules !== undefined) {
    if (!Array.isArray(m.computeEntryModules) || m.computeEntryModules.length > MAX_ENTRIES)
      throw new Error('Invalid compute entry projection population');
    const seen = new Set<string>();
    for (const p of m.computeEntryModules) {
      ref(p.module, m.shaders);
      ref(p.specializedModule, m.shaders);
      if (typeof p.entryPoint !== 'string' || p.entryPoint.length === 0)
        throw new Error('Missing projected compute entry');
      const key = JSON.stringify([p.module, p.entryPoint]);
      if (seen.has(key)) throw new Error('Duplicate compute entry projection');
      seen.add(key);
    }
  }
  return m;
}

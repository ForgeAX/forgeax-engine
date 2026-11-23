import {
  encodeMipmaps,
  getOrCreateMipmapPipeline,
  type MipmapShaderModuleFactory,
  mipmapTemporaryByteLength,
} from '@forgeax/engine-assets-runtime';
import {
  type CompiledRenderGraph,
  type GraphTexture,
  type GraphTextureView,
  RenderGraphBuilder,
  type RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import type {
  BindGroup,
  BindGroupEntry,
  BindGroupLayoutEntry,
  Buffer,
  RenderPipelineDescriptor,
  RhiCommandEncoder,
  RhiDevice,
  Sampler,
  TextureView,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { TEXTURE_GENERATOR_VERTEX_ENTRY } from '@forgeax/engine-shader';
import {
  AssetError,
  deriveTextureLayout,
  err,
  type GeneratedTextureDescriptor,
  type GpuTextureAsset,
  type ManifestEntry,
  ok,
  type Result,
  type ShaderReflectionBoundGlobal,
  type ShaderReflectionMember,
  type TextureGenerationPass,
  type TextureGeneratorAsset,
  type TextureShape,
  textureGeneratorParameterLayout,
  validateTextureGenerator,
} from '@forgeax/engine-types';
import { GpuTexture } from '../gpu-resource';
import type { RenderResourceScope } from '../publication/resource-scope';
import { type ResidencyLease, ResidencyLifetime } from './residency-lifetime';
import type { GpuResourceNamespace } from './scoped-gpu-resources';
import { ScopedGpuResources } from './scoped-gpu-resources';

// GPU mip preparation remains in the physical frame submission transaction.
const USAGE = 0x10 | 0x04 | 0x02 | 0x01;
const MAX_RESIDENT_BYTES = 256 * 1024 * 1024;

function failure(expected: string): AssetError {
  return new AssetError({
    code: 'asset-invalid-value',
    expected,
    hint: 'repair the generator or its prepared shader publication, then retry the same asset',
  });
}
function required<T>(value: T | undefined, expected: string): T {
  if (value === undefined) throw failure(expected);
  return value;
}
function pending(): Result<never, AssetError> {
  return err(
    new AssetError({
      code: 'asset-not-ready',
      expected: 'completed GPU texture program preparation',
      hint: 'wait for the renderer preparation barrier and retry the same texture',
    }),
  );
}

export interface TextureGeneratorInspection {
  readonly reservedBytes: number;
  readonly groups: readonly {
    readonly guid: string;
    readonly world: string;
    readonly status: 'preparing' | 'queued' | 'generating' | 'ready' | 'failed';
    readonly acceptedGeneration?: number;
    readonly candidateGeneration?: number;
    readonly hasAccepted: boolean;
    readonly error?: { readonly code: string; readonly expected: string; readonly hint: string };
  }[];
}

export interface GeneratedAllocation {
  readonly texture: GpuTexture;
  readonly view: TextureView;
  readonly descriptor: GeneratedTextureDescriptor;
  readonly bytes: number;
  readonly generation: number;
  retain(): ResidencyLease;
}
interface Group {
  readonly device: RhiDevice;
  readonly key: string;
  readonly lifetime: ResidencyLifetime;
  readonly inputs: readonly ResidencyLease[];
  readonly outputs: ReadonlyMap<string, GeneratedAllocation>;
  readonly resources: readonly GpuTexture[];
  readonly buffers: readonly Buffer[];
  readonly graph: CompiledRenderGraph<RenderGraphFrame>;
  bytes: number;
  readonly generation: number;
  readonly accepted: Promise<boolean>;
  settle(accepted: boolean): void;
  initialized: boolean;
  submitted: boolean;
  disposed: boolean;
}
interface GenerationTarget {
  readonly texture: GpuTexture;
  readonly descriptor: GeneratedTextureDescriptor;
  readonly bytes: number;
  readonly graph: GraphTexture;
}
interface GenerationBuild {
  readonly device: RhiDevice;
  readonly mipFactory: MipmapShaderModuleFactory;
  readonly resources: Map<string, GenerationTarget>;
  readonly builder: RenderGraphBuilder<RenderGraphFrame>;
  readonly buffers: Buffer[];
  readonly inputs: ReadonlyMap<string, GeneratorInput>;
  readonly recipe: TextureGeneratorAsset;
  readonly label: string;
}
interface State {
  readonly guid: string;
  key: string;
  world: string;
  source?: TextureGeneratorAsset;
  sourceRevision?: number | undefined;
  current?: Group | undefined;
  candidate?: Group | undefined;
  job?: Promise<void> | undefined;
  error?: AssetError | undefined;
  readonly consumers: Set<number>;
}
export type GeneratorInput =
  | {
      readonly kind: 'texture';
      readonly texture: GpuTexture;
      readonly view: TextureView;
      readonly descriptor: Omit<GeneratedTextureDescriptor, 'mips'> & {
        readonly mips: import('@forgeax/engine-types').TextureMipPolicy;
      };
      retain(): ResidencyLease;
    }
  | { readonly kind: 'sampler'; readonly sampler: Sampler };

/** A sub-owner of GpuResidencyCache, never an asset registry or a submission owner. */
export class TextureGenerators {
  constructor(private readonly report?: (guid: string, error: AssetError) => void) {}
  get pending(): boolean {
    return this.queued.size !== 0;
  }
  private device: RhiDevice | undefined;
  private factory: MipmapShaderModuleFactory | undefined;
  private epoch = 0;
  private generation = 0;
  private bytes = 0;
  private states = new ScopedGpuResources<State>();
  private handles = new ScopedGpuResources<State>();
  private queued = new Set<Group>();
  private readonly owned = new Set<Group>();
  private readonly preparing = new Set<string>();

  configure(device: RhiDevice, factory?: MipmapShaderModuleFactory): void {
    this.reset();
    this.device = device;
    this.factory = factory;
  }
  reset(): void {
    this.epoch++;
    for (const group of this.owned) this.disposeGroup(group);
    this.states.clear();
    this.handles.clear();
    this.queued.clear();
    this.preparing.clear();
    this.device = undefined;
  }
  settled(handle: number, namespace: GpuResourceNamespace): Promise<void> | undefined {
    return this.handles.get(handle, namespace)?.job;
  }
  preparingHandle(handle: number, namespace: GpuResourceNamespace): boolean {
    return this.handles.get(handle, namespace)?.job !== undefined;
  }
  release(handle: number, namespace: GpuResourceNamespace): void {
    const state = this.handles.get(handle, namespace);
    if (state === undefined) return;
    this.handles.delete(handle, namespace);
    state.consumers.delete(handle);
    if (state.consumers.size !== 0) return;
    state.key = '';
    this.states.delete(state.guid, namespace);
    if (state.current !== undefined) this.retireGroup(state.current);
    if (state.candidate !== undefined) this.retireGroup(state.candidate);
  }

  prune(live: ReadonlySet<number>): void {
    for (const [namespace, rows] of this.states.entries())
      for (const [key, state] of rows) {
        for (const handle of state.consumers)
          if (!live.has(handle)) {
            state.consumers.delete(handle);
            this.handles.delete(handle, namespace);
          }
        if (state.consumers.size === 0 && state.job === undefined) {
          this.states.delete(key, namespace);
          if (state.current !== undefined) this.retireGroup(state.current);
          if (state.candidate !== undefined) this.retireGroup(state.candidate);
        }
      }
  }

  ensure(
    handle: number,
    texture: GpuTextureAsset,
    scope: RenderResourceScope,
    namespace: GpuResourceNamespace,
    input: (guid: string) => Result<GeneratorInput, AssetError>,
    waitInput: (guid: string) => Promise<void>,
  ): Result<GeneratedAllocation, AssetError> {
    const device = this.device;
    if (device === undefined) return err(failure('a configured Renderer device'));
    const recipe = scope.lookupAsset<TextureGeneratorAsset>(texture.source.generator);
    const generatorHandle = scope.handleForGuid(texture.source.generator);
    const sourceRevision =
      generatorHandle === undefined ? undefined : scope.assetRevision(generatorHandle);
    let state = this.states.get(texture.source.generator, namespace);
    if (state?.source !== recipe || state?.sourceRevision !== sourceRevision) {
      const valid = validateTextureGenerator(recipe, true);
      if (!valid.ok) return valid;
    }
    if (recipe === undefined || recipe.programs === undefined)
      return err(failure('a loaded generator with its prepared programs'));
    const preparedPrograms = recipe.programs;
    const programs = recipe.passes.map((pass) =>
      preparedPrograms.entries.find((program) => program.identifier === pass.program.module),
    );
    if (programs.some((program) => program === undefined))
      return err(failure('every generator program carried by its prepared asset publication'));
    const key = JSON.stringify([
      generatorHandle === undefined ? recipe : scope.assetRevision(generatorHandle),
      Object.values(recipe.inputs).map((guid) => {
        const h = scope.handleForGuid(guid);
        return [guid, h === undefined ? undefined : scope.assetRevision(h)];
      }),
      programs.map((program) => program?.hash),
    ]);
    if (state === undefined) {
      state = {
        guid: texture.source.generator,
        key: '',
        world: String(scope.identity),
        consumers: new Set(),
      };
      this.states.set(texture.source.generator, state, namespace);
    }
    state.source = recipe;
    state.sourceRevision = sourceRevision;
    state.consumers.add(handle);
    this.handles.set(handle, state, namespace);
    if (state.key !== key) {
      state.key = key;
      state.error = undefined;
      if (state.candidate !== undefined) this.retireGroup(state.candidate);
      state.candidate = undefined;
      const captured = state;
      const epoch = this.epoch;
      const identifier = `${String(namespace)}:${texture.source.generator}`;
      if (this.preparing.has(identifier))
        return err(failure('an acyclic generator dependency graph'));
      this.preparing.add(identifier);
      const inputs = new Map<string, GeneratorInput>();
      for (const [name, guid] of Object.entries(recipe.inputs)) {
        const resolved = input(guid);
        if (!resolved.ok) {
          this.preparing.delete(identifier);
          captured.key = '';
          if (resolved.error.code === 'asset-not-ready') {
            const waiting = waitInput(guid).finally(() => {
              if (captured.job === waiting) captured.job = undefined;
            });
            captured.job = waiting;
          }
          return resolved;
        }
        inputs.set(name, resolved.value);
      }
      this.preparing.delete(identifier);
      const job = this.prepare(
        recipe,
        programs as ManifestEntry[],
        inputs,
        texture.source.generator,
        key,
      );
      const completion: Promise<void> = job
        .then((group) => {
          if (
            this.epoch !== epoch ||
            captured.key !== key ||
            this.states.get(texture.source.generator, namespace) !== captured
          ) {
            this.disposeGroup(group);
            return;
          }
          captured.candidate = group;
          this.queued.add(group);
        })
        .catch((cause) => {
          if (this.epoch === epoch && captured.key === key) {
            captured.error = cause instanceof AssetError ? cause : failure(String(cause));
            this.report?.(texture.source.generator, captured.error);
          }
        })
        .finally(() => {
          if (captured.job === completion) captured.job = undefined;
        });
      captured.job = completion;
    }
    return selectAllocation(state, texture.source.output);
  }

  inspect(): TextureGeneratorInspection {
    return {
      reservedBytes: this.bytes,
      groups: [...this.states.entries()].flatMap(([, rows]) =>
        [...rows].map(([guid, state]) => ({
          guid: String(guid),
          world: state.world,
          status:
            state.error !== undefined
              ? ('failed' as const)
              : state.job !== undefined
                ? ('preparing' as const)
                : state.candidate !== undefined
                  ? state.candidate.submitted
                    ? ('generating' as const)
                    : ('queued' as const)
                  : state.current !== undefined
                    ? ('ready' as const)
                    : ('preparing' as const),
          hasAccepted: state.current !== undefined,
          ...(state.current === undefined ? {} : { acceptedGeneration: state.current.generation }),
          ...(state.candidate === undefined
            ? {}
            : { candidateGeneration: state.candidate.generation }),
          ...(state.error === undefined
            ? {}
            : {
                error: {
                  code: state.error.code,
                  expected: state.error.expected,
                  hint: state.error.hint,
                },
              }),
        })),
      ),
    };
  }

  isCurrent(handle: number, namespace: GpuResourceNamespace): boolean {
    const state = this.handles.get(handle, namespace);
    return (
      state !== undefined &&
      (state.candidate?.key === state.key || state.current?.key === state.key)
    );
  }

  /** Consumers with their own queue submission need the generated image to have completed. */
  isAccepted(handle: number, namespace: GpuResourceNamespace, generation: number): boolean {
    return this.handles.get(handle, namespace)?.current?.generation === generation;
  }

  /** The fixed-source path needs the current recipe's GPU completion, including its mips. */
  acceptance(
    handle: number,
    namespace: GpuResourceNamespace,
    generation: number,
  ): Result<Promise<boolean>, AssetError> {
    const state = this.handles.get(handle, namespace);
    const group = state?.candidate ?? state?.current;
    if (group !== undefined && group.generation === generation && group.key === state?.key)
      return ok(group.accepted);
    return state?.error === undefined ? pending() : err(state.error);
  }

  /** The physical-frame owner calls this before scene command buffers, then supplies its submit result. */
  encode(encoder: () => RhiCommandEncoder): { complete(submitted: boolean): void } | undefined {
    const device = this.device;
    if (device === undefined || this.queued.size === 0) return undefined;
    const groups = [...this.queued].filter((g) => !g.disposed && !g.initialized);
    const releases: (() => void)[] = [];
    try {
      for (const group of groups) {
        group.graph.execute({ encoder: encoder() }).unwrap();
        for (const allocation of group.outputs.values())
          if (allocation.descriptor.mips.kind === 'generate') {
            const shape = allocation.descriptor.shape;
            releases.push(
              encodeMipmaps(device, encoder(), allocation.texture.handle, {
                format: allocation.descriptor.format,
                ...(allocation.descriptor.mipFilter === undefined
                  ? {}
                  : { filter: allocation.descriptor.mipFilter }),
                ...shape.extent,
                arrayLayerCount: shape.viewDimension === '2d-array' ? shape.extent.layers : 1,
              }).unwrap(),
            );
          }
      }
    } catch (cause) {
      for (const release of releases) release();
      for (const group of groups) this.failGroup(group, cause);
      if (cause instanceof RhiError) throw cause;
      throw new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'the GPU texture generation graph to encode successfully',
        hint: 'inspect the generator error and repair its current recipe before retrying',
      });
    }
    let completed = false;
    return {
      complete: (submitted) => {
        if (completed) return;
        completed = true;
        if (!submitted) {
          for (const release of releases) release();
          return;
        }
        for (const group of groups) {
          group.submitted = true;
          this.queued.delete(group);
        }
        const epoch = this.epoch;
        const completion = device.queue.onSubmittedWorkDone();
        for (const group of groups) {
          group.lifetime.track(completion);
          for (const lease of group.inputs) lease.track(completion);
        }
        void completion.then(
          () => {
            for (const release of releases) release();
            if (epoch !== this.epoch) return;
            for (const group of groups) {
              if (group.disposed) continue;
              group.initialized = true;
              for (const state of this.states.values())
                if (state.candidate === group) {
                  const previous = state.current;
                  state.current = group;
                  state.candidate = undefined;
                  if (previous !== undefined) this.retireGroup(previous);
                }
              this.releaseTransient(group);
              group.settle(true);
            }
          },
          (cause) => {
            for (const release of releases) release();
            if (epoch === this.epoch) for (const group of groups) this.failGroup(group, cause);
          },
        );
      },
    };
  }

  private failGroup(group: Group, cause: unknown): void {
    const error =
      cause instanceof AssetError
        ? cause
        : failure(cause instanceof Error ? cause.message : String(cause));
    for (const state of this.states.values())
      if (state.candidate === group) {
        state.error = error;
        state.candidate = undefined;
        this.report?.(state.guid, error);
      }
    this.queued.delete(group);
    this.retireGroup(group);
  }

  private releaseTransient(group: Group): void {
    const retained = new Set([...group.outputs.values()].map((output) => output.texture));
    for (const texture of group.resources)
      if (!retained.has(texture) && !texture.isDestroyed) texture.destroy();
    for (const buffer of group.buffers) group.device.destroyBuffer(buffer);
    for (const lease of group.inputs) void lease.release(false);
    const outputBytes = [...group.outputs.values()].reduce((sum, output) => sum + output.bytes, 0);
    this.bytes -= group.bytes - outputBytes;
    group.bytes = outputBytes;
    void group.graph.retire();
  }
  private retireGroup(group: Group): void {
    group.settle(false);
    if (!group.disposed) group.lifetime.retire();
  }
  private disposeGroup(group: Group): void {
    if (group.disposed) return;
    group.disposed = true;
    group.settle(false);
    this.queued.delete(group);
    this.owned.delete(group);
    this.bytes -= group.bytes;
    for (const texture of group.resources) if (!texture.isDestroyed) texture.destroy();
    if (!group.initialized) {
      for (const buffer of group.buffers) group.device.destroyBuffer(buffer);
      for (const lease of group.inputs) void lease.release(false);
    }
    void group.graph.retire();
  }

  private async prepare(
    recipe: TextureGeneratorAsset,
    programs: readonly ManifestEntry[],
    inputs: ReadonlyMap<string, GeneratorInput>,
    label: string,
    key: string,
  ): Promise<Group> {
    const device = required(this.device, 'a configured Renderer device');
    const mipFactory = this.factory;
    if (mipFactory === undefined)
      throw failure('the backend shader-module factory for generator programs');
    const resources = new Map<string, GenerationTarget>();
    const builder = new RenderGraphBuilder<RenderGraphFrame>();
    const buffers: Buffer[] = [];
    validateDeviceTargets(device, recipe);
    const mipBytes = Object.values(recipe.outputs).reduce(
      (sum, output) =>
        sum +
        (output.mips.kind === 'generate'
          ? mipmapTemporaryByteLength(
              {
                ...output.shape.extent,
                format: output.format,
                ...(output.mipFilter === undefined ? {} : { filter: output.mipFilter }),
                arrayLayerCount:
                  output.shape.viewDimension === '2d-array' ? output.shape.extent.layers : 1,
              },
              device.caps.backendKind,
            )
          : 0),
      0,
    );
    const bytes =
      mipBytes +
      [...Object.values(recipe.outputs), ...Object.values(recipe.transient)].reduce(
        (sum, source) =>
          sum +
          deriveTextureLayout({
            ...source,
            mips:
              'mips' in source
                ? (source.mips as GeneratedTextureDescriptor['mips'])
                : { kind: 'none' },
          }).unwrap().byteLength,
        0,
      );
    if (this.bytes + bytes > MAX_RESIDENT_BYTES)
      throw failure(
        'GPU generator old/candidate/transient allocations fit the 256 MiB residency budget',
      );
    this.bytes += bytes;
    const inputLeases = [...inputs.values()].flatMap((input) =>
      input.kind === 'texture' ? [input.retain()] : [],
    );
    let preparedGroup: Group | undefined;
    const lifetime = new ResidencyLifetime(() => {
      if (preparedGroup !== undefined) this.disposeGroup(preparedGroup);
    });
    const generation = ++this.generation;
    const outputs = new Map<string, GeneratedAllocation>();
    try {
      const build: GenerationBuild = {
        device,
        mipFactory,
        resources,
        builder,
        buffers,
        inputs,
        recipe,
        label,
      };
      const external = importInputs(build);
      await allocateTargets(build, outputs, lifetime, generation);
      for (let index = 0; index < recipe.passes.length; index++) {
        await addGenerationPass(
          build,
          required(recipe.passes[index], 'a finite generation pass'),
          required(programs[index], 'a prepared program for each pass'),
          index,
          external,
        );
      }
      const graph = builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
      let settle: Group['settle'] = () => {};
      const accepted = new Promise<boolean>((resolve) => {
        settle = resolve;
      });
      const group: Group = {
        device,
        key,
        lifetime,
        inputs: inputLeases,
        outputs,
        resources: [...resources.values()].map((r) => r.texture),
        buffers,
        graph,
        bytes,
        generation,
        accepted,
        settle,
        initialized: false,
        submitted: false,
        disposed: false,
      };
      preparedGroup = group;
      this.owned.add(group);
      return group;
    } catch (cause) {
      this.bytes -= bytes;
      for (const lease of inputLeases) void lease.release(false);
      for (const resource of resources.values())
        if (!resource.texture.isDestroyed) resource.texture.destroy();
      for (const buffer of buffers) device.destroyBuffer(buffer);
      throw cause;
    }
  }
}

function writeMember(
  view: DataView,
  member: ShaderReflectionMember,
  value: number | readonly number[] | undefined,
): void {
  const layout = textureGeneratorParameterLayout(member.typeDescriptor);
  if (value === undefined || layout === undefined)
    throw failure(`a reflected numeric value for parameter ${member.name}`);
  const values = typeof value === 'number' ? [value] : value;
  if (values.length !== layout.count * layout.components)
    throw failure(`parameter arity for ${member.name}`);
  const scalarKind = layout.scalarKind.toLowerCase();
  for (let index = 0; index < values.length; index++) {
    const number = values[index] as number;
    const offset =
      member.offset +
      Math.floor(index / layout.components) * layout.stride +
      (index % layout.components) * 4;
    if (scalarKind === 'float' || scalarKind === 'f32') view.setFloat32(offset, number, true);
    else if (scalarKind === 'uint' || scalarKind === 'u32') view.setUint32(offset, number, true);
    else if (scalarKind === 'sint' || scalarKind === 'i32') view.setInt32(offset, number, true);
    else throw failure(`a supported numeric parameter ${member.name}`);
  }
}

function validateDeviceTargets(device: RhiDevice, recipe: TextureGeneratorAsset): void {
  if (
    Object.values(recipe.outputs).some((output) => output.mipFilter === 'normal-roughness') &&
    (!device.caps.rgba16floatRenderable ||
      device.caps.maxColorAttachments < 2 ||
      (device.limits.maxColorAttachmentBytesPerSample ?? 32) < 12)
  )
    throw failure(
      'normal-roughness mips require renderable half-float and two MRTs within 12 bytes/sample',
    );
  for (const source of [...Object.values(recipe.outputs), ...Object.values(recipe.transient)]) {
    if (
      source.format === 'r32float' &&
      'mips' in source &&
      (source.mips as GeneratedTextureDescriptor['mips']).kind === 'generate' &&
      !device.caps.float32Filterable
    )
      throw failure('float32-filterable support for r32float GPU mip generation');
    if (source.format === 'rgba16float' && !device.caps.rgba16floatRenderable)
      throw failure('rgba16float render attachment support');
    const shape = source.shape;
    const volume = shape.viewDimension === '3d';
    const maxDimension = volume
      ? device.limits.maxTextureDimension3D
      : device.limits.maxTextureDimension2D;
    const maxImages = volume ? maxDimension : device.limits.maxTextureArrayLayers;
    if (
      shape.extent.width > maxDimension ||
      shape.extent.height > maxDimension ||
      imageCount(shape) > maxImages
    )
      throw failure('generation extents fit the device texture limits');
  }
  if (
    recipe.passes.some(
      (pass) =>
        pass.writes.reduce((sum, name) => {
          const format = required(
            Object.hasOwn(recipe.outputs, name) ? recipe.outputs[name] : recipe.transient[name],
            'a declared target descriptor',
          ).format;
          return sum + (format === 'rgba16float' ? 8 : 4);
        }, 0) > (device.limits.maxColorAttachmentBytesPerSample ?? 32),
    )
  )
    throw failure('generator MRT byte footprint fits the device attachment budget');
  if (recipe.passes.some((pass) => pass.writes.length > device.caps.maxColorAttachments))
    throw failure('generator MRT count fits the device');
}

function imageCount(shape: TextureShape): number {
  if (shape.viewDimension === '3d') return shape.extent.depth;
  return shape.viewDimension === '2d-array' ? shape.extent.layers : 1;
}

function textureExtent(shape: TextureShape) {
  const { width, height } = shape.extent;
  return {
    dimension: shape.viewDimension === '3d' ? ('3d' as const) : ('2d' as const),
    size: { width, height, depthOrArrayLayers: imageCount(shape) },
  };
}

function importInputs(build: GenerationBuild): Map<string, GraphTexture> {
  const { inputs, builder } = build;
  const external = new Map<string, GraphTexture>();
  for (const [name, input] of inputs)
    if (input.kind === 'texture') {
      const descriptor = input.descriptor;
      const layout = deriveTextureLayout(descriptor).unwrap();
      external.set(
        name,
        builder
          .importTexture(
            `input/${name}`,
            {
              format: descriptor.format,
              ...textureExtent(descriptor.shape),
              usage: 0x04,
              mipLevelCount: layout.levels.length,
            },
            () => input.texture.handle,
          )
          .unwrap(),
      );
    }
  return external;
}

async function allocateTargets(
  build: GenerationBuild,
  outputs: Map<string, GeneratedAllocation>,
  lifetime: ResidencyLifetime,
  generation: number,
): Promise<void> {
  const { device, mipFactory, resources, builder, recipe, label } = build;
  for (const [name, source] of [
    ...Object.entries(recipe.outputs),
    ...Object.entries(recipe.transient),
  ]) {
    const descriptor: GeneratedTextureDescriptor =
      'mips' in source
        ? (source as GeneratedTextureDescriptor)
        : { ...source, colorSpace: 'linear', mips: { kind: 'none' } };
    const layout = deriveTextureLayout(descriptor).unwrap();
    const shape = descriptor.shape;

    const raw = device
      .createTexture({
        label: `${label}/${name}`,
        ...textureExtent(shape),
        format: descriptor.format,
        usage: USAGE,
        mipLevelCount: layout.levels.length,
      })
      .unwrap();
    const texture = new GpuTexture(device, raw);
    const graph = builder
      .importTexture(
        name,
        {
          format: descriptor.format,
          ...textureExtent(shape),
          usage: USAGE,
          mipLevelCount: layout.levels.length,
        },
        () => raw,
      )
      .unwrap();
    resources.set(name, { texture, descriptor, bytes: layout.byteLength, graph });
    if (Object.hasOwn(recipe.outputs, name)) {
      const view = device.createTextureView(raw, { dimension: shape.viewDimension }).unwrap();
      outputs.set(name, {
        texture,
        descriptor,
        bytes: layout.byteLength,
        generation,
        view,
        // Sibling binding invalidation cannot retire the accepted group.
        // State replacement/pruning owns group retirement; leases only fence its use.
        retain: () => lifetime.retain(() => {}),
      });
      if (descriptor.mips.kind === 'generate')
        (
          await getOrCreateMipmapPipeline(
            device,
            descriptor.format,
            mipFactory,
            descriptor.mipFilter,
          )
        ).unwrap();
    }
  }
}

function generatorLayoutEntry(global: ShaderReflectionBoundGlobal): BindGroupLayoutEntry {
  const base = { binding: global.binding, visibility: 2 };
  if (global.resourceKind === 'buffer' && global.addressSpace === 'uniform')
    return {
      ...base,
      buffer: {
        type: 'uniform' as const,
        minBindingSize: global.span ?? global.typeDescriptor?.byteSize ?? 0,
      },
    };
  if (global.resourceKind === 'sampler')
    return { ...base, sampler: { type: global.samplerType ?? 'filtering' } };
  if (global.resourceKind === 'texture' && global.textureClass === 'sampled')
    return {
      ...base,
      texture: {
        sampleType: global.sampleType ?? 'float',
        viewDimension: global.viewDimension ?? '2d',
        multisampled: false,
      },
    };
  throw failure(`read-only uniform/texture/sampler binding ${global.name}`);
}

function createLayerBindings(
  build: GenerationBuild,
  globals: readonly ShaderReflectionBoundGlobal[],
  pass: TextureGenerationPass,
  target: GeneratedTextureDescriptor['shape'],
  layer: number,
  external: ReadonlyMap<string, GraphTexture>,
): {
  bindings: BindGroupEntry[];
  accesses: { resource: GraphTextureView; usage: 'sampled-read' }[];
} {
  const { device, builder, inputs, resources } = build;
  const bindings: BindGroupEntry[] = [];
  const accesses: { resource: GraphTextureView; usage: 'sampled-read' }[] = [];
  for (const global of globals) {
    if (global.resourceKind === 'buffer') {
      bindings.push(createUniformBinding(build, global, target, layer));
      continue;
    }
    const read = global.name === undefined ? undefined : pass.reads[global.name];
    if (read === undefined) throw failure(`explicit read binding ${global.name}`);
    const resource = read.kind === 'input' ? inputs.get(read.name) : resources.get(read.name);
    if (resource === undefined) throw failure(`loaded read resource ${read.name}`);
    if ('kind' in resource && resource.kind === 'sampler') {
      if (global.resourceKind !== 'sampler') throw failure(`sampler binding ${global.name}`);
      bindings.push({
        binding: global.binding,
        resource: { kind: 'sampler', value: resource.sampler },
      });
    } else {
      if (global.resourceKind !== 'texture' || !('texture' in resource))
        throw failure(`texture binding ${global.name}`);
      const dimension = global.viewDimension ?? '2d';
      const mipLevelCount =
        read.kind === 'local' ? 1 : deriveTextureLayout(resource.descriptor).unwrap().levels.length;
      const viewDescriptor =
        dimension === '2d'
          ? {
              dimension: '2d' as const,
              baseArrayLayer: resource.descriptor.shape.viewDimension === '2d-array' ? layer : 0,
              arrayLayerCount: 1,
              baseMipLevel: 0,
              mipLevelCount,
            }
          : { dimension, baseMipLevel: 0, mipLevelCount };
      const view = device.createTextureView(resource.texture.handle, viewDescriptor).unwrap();
      bindings.push({
        binding: global.binding,
        resource: { kind: 'textureView', value: view },
      });
      const graph =
        'graph' in resource
          ? resource.graph
          : required(external.get(read.name), 'an imported texture input');
      accesses.push({
        resource: builder.view(graph, viewDescriptor).unwrap(),
        usage: 'sampled-read',
      });
    }
  }
  return { bindings, accesses };
}

async function addGenerationPass(
  build: GenerationBuild,
  pass: TextureGenerationPass,
  program: ManifestEntry,
  index: number,
  external: ReadonlyMap<string, GraphTexture>,
): Promise<void> {
  const { device, mipFactory, resources, builder, label } = build;
  if (pass.writes.length > device.caps.maxColorAttachments)
    throw failure('generator MRT count fits the device');
  const reflection = program.reflection;
  const selected = reflection?.entryPoints?.find(
    (entry) => entry.name === pass.program.fragmentEntry && entry.stage === 'fragment',
  );
  if (reflection === undefined || selected === undefined)
    throw failure(`published reflection for ${pass.program.module}/${pass.program.fragmentEntry}`);
  const globals = reflection.boundGlobals.filter((global) =>
    selected.bindings.some(
      (binding) => binding.group === global.group && binding.binding === global.binding,
    ),
  );
  if (globals.some((global) => global.group !== 0))
    throw failure('generator resources use bind group 0');
  const entries = globals.map(generatorLayoutEntry);
  const bindLayout = device
    .createBindGroupLayout({ label: `${label}/bindings/${index}`, entries })
    .unwrap();
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindLayout] }).unwrap();
  const fragment = (
    await mipFactory(device, { label: pass.program.module, code: program.wgsl })
  ).unwrap();
  const pipelineDescriptor: RenderPipelineDescriptor = {
    label: `${label}/${index}`,
    layout: pipelineLayout,
    vertex: { module: fragment, entryPoint: TEXTURE_GENERATOR_VERTEX_ENTRY, buffers: [] },
    fragment: {
      module: fragment,
      entryPoint: pass.program.fragmentEntry,
      targets: pass.writes.map((name) => ({
        format: required(resources.get(name), 'a declared target').descriptor.format,
      })),
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
  };
  const pipeline = (
    await (device.createRenderPipelineAsync?.(pipelineDescriptor) ??
      device.createRenderPipeline(pipelineDescriptor))
  ).unwrap();
  const target = required(
    resources.get(required(pass.writes[0], 'a target name')),
    'a declared target',
  ).descriptor.shape;
  const volume = target.viewDimension === '3d';
  for (let layer = 0; layer < imageCount(target); layer++) {
    const { bindings, accesses } = createLayerBindings(
      build,
      globals,
      pass,
      target,
      layer,
      external,
    );
    const group: BindGroup = device
      .createBindGroup({ layout: bindLayout, entries: bindings })
      .unwrap();
    const attachments = pass.writes.map((name) => ({
      view: builder
        .view(required(resources.get(name), 'a declared target').graph, {
          baseMipLevel: 0,
          mipLevelCount: 1,
          ...(volume
            ? { dimension: '3d' as const }
            : { dimension: '2d' as const, baseArrayLayer: layer, arrayLayerCount: 1 }),
        })
        .unwrap(),
      ...(volume ? { depthSlice: layer } : {}),
      loadOp: 'clear' as const,
      storeOp: 'store' as const,
    }));
    builder
      .addRasterPass(`${label}/${index}/${layer}`, {
        accesses: [
          ...accesses,
          ...attachments.map((attachment) => ({
            resource: attachment.view,
            usage: 'color-attachment' as const,
          })),
        ],
        colorAttachments: attachments,
        encodeDirect: (encoder) => {
          encoder.setPipeline(pipeline);
          encoder.setBindGroup(0, group);
          encoder.draw(3);
        },
      })
      .unwrap();
  }
}

function selectAllocation(state: State, output: string): Result<GeneratedAllocation, AssetError> {
  if (state.error !== undefined && state.current === undefined) return err(state.error);
  const selected = state.candidate ?? state.current;
  const allocation = selected?.outputs.get(output);
  if (allocation === undefined) return pending();
  if (allocation.texture.isDestroyed) {
    state.key = '';
    return pending();
  }
  return ok(allocation);
}

function createUniformBinding(
  build: GenerationBuild,
  global: ShaderReflectionBoundGlobal,
  target: GeneratedTextureDescriptor['shape'],
  layer: number,
): BindGroupEntry {
  const { recipe, device, buffers } = build;
  const size = Math.max(
    16,
    Math.ceil((global.span ?? global.typeDescriptor?.byteSize ?? 0) / 16) * 16,
  );
  if (size > device.limits.maxUniformBufferBindingSize)
    throw failure('generator parameters fit the device uniform binding limit');
  const data = new ArrayBuffer(size);
  const values = {
    ...recipe.values,
    _textureSize: [target.extent.width, target.extent.height],
    _textureLayer: layer,
  };
  for (const member of global.members ?? [])
    writeMember(new DataView(data), member, values[member.name as keyof typeof values]);
  const buffer = device.createBuffer({ size, usage: 0x40 | 0x08 }).unwrap();
  buffers.push(buffer);
  device.queue.writeBuffer(buffer, 0, data).unwrap();
  return { binding: global.binding, resource: { kind: 'buffer', value: { buffer } } };
}

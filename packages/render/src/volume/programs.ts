import type {
  BindGroupLayout,
  BindGroupLayoutEntry,
  ComputePipeline,
  ComputePipelineDescriptor,
  PipelineLayout,
  RenderPipeline,
  RenderPipelineDescriptor,
  RhiDevice,
  ShaderModule,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import type { DeviceScope } from '../device/device-scope';
import type { PipelineBuilderShaderModuleFactory } from '../pipeline-builder';
import type { VolumetricFogShaderSources } from '../render-contract';
import type { RenderPipelineTarget } from '../render-pipeline';
import { MAX_VOLUMETRIC_FOG_OWNERS } from './component';
import { VOLUME_FROXEL_FORMAT, VOLUME_HISTORY_FORMAT, VOLUME_RESOLVED_FORMAT } from './resources';

export interface VolumeProgramContext {
  readonly device: RhiDevice;
  readonly deviceScope: DeviceScope;
  readonly shaderModuleFactory: PipelineBuilderShaderModuleFactory;
}
export interface ComputeState {
  readonly pipeline: ComputePipeline;
  readonly layout: BindGroupLayout;
}
interface CompositeState {
  readonly pipeline: RenderPipeline;
  readonly layout: BindGroupLayout;
}
type ComputeLabel = 'volume_inject' | 'volume_integrate' | 'volume_temporal';
type Neighbors = 2 | 4 | 8;
interface Program<T> {
  readonly source: string;
  readonly factory: PipelineBuilderShaderModuleFactory;
  readonly factoryMethod: PipelineBuilderShaderModuleFactory['createShaderModule'];
  readonly module: ShaderModule;
  state?: T;
  pending?: Promise<T>;
}
interface CompositeProgram extends Program<CompositeState> {
  readonly format: RenderPipelineTarget['format'];
}
interface VolumePrograms {
  readonly compute: Map<ComputeLabel, Program<ComputeState>>;
  // Only the current format per bounded neighbor variant is retained.
  readonly composite: Map<Neighbors, CompositeProgram>;
}
const programs = new WeakMap<DeviceScope, WeakMap<RhiDevice, VolumePrograms>>();
function unavailable(stage: string): RhiError {
  return new RhiError({
    code: 'rhi-not-available',
    expected: `volumetric fog ${stage} preparation remains current`,
    hint: 'await renderer initialization on the active device generation before drawing',
  });
}
function programsFor(context: VolumeProgramContext): VolumePrograms {
  const { deviceScope: scope, device } = context;
  if (!scope.isAlive()) throw unavailable('device scope');
  let devices = programs.get(scope);
  if (devices === undefined) {
    devices = new WeakMap();
    programs.set(scope, devices);
    scope._adopt('pipeline', devices, () => {
      programs.delete(scope);
    });
  }
  let result = devices.get(device);
  if (result === undefined) {
    result = { compute: new Map(), composite: new Map() };
    devices.set(device, result);
  }
  return result;
}
/** Density slots continue after the atmosphere texture/sampler at 25/26. */
export function additionalVolumeDensityBinding(index: number): number {
  return index < 7 ? 18 + index : 20 + index;
}
const computeEntries: Readonly<Record<ComputeLabel, readonly BindGroupLayoutEntry[]>> = {
  volume_inject: [
    { binding: 0, visibility: 4, buffer: { type: 'uniform' } },
    { binding: 3, visibility: 4, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
    { binding: 4, visibility: 4, sampler: { type: 'comparison' } },
    { binding: 5, visibility: 4, buffer: { type: 'uniform' } },
    {
      binding: 6,
      visibility: 4,
      storageTexture: {
        access: 'write-only',
        format: VOLUME_FROXEL_FORMAT,
        viewDimension: '2d-array',
      },
    },
    { binding: 7, visibility: 4, buffer: { type: 'read-only-storage' } },
    { binding: 8, visibility: 4, buffer: { type: 'uniform' } },
    { binding: 9, visibility: 4, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
  ],
  volume_integrate: [
    { binding: 0, visibility: 4, texture: { sampleType: 'float', viewDimension: '2d-array' } },
    { binding: 1, visibility: 4, texture: { sampleType: 'depth', viewDimension: '2d' } },
    {
      binding: 2,
      visibility: 4,
      storageTexture: {
        access: 'write-only',
        format: VOLUME_RESOLVED_FORMAT,
        viewDimension: '2d',
      },
    },
    { binding: 3, visibility: 4, buffer: { type: 'uniform' } },
    { binding: 4, visibility: 4, buffer: { type: 'uniform' } },
    { binding: 5, visibility: 4, sampler: { type: 'filtering' } },
    { binding: 6, visibility: 4, texture: { sampleType: 'float', viewDimension: '3d' } },
    { binding: 7, visibility: 4, sampler: { type: 'filtering' } },
    {
      binding: 8,
      visibility: 4,
      storageTexture: {
        access: 'write-only',
        format: VOLUME_HISTORY_FORMAT,
        viewDimension: '2d',
      },
    },
    {
      binding: 9,
      visibility: 4,
      storageTexture: {
        access: 'write-only',
        format: VOLUME_HISTORY_FORMAT,
        viewDimension: '2d',
      },
    },
    { binding: 10, visibility: 4, buffer: { type: 'read-only-storage' } },
    { binding: 11, visibility: 4, buffer: { type: 'uniform' } },
    { binding: 12, visibility: 4, texture: { sampleType: 'float', viewDimension: '2d' } },
    { binding: 13, visibility: 4, sampler: { type: 'filtering' } },
    { binding: 16, visibility: 4, texture: { sampleType: 'float', viewDimension: '2d' } },
    { binding: 17, visibility: 4, sampler: { type: 'filtering' } },
    { binding: 25, visibility: 4, texture: { sampleType: 'float', viewDimension: '2d' } },
    { binding: 26, visibility: 4, sampler: { type: 'filtering' } },
    ...Array.from({ length: MAX_VOLUMETRIC_FOG_OWNERS - 1 }, (_, index) => ({
      binding: additionalVolumeDensityBinding(index),
      visibility: 4,
      texture: { sampleType: 'float' as const, viewDimension: '3d' as const },
    })),
  ],
  volume_temporal: [
    { binding: 0, visibility: 4, texture: { sampleType: 'float', viewDimension: '2d' } },
    { binding: 1, visibility: 4, texture: { sampleType: 'float', viewDimension: '2d' } },
    {
      binding: 2,
      visibility: 4,
      storageTexture: {
        access: 'write-only',
        format: VOLUME_HISTORY_FORMAT,
        viewDimension: '2d',
      },
    },
    { binding: 3, visibility: 4, buffer: { type: 'uniform' } },
    { binding: 4, visibility: 4, buffer: { type: 'uniform' } },
  ],
};
function witness(context: VolumeProgramContext, source: string, label: string) {
  const factory = context.shaderModuleFactory;
  const factoryMethod = factory.createShaderModule;
  const result = factoryMethod.call(factory, { code: source, label });
  if (!result.ok) throw result.error;
  return { source, factory, factoryMethod, module: result.value };
}
function sameWitness<T>(
  previous: Program<T> | undefined,
  current: ReturnType<typeof witness>,
): boolean {
  return (
    previous?.source === current.source &&
    previous.factory === current.factory &&
    previous.factoryMethod === current.factoryMethod &&
    previous.module === current.module
  );
}
function computeProgram(context: VolumeProgramContext, source: string, label: ComputeLabel) {
  const owner = programsFor(context);
  const current = witness(context, source, label);
  let entry = owner.compute.get(label);
  if (entry === undefined || !sameWitness(entry, current)) {
    entry = current;
    owner.compute.set(label, entry);
  }
  return entry;
}
function compositeProgram(
  context: VolumeProgramContext,
  source: string,
  format: RenderPipelineTarget['format'],
  neighbors: Neighbors,
) {
  const owner = programsFor(context);
  const current = witness(context, source, 'volume_composite');
  let entry = owner.composite.get(neighbors);
  if (entry === undefined || !sameWitness(entry, current) || entry.format !== format) {
    entry = { ...current, format };
    owner.composite.set(neighbors, entry);
  }
  return entry;
}
function pipelineLayout(
  context: VolumeProgramContext,
  label: string,
  entries: readonly BindGroupLayoutEntry[],
  named = false,
): { layout: BindGroupLayout; pipelineLayout: PipelineLayout } {
  const layout = context.device.createBindGroupLayout({
    ...(named ? { label: `${label}.bind-group-layout` } : {}),
    entries,
  });
  if (!layout.ok) throw layout.error;
  const pipelineLayout = context.device.createPipelineLayout({
    label: `${label}.layout`,
    bindGroupLayouts: [layout.value],
  });
  if (!pipelineLayout.ok) throw pipelineLayout.error;
  return { layout: layout.value, pipelineLayout: pipelineLayout.value };
}
function computeDescriptor(
  context: VolumeProgramContext,
  entry: Program<ComputeState>,
  label: ComputeLabel,
) {
  const { layout, pipelineLayout: value } = pipelineLayout(context, label, computeEntries[label]);
  const descriptor: ComputePipelineDescriptor = {
    label,
    layout: value,
    compute: { module: entry.module, entryPoint: label },
  };
  return { layout, descriptor };
}
function compositeDescriptor(
  context: VolumeProgramContext,
  entry: CompositeProgram,
  neighbors: Neighbors,
) {
  const { layout, pipelineLayout: value } = pipelineLayout(
    context,
    'volume_composite',
    [
      { binding: 0, visibility: 2 | 1, texture: { sampleType: 'float', viewDimension: '2d' } },
      { binding: 1, visibility: 2 | 1, sampler: { type: 'filtering' } },
      { binding: 2, visibility: 2 | 1, texture: { sampleType: 'depth', viewDimension: '2d' } },
      { binding: 3, visibility: 2 | 1, buffer: { type: 'uniform' } },
    ],
    true,
  );
  const descriptor: RenderPipelineDescriptor = {
    label: 'volume_composite',
    layout: value,
    vertex: { module: entry.module, entryPoint: 'volume_vs', buffers: [] },
    fragment: {
      module: entry.module,
      entryPoint: 'volume_fs',
      constants: { VOLUME_COMPOSITE_NEIGHBORS: neighbors },
      targets: [
        {
          format: entry.format,
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        },
      ],
    },
    primitive: { topology: 'triangle-list' },
  };
  return { layout, descriptor };
}
export function volumeComputeState(
  context: VolumeProgramContext,
  source: string,
  label: ComputeLabel,
): ComputeState {
  const entry = computeProgram(context, source, label);
  if (entry.state !== undefined) return entry.state;
  if (entry.pending !== undefined) throw unavailable(`${label} pending`);
  const { layout, descriptor } = computeDescriptor(context, entry, label);
  const created = context.device.createComputePipeline(descriptor);
  if (!created.ok) throw created.error;
  entry.state = { layout, pipeline: created.value };
  return entry.state;
}
export function volumeCompositeState(
  context: VolumeProgramContext,
  source: string,
  format: RenderPipelineTarget['format'],
  neighbors: Neighbors,
): CompositeState {
  const entry = compositeProgram(context, source, format, neighbors);
  if (entry.state !== undefined) return entry.state;
  if (entry.pending !== undefined) throw unavailable('volume_composite pending');
  const { layout, descriptor } = compositeDescriptor(context, entry, neighbors);
  const created = context.device.createRenderPipeline(descriptor);
  if (!created.ok) throw created.error;
  entry.state = { layout, pipeline: created.value };
  return entry.state;
}
async function prepare<T>(
  context: VolumeProgramContext,
  entry: Program<T>,
  create: () => Promise<T>,
): Promise<void> {
  if (!context.deviceScope.isAlive()) throw unavailable('retired device scope');
  if (entry.state !== undefined) return;
  entry.pending ??= create();
  const pending = entry.pending;
  try {
    const state = await pending;
    if (!context.deviceScope.isAlive()) throw unavailable('retired device scope');
    entry.state = state;
  } finally {
    if (entry.pending === pending) delete entry.pending;
  }
}
/** Prepare immutable programs only: no graph resources, buffers, bind groups or dispatches. */
export async function prepareVolumePrograms(
  context: VolumeProgramContext,
  sources: VolumetricFogShaderSources,
  format: RenderPipelineTarget['format'],
): Promise<void> {
  const prepared: Array<{ label: string; entry: Program<unknown> }> = [];
  const work: Array<() => Promise<void>> = [];
  for (const [stage, label] of [
    ['inject', 'volume_inject'],
    ['integrate', 'volume_integrate'],
    ['temporal', 'volume_temporal'],
  ] as const) {
    const entry = computeProgram(context, sources[stage], label);
    prepared.push({ label, entry });
    work.push(() =>
      prepare(context, entry, async () => {
        const { layout, descriptor } = computeDescriptor(context, entry, label);
        const result =
          context.device.createComputePipelineAsync === undefined
            ? context.device.createComputePipeline(descriptor)
            : await context.device.createComputePipelineAsync(descriptor);
        if (!result.ok) throw result.error;
        return { layout, pipeline: result.value };
      }),
    );
  }
  for (const neighbors of [2, 4, 8] as const) {
    const entry = compositeProgram(context, sources.composite, format, neighbors);
    if (neighbors === 2) prepared.push({ label: 'volume_composite', entry });
    work.push(() =>
      prepare(context, entry, async () => {
        const { layout, descriptor } = compositeDescriptor(context, entry, neighbors);
        const result =
          context.device.createRenderPipelineAsync === undefined
            ? context.device.createRenderPipeline(descriptor)
            : await context.device.createRenderPipelineAsync(descriptor);
        if (!result.ok) throw result.error;
        return { layout, pipeline: result.value };
      }),
    );
  }
  await Promise.all(work.map((start) => start()));
  // A module can be invalidated while native PSOs settle. Such a generation
  // must not publish ready, even when the stale compilation succeeded.
  if (!context.deviceScope.isAlive()) throw unavailable('retired device scope');
  for (const { label, entry } of prepared) {
    if (!sameWitness(entry, witness(context, entry.source, label)))
      throw unavailable(`${label} module changed during preparation`);
  }
}

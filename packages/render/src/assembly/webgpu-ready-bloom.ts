// Generation-owned multiscale Bloom pipelines. One level-parameterized
// horizontal PSO, one vertical Gaussian PSO and one composite PSO are built on
// first admission into a candidate scope; the render graph owns the five
// horizontal and five vertical targets. Candidates commit after a successful
// submission and retire behind that submission's queue completion.

import type { CompiledRenderGraphInfo } from '@forgeax/engine-render-graph';
import type { RenderPipeline, RhiDevice } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { GPU_SHADER_STAGE_FRAGMENT } from '../gpu-stage';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from '../gpu-usage';
import { type BloomInspection, emptyBloomInspection } from '../inspection-types';
import type { DeviceScope, RhiErrorListenerRegistry } from '../lifecycle';
import { inspectStandardBloomGraph } from '../pipeline/standard-post';
import type { PipelineCache, PipelineDeviceProvider } from '../pipeline-spec';
import type { BloomFrameReceipts } from '../record/frame-snapshot';
import type { BloomPersistentBundle, PerPassResources } from '../record/render-context';
import { runShimSyncStep } from './renderer-helpers';
import {
  BLOOM_COMPOSITE_PARAMS_BYTES,
  BLOOM_HORIZONTAL_PARAMS_BYTES,
  BLOOM_VERTICAL_PARAMS_BYTES,
  HDR_COLOR_ATTACHMENT_FORMAT,
} from './webgpu-ready-contract';
import { buildPipelineOrThrow, fullscreenPipelineSpec } from './webgpu-ready-passes';
import type { EngineShaderModules } from './webgpu-ready-shaders';

type BloomModule = NonNullable<EngineShaderModules['bloomHorizontal']>;

type BloomResourceOwner = Required<
  Pick<
    PerPassResources,
    | 'ensureBloomResources'
    | 'getBloomResources'
    | 'commitBloomResources'
    | 'commitBloomFrameReceipts'
    | 'discardBloomResources'
    | 'retireBloomResources'
    | 'drainBloomResources'
    | 'inspectBloomResources'
  >
>;

interface BloomPass {
  readonly pipeline: RenderPipeline;
  readonly bindGroupLayout: NonNullable<BloomPersistentBundle['bloomHorizontalBindGroupLayout']>;
  readonly paramsBuffer: NonNullable<BloomPersistentBundle['bloomHorizontalParamsBuffer']>;
}

const NO_BLOOM_PASS = { pipeline: null, bindGroupLayout: null, paramsBuffer: null } as const;

/** Source textures, then one filtering sampler, then the pass parameter UBO. */
function bloomBindGroupLayoutEntries(textureCount: number): GPUBindGroupLayoutEntry[] {
  return [
    ...Array.from({ length: textureCount }, (_, binding) => ({
      binding,
      visibility: GPU_SHADER_STAGE_FRAGMENT,
      texture: { sampleType: 'float' as const, viewDimension: '2d' as const },
    })),
    {
      binding: textureCount,
      visibility: GPU_SHADER_STAGE_FRAGMENT,
      sampler: { type: 'filtering' },
    },
    {
      binding: textureCount + 1,
      visibility: GPU_SHADER_STAGE_FRAGMENT,
      buffer: { type: 'uniform' },
    },
  ];
}

/** Build one Bloom pass (layout, pipeline and parameter UBO) inside the candidate scope. */
function createBloomPass(
  device: RhiDevice,
  provider: PipelineDeviceProvider,
  cache: PipelineCache,
  scope: DeviceScope,
  name: 'bloom-horizontal' | 'bloom-vertical' | 'bloom-composite',
  module: BloomModule,
  textureCount: number,
  paramsBytes: number,
): BloomPass {
  const bindGroupLayout = runShimSyncStep(
    () =>
      device.createBindGroupLayout({
        label: `${name}-bgl`,
        entries: bloomBindGroupLayoutEntries(textureCount),
      }),
    'webgpu-runtime-error',
    `createBindGroupLayout(${name}) succeeded`,
    'check device.limits.maxBindGroupsPerPipelineLayout',
  );
  if (!bindGroupLayout.ok) throw bindGroupLayout.error;
  scope._adopt('binding', bindGroupLayout.value, () => undefined);
  const layout = runShimSyncStep(
    () =>
      device.createPipelineLayout({
        label: `${name}-pl`,
        bindGroupLayouts: [bindGroupLayout.value],
      }),
    'webgpu-runtime-error',
    `createPipelineLayout(${name}) succeeded`,
    `verify ${name} BindGroupLayout matches shader @group(0) bindings`,
  );
  if (!layout.ok) throw layout.error;
  scope._adopt('binding', layout.value, () => undefined);
  const pipeline = buildPipelineOrThrow(
    fullscreenPipelineSpec(
      `forgeax::post::${name}`,
      'post-process',
      HDR_COLOR_ATTACHMENT_FORMAT,
      1,
    ),
    provider,
    cache,
    { vertex: module, fragment: module, layout: layout.value },
    `createRenderPipeline (${name} fullscreen) failed; inspect gpuMessage`,
  );
  scope._adopt('pipeline', pipeline, () => undefined);
  const paramsBuffer = runShimSyncStep(
    () =>
      device.createBuffer({
        label: `${name}-params-ubo`,
        size: paramsBytes,
        usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
        mappedAtCreation: false,
      }),
    'webgpu-runtime-error',
    `createBuffer (${name} params UBO) succeeded`,
    'check device.limits.maxUniformBufferBindingSize',
  );
  if (!paramsBuffer.ok) throw paramsBuffer.error;
  scope._adopt('buffer', paramsBuffer.value, (value) => {
    device.destroyBuffer(value);
  });
  return { pipeline, bindGroupLayout: bindGroupLayout.value, paramsBuffer: paramsBuffer.value };
}

/** Shared linear clamp sampler: every pass samples through fullscreen-triangle UVs. */
function createBloomSampler(device: RhiDevice, scope: DeviceScope) {
  const sampler = runShimSyncStep(
    () =>
      device.createSampler({
        label: 'bloom-sampler',
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      }),
    'webgpu-runtime-error',
    'createSampler (bloom) succeeded',
    'check device.limits.maxSamplersPerShaderStage',
  );
  if (!sampler.ok) throw sampler.error;
  scope._adopt('binding', sampler.value, () => undefined);
  return sampler.value;
}

/** Build every compiled Bloom pass into a fresh candidate bundle; partial failure throws. */
function buildBloomBundle(
  device: RhiDevice,
  provider: PipelineDeviceProvider,
  cache: PipelineCache,
  scope: DeviceScope,
  modules: EngineShaderModules,
  generation: number,
): BloomPersistentBundle {
  const { bloomHorizontal, bloomVertical, bloomComposite } = modules;
  const anyPass = bloomHorizontal !== null || bloomVertical !== null || bloomComposite !== null;
  const sampler = anyPass ? createBloomSampler(device, scope) : null;
  const horizontal =
    bloomHorizontal === null
      ? NO_BLOOM_PASS
      : createBloomPass(
          device,
          provider,
          cache,
          scope,
          'bloom-horizontal',
          bloomHorizontal,
          1,
          BLOOM_HORIZONTAL_PARAMS_BYTES,
        );
  const vertical =
    bloomVertical === null
      ? NO_BLOOM_PASS
      : createBloomPass(
          device,
          provider,
          cache,
          scope,
          'bloom-vertical',
          bloomVertical,
          1,
          BLOOM_VERTICAL_PARAMS_BYTES,
        );
  const composite =
    bloomComposite === null
      ? NO_BLOOM_PASS
      : createBloomPass(
          device,
          provider,
          cache,
          scope,
          'bloom-composite',
          bloomComposite,
          6,
          BLOOM_COMPOSITE_PARAMS_BYTES,
        );
  return {
    scope,
    generation,
    bloomHorizontalPipeline: horizontal.pipeline,
    bloomVerticalPipeline: vertical.pipeline,
    bloomCompositePipeline: composite.pipeline,
    bloomHorizontalBindGroupLayout: horizontal.bindGroupLayout,
    bloomVerticalBindGroupLayout: vertical.bindGroupLayout,
    bloomCompositeBindGroupLayout: composite.bindGroupLayout,
    bloomSampler: sampler,
    bloomHorizontalParamsBuffer: horizontal.paramsBuffer,
    bloomVerticalParamsBuffer: vertical.paramsBuffer,
    bloomCompositeParamsBuffer: composite.paramsBuffer,
  };
}

function reportBloomFenceFailure(errorRegistry: RhiErrorListenerRegistry, cause: unknown): void {
  if (cause instanceof RhiError) {
    errorRegistry.fire(cause);
    return;
  }
  errorRegistry.fire(
    new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'Bloom queue completion resolves after the submitted frame retires',
      hint: 'inspect renderer errors for the queue completion cause',
      detail: {
        error: {
          code: 'bloom-fence-rejected',
          message: String(cause),
          ...(cause instanceof Error ? { name: cause.name } : {}),
        },
      },
    }),
  );
}

/** A retiring generation still owns resources but no longer contributes graph work. */
function retiringBloomInspection(resourceCount: number, generation: number): BloomInspection {
  return { ...emptyBloomInspection(), resourceCount, generation, state: 'retiring' };
}

/**
 * The graph owns target allocations: an active generation reports the
 * validated descriptor byte sum, and zero only for an absent/invalid graph.
 */
function activeBloomInspection(
  graph: CompiledRenderGraphInfo | undefined,
  receipts: BloomFrameReceipts | undefined,
  resourceCount: number,
  generation: number,
): BloomInspection {
  const inspection = inspectStandardBloomGraph(graph);
  return {
    graphStatus: inspection.status,
    enabled: true,
    levelCount: inspection.levelCount,
    levelDimensions: inspection.levelDimensions,
    horizontalPassCount: inspection.horizontalPassCount,
    verticalPassCount: inspection.verticalPassCount,
    targetCount: inspection.targetCount,
    targetBytes: inspection.targetBytes,
    resourceCount,
    passCount: inspection.passCount,
    encodeCount: receipts?.encodeCount ?? 0,
    bindGroupCount: receipts?.bindGroupCount ?? 0,
    uploadCount: receipts?.uploadCount ?? 0,
    residentChildBytes: inspection.status !== 'valid' ? 0 : inspection.targetBytes,
    generation,
    state: 'active',
  };
}

/**
 * Candidate/active/retiring Bloom generations for one renderer generation.
 * Bloom builds only when the boot material modules exist (`enabled`); commit,
 * discard and drain act only on the latest successfully built candidate scope.
 */
export function createBloomResourceOwner(
  device: RhiDevice,
  rendererScope: DeviceScope,
  errorRegistry: RhiErrorListenerRegistry,
  provider: PipelineDeviceProvider,
  cache: PipelineCache,
  modules: EngineShaderModules,
  enabled: boolean,
): BloomResourceOwner {
  let ready = false;
  let active: BloomPersistentBundle | undefined;
  let candidate: BloomPersistentBundle | undefined;
  let armedScope: DeviceScope | undefined;
  let generation = 0;
  let lastReceipts: BloomFrameReceipts | undefined;
  const retiring = new Set<BloomPersistentBundle>();

  const retireAfter = (bundle: BloomPersistentBundle, completion: Promise<unknown>): void => {
    const finish = (): void => {
      bundle.scope.retire();
      retiring.delete(bundle);
    };
    void completion.then(
      () => {
        if (retiring.has(bundle)) finish();
      },
      (cause) => {
        if (!retiring.has(bundle)) return;
        reportBloomFenceFailure(errorRegistry, cause);
        finish();
      },
    );
  };

  return {
    ensureBloomResources: () => {
      if (!enabled || ready) return;
      const scope = rendererScope.createChild(`${rendererScope.owner}:standard-bloom`);
      try {
        candidate = buildBloomBundle(device, provider, cache, scope, modules, generation + 1);
        armedScope = scope;
      } catch (cause) {
        scope.abandon();
        if (candidate?.scope === scope) candidate = undefined;
        armedScope = undefined;
        throw cause;
      }
    },
    getBloomResources: () => candidate ?? active ?? null,
    commitBloomResources: () => {
      if (armedScope === undefined || candidate?.scope !== armedScope) return;
      active = candidate;
      candidate = undefined;
      generation += 1;
      ready = true;
    },
    commitBloomFrameReceipts: (receipts) => {
      lastReceipts = receipts;
    },
    discardBloomResources: () => {
      if (armedScope === undefined || candidate?.scope !== armedScope) return;
      armedScope.abandon();
      candidate = undefined;
      ready = false;
    },
    retireBloomResources: (completion) => {
      const bundle = active;
      if (bundle === undefined) return;
      active = undefined;
      ready = false;
      retiring.add(bundle);
      bundle.scope.beginRetire();
      retireAfter(bundle, completion);
    },
    drainBloomResources: () => {
      if (armedScope === undefined) return;
      candidate?.scope.abandon();
      candidate = undefined;
      active?.scope.retire();
      active = undefined;
      for (const bundle of retiring) bundle.scope.retire();
      retiring.clear();
      ready = false;
    },
    inspectBloomResources: (graph) => {
      const live = [...retiring]
        .sort((left, right) => left.generation - right.generation)
        .filter((bundle) => bundle.scope.state === 'retiring');
      const current = active?.scope.isAlive() ? active : undefined;
      const selected = current ?? live[live.length - 1];
      if (selected === undefined) return emptyBloomInspection();
      const owned = current === undefined ? live : [current, ...live];
      const resourceCount = owned.reduce(
        (count, bundle) => count + bundle.scope.resourceDelta(),
        0,
      );
      return current === undefined
        ? retiringBloomInspection(resourceCount, selected.generation)
        : activeBloomInspection(graph, lastReceipts, resourceCount, selected.generation);
    },
  };
}

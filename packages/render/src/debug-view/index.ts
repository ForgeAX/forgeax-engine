import type { RenderGraphBuilder, RenderGraphError } from '@forgeax/engine-render-graph';
import {
  type BindGroup,
  type BindGroupLayout,
  type Buffer,
  type RenderPipeline,
  type RhiDevice,
  RhiError,
  type Sampler,
  type Texture,
  type TextureFormat,
  type TextureView,
} from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import { isMultisampleAntialias, isTemporalAntialias } from '../components/camera';
import type { DeviceScope } from '../device/device-scope';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from '../gpu-usage';
import { supportsStandardDeferred } from '../pipeline/standard-deferred-capability';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import type { RenderPipelineFrame } from '../render-pipeline';
import {
  isViewportOutputMode,
  type ViewportOutputCaveat,
  type ViewportOutputExtension,
  type ViewportOutputLightingOnlyInput,
  type ViewportOutputMode,
  type ViewportOutputResolution,
  type ViewportOutputResolveInput,
  type ViewportOutputTopologyBucket,
  type ViewportOutputVisualizerInput,
} from '../viewport-output-contract';
import {
  VIEWPORT_GBUFFER_VISUALIZER_WGSL,
  VIEWPORT_LIGHTING_ONLY_OVERRIDE_WGSL,
} from './visualizer-wgsl';

const MODE_INDEX: Readonly<Record<Exclude<ViewportOutputMode, 'lit' | 'lighting-only'>, number>> = {
  'base-color': 1,
  'world-normal': 2,
  'geometric-normal': 3,
  metallic: 4,
  roughness: 5,
  'material-ao': 6,
  'screen-ao': 7,
  emissive: 8,
  depth: 9,
  overview: 10,
};

function topologyBucketForMode(mode: ViewportOutputMode): ViewportOutputTopologyBucket | undefined {
  switch (mode) {
    case 'lit':
      return undefined;
    case 'screen-ao':
      return 'surface-with-ao';
    case 'lighting-only':
      return 'lighting-only';
    case 'overview':
      return 'overview';
    default:
      return 'surface-only';
  }
}

interface VisualizerGpuCache {
  readonly layout: BindGroupLayout;
  readonly pipeline: RenderPipeline;
  readonly uniformBuffer: Buffer;
  readonly sampler: Sampler;
  readonly dummyU32Texture: Texture;
  readonly dummyU32View: TextureView;
  readonly dummyWhiteTexture: Texture;
  readonly dummyWhiteView: TextureView;
  readonly outputFormat: TextureFormat;
  lastKey?: string;
  lastBindGroup?: BindGroup;
}

interface LightingOnlyGpuCache {
  readonly layout: BindGroupLayout;
  readonly pipeline: RenderPipeline;
  readonly uniformBuffer: Buffer;
  readonly sceneFormat: TextureFormat;
  readonly albedoFormat: TextureFormat;
  readonly specularFormat: TextureFormat;
  lastKey?: string;
  lastBindGroup?: BindGroup;
}

const visualizerCaches = new WeakMap<DeviceScope, Map<string, VisualizerGpuCache>>();
const lightingOnlyCaches = new WeakMap<DeviceScope, Map<string, LightingOnlyGpuCache>>();
const viewKeyIds = new WeakMap<object, number>();
let nextViewKeyId = 1;

function objectId(value: object): number {
  let id = viewKeyIds.get(value);
  if (id === undefined) {
    id = nextViewKeyId++;
    viewKeyIds.set(value, id);
  }
  return id;
}

type ShaderModuleFactoryLike = NonNullable<
  _InternalRenderPipelineContext['runtime']['shaderModuleFactory']
>;

function requireShaderModuleFactory(
  internal: _InternalRenderPipelineContext,
): ShaderModuleFactoryLike {
  const factory =
    internal.runtime.immediateShaderModuleFactory ?? internal.runtime.shaderModuleFactory;
  if (factory === undefined) {
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'a shader module factory for viewport debug visualization',
      hint: 'construct the renderer through its backend pack',
    });
  }
  return factory;
}

function getOrCreateVisualizerCache(
  device: RhiDevice,
  factory: ShaderModuleFactoryLike,
  scope: DeviceScope,
  outputFormat: TextureFormat,
): VisualizerGpuCache {
  let byFormat = visualizerCaches.get(scope);
  if (byFormat === undefined) {
    const owned = new Map<string, VisualizerGpuCache>();
    byFormat = owned;
    visualizerCaches.set(scope, owned);
    scope._adopt('pipeline', owned, () => {
      for (const entry of owned.values()) {
        device.destroyBuffer(entry.uniformBuffer);
        device.destroyTexture(entry.dummyU32Texture);
        device.destroyTexture(entry.dummyWhiteTexture);
      }
      visualizerCaches.delete(scope);
    });
  }
  const existing = byFormat.get(outputFormat);
  if (existing !== undefined) return existing;

  const module = factory
    .createShaderModule({
      label: 'viewport-debug-visualizer',
      code: VIEWPORT_GBUFFER_VISUALIZER_WGSL,
    })
    .unwrap();

  const layout = device
    .createBindGroupLayout({
      label: 'viewport-debug-visualizer-bgl',
      entries: [
        { binding: 0, visibility: 2, buffer: { type: 'uniform', minBindingSize: 48 } },
        { binding: 1, visibility: 2, texture: { sampleType: 'uint', viewDimension: '2d' } },
        { binding: 2, visibility: 2, texture: { sampleType: 'uint', viewDimension: '2d' } },
        { binding: 3, visibility: 2, texture: { sampleType: 'uint', viewDimension: '2d' } },
        {
          binding: 4,
          visibility: 2,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
        { binding: 5, visibility: 2, texture: { sampleType: 'uint', viewDimension: '2d' } },
        { binding: 6, visibility: 2, texture: { sampleType: 'depth', viewDimension: '2d' } },
        { binding: 7, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 8, visibility: 2, sampler: { type: 'filtering' } },
        {
          binding: 9,
          visibility: 2,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
      ],
    })
    .unwrap();

  const pipelineLayout = device
    .createPipelineLayout({
      label: 'viewport-debug-visualizer-pl',
      bindGroupLayouts: [layout],
    })
    .unwrap();

  const pipeline = device
    .createRenderPipeline({
      label: 'viewport-debug-visualizer-pso',
      layout: pipelineLayout,
      vertex: { module, entryPoint: 'vs_main', buffers: [] },
      fragment: {
        module,
        entryPoint: 'fs_main',
        targets: [{ format: outputFormat }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    })
    .unwrap();

  const uniformBuffer = device
    .createBuffer({
      label: 'viewport-debug-visualizer-ubo',
      size: 48,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();

  const sampler = device
    .createSampler({
      label: 'viewport-debug-visualizer-sampler',
      minFilter: 'linear',
      magFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    })
    .unwrap();

  const dummyU32Texture = device
    .createTexture({
      label: 'viewport-debug-dummy-u32',
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      format: 'rg32uint',
      usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING | GPU_TEXTURE_USAGE_COPY_DST,
    })
    .unwrap();
  const dummyU32View = device.createTextureView(dummyU32Texture, { dimension: '2d' }).unwrap();

  const dummyWhiteTexture = device
    .createTexture({
      label: 'viewport-debug-dummy-white',
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING | GPU_TEXTURE_USAGE_COPY_DST,
    })
    .unwrap();
  device.queue.writeTexture(
    { texture: dummyWhiteTexture },
    new Uint8Array([255, 255, 255, 255]),
    { bytesPerRow: 256, rowsPerImage: 1 },
    { width: 1, height: 1, depthOrArrayLayers: 1 },
  );
  const dummyWhiteView = device.createTextureView(dummyWhiteTexture, { dimension: '2d' }).unwrap();

  const cache: VisualizerGpuCache = {
    layout,
    pipeline,
    uniformBuffer,
    sampler,
    dummyU32Texture,
    dummyU32View,
    dummyWhiteTexture,
    dummyWhiteView,
    outputFormat,
  };
  byFormat.set(outputFormat, cache);
  return cache;
}

function getOrCreateLightingOnlyCache(
  device: RhiDevice,
  factory: ShaderModuleFactoryLike,
  scope: DeviceScope,
  sceneFormat: TextureFormat,
  albedoFormat: TextureFormat,
  specularFormat: TextureFormat,
): LightingOnlyGpuCache {
  let byKey = lightingOnlyCaches.get(scope);
  if (byKey === undefined) {
    const owned = new Map<string, LightingOnlyGpuCache>();
    byKey = owned;
    lightingOnlyCaches.set(scope, owned);
    scope._adopt('pipeline', owned, () => {
      for (const entry of owned.values()) {
        device.destroyBuffer(entry.uniformBuffer);
      }
      lightingOnlyCaches.delete(scope);
    });
  }
  const cacheKey = `${sceneFormat}:${albedoFormat}:${specularFormat}`;
  const existing = byKey.get(cacheKey);
  if (existing !== undefined) return existing;

  const module = factory
    .createShaderModule({
      label: 'viewport-debug-lighting-only',
      code: VIEWPORT_LIGHTING_ONLY_OVERRIDE_WGSL,
    })
    .unwrap();

  const layout = device
    .createBindGroupLayout({
      label: 'viewport-debug-lighting-only-bgl',
      entries: [
        { binding: 0, visibility: 2, buffer: { type: 'uniform', minBindingSize: 16 } },
        { binding: 1, visibility: 2, texture: { sampleType: 'uint', viewDimension: '2d' } },
        { binding: 2, visibility: 2, texture: { sampleType: 'uint', viewDimension: '2d' } },
        { binding: 3, visibility: 2, texture: { sampleType: 'uint', viewDimension: '2d' } },
        {
          binding: 4,
          visibility: 2,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
      ],
    })
    .unwrap();

  const pipelineLayout = device
    .createPipelineLayout({
      label: 'viewport-debug-lighting-only-pl',
      bindGroupLayouts: [layout],
    })
    .unwrap();

  const pipeline = device
    .createRenderPipeline({
      label: 'viewport-debug-lighting-only-pso',
      layout: pipelineLayout,
      vertex: { module, entryPoint: 'vs_main', buffers: [] },
      fragment: {
        module,
        entryPoint: 'fs_main',
        targets: [{ format: sceneFormat }, { format: albedoFormat }, { format: specularFormat }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    })
    .unwrap();

  const uniformBuffer = device
    .createBuffer({
      label: 'viewport-debug-lighting-only-ubo',
      size: 16,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();

  const cache: LightingOnlyGpuCache = {
    layout,
    pipeline,
    uniformBuffer,
    sceneFormat,
    albedoFormat,
    specularFormat,
  };
  byKey.set(cacheKey, cache);
  return cache;
}

const SCRATCH_UBO_BYTES = new ArrayBuffer(48);
const SCRATCH_UBO_U32 = new Uint32Array(SCRATCH_UBO_BYTES);
const SCRATCH_UBO_F32 = new Float32Array(SCRATCH_UBO_BYTES);
const SCRATCH_OVERRIDE_U32 = new Uint32Array(4);

function writeVisualizerUniforms(
  device: RhiDevice,
  uniformBuffer: Buffer,
  internal: _InternalRenderPipelineContext,
  currentMode: ViewportOutputMode,
  input: ViewportOutputVisualizerInput,
): void {
  const modeIndex =
    currentMode === 'lit' || currentMode === 'lighting-only'
      ? MODE_INDEX['base-color']
      : MODE_INDEX[currentMode];
  const flags =
    (input.compact ? 1 : 0) |
    (input.hasScreenAo && input.screenAo !== undefined ? 2 : 0) |
    (input.hasReceiverGeometry && input.receiverGeometry !== undefined ? 4 : 0) |
    (input.hasLitColor && input.emissiveCopy !== undefined ? 8 : 0);

  SCRATCH_UBO_U32[0] = modeIndex;
  SCRATCH_UBO_U32[1] = flags;
  SCRATCH_UBO_U32[2] = Math.max(1, internal.targetW);
  SCRATCH_UBO_U32[3] = Math.max(1, internal.targetH);

  const camera = internal.camera;
  const rawFar = camera?.far ?? 2000;
  const isOrtho = camera?.projection === 'orthographic';
  SCRATCH_UBO_F32[4] = camera?.near ?? 0.1;
  SCRATCH_UBO_F32[5] = Number.isFinite(rawFar) ? rawFar : 2000;
  SCRATCH_UBO_F32[6] = isOrtho ? 1 : 0;
  SCRATCH_UBO_F32[7] = !isOrtho && !Number.isFinite(rawFar) ? 1 : 0;
  SCRATCH_UBO_F32[8] = 0.12;
  SCRATCH_UBO_F32[9] = camera?.exposure ?? 1.0;
  SCRATCH_UBO_F32[10] = 0;
  SCRATCH_UBO_F32[11] = 0;

  device.queue.writeBuffer(uniformBuffer, 0, SCRATCH_UBO_BYTES);
}

function resolveVisualizerBindGroup(
  device: RhiDevice,
  cache: VisualizerGpuCache,
  resources: Parameters<
    NonNullable<
      Parameters<RenderGraphBuilder<RenderPipelineFrame>['addRasterPass']>[1]['encodeDirect']
    >
  >[2],
  input: ViewportOutputVisualizerInput,
): BindGroup {
  const normalView = resources.textureView(input.normalRoughness.view).unwrap();
  const albedoView = resources.textureView(input.albedoMetallic.view).unwrap();
  const specView = resources.textureView(input.dielectricSpecular.view).unwrap();
  const sceneView = resources.textureView(input.sceneColor.view).unwrap();
  const receiverView =
    input.receiverGeometry === undefined
      ? cache.dummyU32View
      : resources.textureView(input.receiverGeometry.view).unwrap();
  const depthView = resources.textureView(input.depth).unwrap();
  const screenAoView =
    input.screenAo === undefined
      ? cache.dummyWhiteView
      : resources.textureView(input.screenAo.view).unwrap();
  const emissiveView =
    input.emissiveCopy === undefined
      ? sceneView
      : resources.textureView(input.emissiveCopy.view).unwrap();

  const key = `${objectId(normalView)}:${objectId(albedoView)}:${objectId(specView)}:${objectId(sceneView)}:${objectId(receiverView)}:${objectId(depthView)}:${objectId(screenAoView)}:${objectId(emissiveView)}`;
  if (cache.lastKey !== key || cache.lastBindGroup === undefined) {
    cache.lastKey = key;
    cache.lastBindGroup = device
      .createBindGroup({
        layout: cache.layout,
        entries: [
          { binding: 0, resource: { kind: 'buffer', value: { buffer: cache.uniformBuffer } } },
          { binding: 1, resource: { kind: 'textureView', value: normalView } },
          { binding: 2, resource: { kind: 'textureView', value: albedoView } },
          { binding: 3, resource: { kind: 'textureView', value: specView } },
          { binding: 4, resource: { kind: 'textureView', value: sceneView } },
          { binding: 5, resource: { kind: 'textureView', value: receiverView } },
          { binding: 6, resource: { kind: 'textureView', value: depthView } },
          { binding: 7, resource: { kind: 'textureView', value: screenAoView } },
          { binding: 8, resource: { kind: 'sampler', value: cache.sampler } },
          { binding: 9, resource: { kind: 'textureView', value: emissiveView } },
        ],
      })
      .unwrap();
  }
  return cache.lastBindGroup;
}

/**
 * Create a self-contained viewport debug-visualization extension.
 *
 * When `mode === 'lit'`, no GPU resources or pipelines are created and the
 * renderer runs its unmodified Standard pipeline.
 */
export function createViewportOutputExtension(
  initialMode: ViewportOutputMode = 'lit',
): ViewportOutputExtension {
  let currentMode: ViewportOutputMode = isViewportOutputMode(initialMode) ? initialMode : 'lit';

  return {
    kind: 'viewport-output-extension/1',
    getMode(): ViewportOutputMode {
      return currentMode;
    },
    setMode(mode: ViewportOutputMode): void {
      if (!isViewportOutputMode(mode)) {
        throw new RangeError(`Unsupported viewport output mode: ${String(mode)}`);
      }
      currentMode = mode;
    },
    resolveView(input: ViewportOutputResolveInput): ViewportOutputResolution {
      if (currentMode === 'lit') {
        return {
          enabled: true,
          requestedMode: 'lit',
          effectiveMode: 'lit',
          activePath: 'native',
          caveats: [],
          suspendMsaa: false,
          suspendTemporalAa: false,
        };
      }

      const deferredCapable = supportsStandardDeferred(
        input.deviceCaps,
        input.deviceLimits.maxColorAttachmentBytesPerSample,
      );
      if (!deferredCapable) {
        return {
          enabled: true,
          requestedMode: currentMode,
          effectiveMode: 'lit',
          activePath: 'unavailable',
          unavailableReason: 'device-lacks-gbuffer',
          caveats: [],
          suspendMsaa: false,
          suspendTemporalAa: false,
        };
      }

      const caveats: ViewportOutputCaveat[] = ['forward-only-omitted'];
      const suspendMsaa = isMultisampleAntialias(input.antialias);
      if (suspendMsaa) caveats.push('msaa-suspended-for-gbuffer');
      if (currentMode === 'roughness' || currentMode === 'overview') {
        caveats.push('roughness-includes-specular-aa');
      }
      if (
        (currentMode === 'screen-ao' || currentMode === 'overview') &&
        !input.ambientOcclusionEnabled
      ) {
        caveats.push('screen-ao-disabled');
      }
      if (
        currentMode === 'geometric-normal' &&
        input.compactGbuffer &&
        !input.hasReceiverGeometry
      ) {
        caveats.push('geometric-normal-unavailable-in-compact-gbuffer');
      }

      const suspendTemporalAa = isTemporalAntialias(input.antialias);

      return {
        enabled: true,
        requestedMode: currentMode,
        effectiveMode: currentMode,
        activePath: 'gbuffer-visualizer',
        topologyBucket: topologyBucketForMode(currentMode),
        caveats,
        suspendMsaa,
        suspendTemporalAa,
      };
    },

    addLightingOnlyOverridePass(
      graph: RenderGraphBuilder<RenderPipelineFrame>,
      input: ViewportOutputLightingOnlyInput,
    ): Result<void, RenderGraphError> {
      const pass = graph.addRasterPass('viewport-debug-lighting-only-override', {
        accesses: [
          { resource: input.normalRoughness.view, usage: 'sampled-read' },
          { resource: input.albedoMetallic.view, usage: 'sampled-read' },
          { resource: input.dielectricSpecular.view, usage: 'sampled-read' },
          { resource: input.scene.view, usage: 'sampled-read' },
          { resource: input.outScene.view, usage: 'color-attachment' },
          { resource: input.outAlbedoMetallic.view, usage: 'color-attachment' },
          { resource: input.outDielectricSpecular.view, usage: 'color-attachment' },
        ],
        colorAttachments: [
          {
            view: input.outScene.view,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 1],
          },
          {
            view: input.outAlbedoMetallic.view,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 0],
          },
          {
            view: input.outDielectricSpecular.view,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 0],
          },
        ],
        encodeDirect(encoder, frame, resources) {
          const internal = frame as _InternalRenderPipelineContext;
          const device = internal.runtime.device;
          const scope = internal.runtime.deviceScope;
          const cache = getOrCreateLightingOnlyCache(
            device,
            requireShaderModuleFactory(internal),
            scope,
            input.outScene.format,
            input.outAlbedoMetallic.format,
            input.outDielectricSpecular.format,
          );
          SCRATCH_OVERRIDE_U32[0] = input.compact ? 1 : 0;
          SCRATCH_OVERRIDE_U32[1] = 0;
          SCRATCH_OVERRIDE_U32[2] = 0;
          SCRATCH_OVERRIDE_U32[3] = 0;
          device.queue.writeBuffer(cache.uniformBuffer, 0, SCRATCH_OVERRIDE_U32);

          const normalView = resources.textureView(input.normalRoughness.view).unwrap();
          const albedoView = resources.textureView(input.albedoMetallic.view).unwrap();
          const specView = resources.textureView(input.dielectricSpecular.view).unwrap();
          const sceneView = resources.textureView(input.scene.view).unwrap();
          const key = `${objectId(normalView)}:${objectId(albedoView)}:${objectId(specView)}:${objectId(sceneView)}`;
          if (cache.lastKey !== key || cache.lastBindGroup === undefined) {
            cache.lastKey = key;
            cache.lastBindGroup = device
              .createBindGroup({
                layout: cache.layout,
                entries: [
                  {
                    binding: 0,
                    resource: { kind: 'buffer', value: { buffer: cache.uniformBuffer } },
                  },
                  { binding: 1, resource: { kind: 'textureView', value: normalView } },
                  { binding: 2, resource: { kind: 'textureView', value: albedoView } },
                  { binding: 3, resource: { kind: 'textureView', value: specView } },
                  { binding: 4, resource: { kind: 'textureView', value: sceneView } },
                ],
              })
              .unwrap();
          }

          encoder.setPipeline(cache.pipeline);
          encoder.setBindGroup(0, cache.lastBindGroup);
          encoder.draw(3);
        },
      });
      return pass.ok ? ok(undefined) : pass;
    },

    addVisualizerPass(
      graph: RenderGraphBuilder<RenderPipelineFrame>,
      input: ViewportOutputVisualizerInput,
    ): Result<void, RenderGraphError> {
      const accesses: import('@forgeax/engine-render-graph').GraphAccess[] = [
        { resource: input.normalRoughness.view, usage: 'sampled-read' },
        { resource: input.albedoMetallic.view, usage: 'sampled-read' },
        { resource: input.dielectricSpecular.view, usage: 'sampled-read' },
        { resource: input.sceneColor.view, usage: 'sampled-read' },
        { resource: input.depth, usage: 'sampled-read' },
        { resource: input.output.view, usage: 'color-attachment' },
      ];
      if (input.receiverGeometry !== undefined) {
        accesses.push({ resource: input.receiverGeometry.view, usage: 'sampled-read' });
      }
      if (input.screenAo !== undefined) {
        accesses.push({ resource: input.screenAo.view, usage: 'sampled-read' });
      }
      if (input.emissiveCopy !== undefined) {
        accesses.push({ resource: input.emissiveCopy.view, usage: 'sampled-read' });
      }

      const pass = graph.addRasterPass('viewport-debug-visualizer', {
        accesses,
        colorAttachments: [
          {
            view: input.output.view,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 1],
          },
        ],
        encodeDirect(encoder, frame, resources) {
          const internal = frame as _InternalRenderPipelineContext;
          const device = internal.runtime.device;
          const cache = getOrCreateVisualizerCache(
            device,
            requireShaderModuleFactory(internal),
            internal.runtime.deviceScope,
            input.output.format,
          );
          writeVisualizerUniforms(device, cache.uniformBuffer, internal, currentMode, input);
          const bindGroup = resolveVisualizerBindGroup(device, cache, resources, input);
          encoder.setPipeline(cache.pipeline);
          encoder.setBindGroup(0, bindGroup);
          encoder.draw(3);
        },
      });
      return pass.ok ? ok(undefined) : pass;
    },
  };
}

import type {
  BindGroup,
  BindGroupEntry,
  BindGroupLayout,
  BindGroupLayoutEntry,
  Buffer,
  ComputePipeline,
  RenderPipeline,
  Result,
  RhiCommandEncoder,
  RhiDevice,
  RhiError,
  Sampler,
  ShaderModule,
  Texture,
  TextureView,
} from '@forgeax/engine-rhi';
import { SKY_SH_WGSL } from '@forgeax/engine-shader';
import { shaderSourceDescriptor } from '@forgeax/engine-types';
import type { DeviceScope } from '../device/device-scope';
import { GPU_SHADER_STAGE_COMPUTE, GPU_SHADER_STAGE_FRAGMENT } from '../gpu-stage';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';

export const PACKED_VECTORS = 7;
const COEFFICIENT_BYTES = 16;
export const TILE_COUNT = 6 * 16 * 16;
export const REDUCE_WIDTH = 32;
export const SKY_SH_BYTES = PACKED_VECTORS * COEFFICIENT_BYTES;

export function constantSkySh(radiance: readonly [number, number, number]): Float32Array {
  const coefficients = new Float32Array(SKY_SH_BYTES / 4);
  coefficients[3] = radiance[0];
  coefficients[7] = radiance[1];
  coefficients[11] = radiance[2];
  return coefficients;
}

interface SkyShProjection {
  readonly coefficients: Buffer;
  record(encoder: RhiCommandEncoder): void;
}

interface SkyShPipeline<T> {
  readonly pipeline: T;
  readonly bindings: BindGroupLayout;
}

interface ComputeKernels {
  readonly kind: 'compute';
  readonly project: SkyShPipeline<ComputePipeline>;
  readonly reduce: SkyShPipeline<ComputePipeline>;
}
interface RasterKernels {
  readonly kind: 'raster';
  readonly project: SkyShPipeline<RenderPipeline>;
  readonly reduce: SkyShPipeline<RenderPipeline>;
  readonly finish: SkyShPipeline<RenderPipeline>;
}

type SkyShKernels = ComputeKernels | RasterKernels;
type SkyShModuleFactory = (desc: {
  readonly label?: string | undefined;
  readonly code: string;
}) => Result<ShaderModule, RhiError>;
const computeByScope = new WeakMap<DeviceScope, ComputeKernels>();
const rasterByScope = new WeakMap<DeviceScope, RasterKernels>();

function projectionBindings(visibility: number): BindGroupLayoutEntry[] {
  return [
    { binding: 0, visibility, texture: { sampleType: 'float', viewDimension: 'cube' } },
    { binding: 1, visibility, sampler: { type: 'filtering' } },
    { binding: 2, visibility, buffer: { type: 'uniform', minBindingSize: 16 } },
  ];
}

export function getKernels(
  device: RhiDevice,
  scope: DeviceScope,
  source: SkyShModuleFactory | ShaderModule,
  compute = device.caps.compute && device.caps.storageBuffer,
): SkyShKernels {
  const cache = compute ? computeByScope : rasterByScope;
  const cached = cache.get(scope);
  if (cached !== undefined) return cached;
  const module =
    typeof source === 'function'
      ? source(shaderSourceDescriptor(SKY_SH_WGSL, 'sky-sh')).unwrap()
      : source;
  if (compute) {
    const kernels = createComputeKernels(device, module);
    computeByScope.set(scope, kernels);
    return kernels;
  }
  const kernels = createRasterKernels(device, module);
  rasterByScope.set(scope, kernels);
  return kernels;
}

function createLayout(device: RhiDevice, label: string, entries: BindGroupLayoutEntry[]) {
  const layout = device.createBindGroupLayout({ label, entries }).unwrap();
  return {
    bindings: layout,
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
  };
}

function createComputeKernels(device: RhiDevice, module: ShaderModule): ComputeKernels {
  const visibility = GPU_SHADER_STAGE_COMPUTE;
  const scratch: BindGroupLayoutEntry = {
    binding: 4,
    visibility,
    buffer: { type: 'storage', minBindingSize: SKY_SH_BYTES * TILE_COUNT },
  };
  const make = (label: string, entryPoint: string, entries: BindGroupLayoutEntry[]) => {
    const { bindings, layout } = createLayout(device, label, entries);
    const pipeline = device
      .createComputePipeline({
        label,
        layout,
        compute: { module, entryPoint },
      })
      .unwrap();
    return { pipeline, bindings };
  };
  return {
    kind: 'compute',
    project: make('sky-sh-project', 'sky_sh_compute_project', [
      ...projectionBindings(visibility),
      scratch,
    ]),
    reduce: make('sky-sh-reduce', 'sky_sh_compute_reduce', [
      scratch,
      { binding: 5, visibility, buffer: { type: 'storage', minBindingSize: SKY_SH_BYTES } },
    ]),
  };
}

function createRasterKernels(device: RhiDevice, module: ShaderModule): RasterKernels {
  const visibility = GPU_SHADER_STAGE_FRAGMENT;
  const projection = createLayout(device, 'sky-sh-project', projectionBindings(visibility));
  const reduction = createLayout(device, 'sky-sh-reduce', [
    {
      binding: 3,
      visibility,
      texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
    },
  ]);
  const make = (label: string, entryPoint: string, { bindings, layout }: typeof projection) => {
    const pipeline = device
      .createRenderPipeline({
        label,
        layout,
        vertex: { module, entryPoint: 'sky_sh_fullscreen', buffers: [] },
        fragment: { module, entryPoint, targets: [{ format: 'rgba32float' }] },
        primitive: { topology: 'triangle-list' },
      })
      .unwrap();
    return { pipeline, bindings };
  };
  return {
    kind: 'raster',
    project: make('sky-sh-project', 'sky_sh_project', projection),
    reduce: make('sky-sh-reduce', 'sky_sh_reduce', reduction),
    finish: make('sky-sh-finish', 'sky_sh_finish', reduction),
  };
}

function buffer(device: RhiDevice, scope: DeviceScope, label: string, size: number, usage: number) {
  const value = device.createBuffer({ label, size, usage }).unwrap();
  scope._adopt('buffer', value, (buffer) => {
    device.destroyBuffer(buffer).unwrap();
  });
  return value;
}

export function bufferEntry(binding: number, buffer: Buffer): BindGroupEntry {
  return { binding, resource: { kind: 'buffer', value: { buffer } } };
}

export function group(
  device: RhiDevice,
  label: string,
  pipeline: SkyShPipeline<ComputePipeline | RenderPipeline>,
  entries: BindGroupEntry[],
): BindGroup {
  return device.createBindGroup({ label, layout: pipeline.bindings, entries }).unwrap();
}

/** Coefficients are owned by the environment generation. Scratch can retire once its submission completes. */
export function prepareSkyShProjection(
  device: RhiDevice,
  pipelineScope: DeviceScope,
  scope: DeviceScope,
  scratchScope: DeviceScope,
  source: TextureView,
  sampler: Sampler,
  cameraCube: boolean,
  module: SkyShModuleFactory | ShaderModule,
): SkyShProjection {
  const kernels = getKernels(device, pipelineScope, module);
  const parameters = buffer(
    device,
    scratchScope,
    'sky-sh-projection-parameters',
    16,
    GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
  );
  device.queue.writeBuffer(parameters, 0, new Uint32Array([Number(cameraCube), 0, 0, 0])).unwrap();
  const inputs: BindGroupEntry[] = [
    { binding: 0, resource: { kind: 'textureView', value: source } },
    { binding: 1, resource: { kind: 'sampler', value: sampler } },
    bufferEntry(2, parameters),
  ];
  const coefficients = buffer(
    device,
    scope,
    'sky-sh-coefficients',
    SKY_SH_BYTES,
    GPU_BUFFER_USAGE_UNIFORM |
      GPU_BUFFER_USAGE_COPY_SRC |
      (kernels.kind === 'compute' ? GPU_BUFFER_USAGE_STORAGE : GPU_BUFFER_USAGE_COPY_DST),
  );

  if (kernels.kind === 'compute') {
    const scratch = buffer(
      device,
      scratchScope,
      'sky-sh-partials',
      SKY_SH_BYTES * TILE_COUNT,
      GPU_BUFFER_USAGE_STORAGE,
    );
    const project = group(device, 'sky-sh-project', kernels.project, [
      ...inputs,
      bufferEntry(4, scratch),
    ]);
    const reduce = group(device, 'sky-sh-reduce', kernels.reduce, [
      bufferEntry(4, scratch),
      bufferEntry(5, coefficients),
    ]);
    return {
      coefficients,
      record(encoder) {
        const projection = encoder.beginComputePass({ label: 'sky-sh-project' });
        projection.setPipeline(kernels.project.pipeline);
        projection.setBindGroup(0, project);
        projection.dispatchWorkgroups(Math.ceil((PACKED_VECTORS * TILE_COUNT) / 64));
        projection.end();
        const reduction = encoder.beginComputePass({ label: 'sky-sh-reduce' });
        reduction.setPipeline(kernels.reduce.pipeline);
        reduction.setBindGroup(0, reduce);
        reduction.dispatchWorkgroups(1);
        reduction.end();
      },
    };
  }
  return {
    coefficients,
    record: prepareRasterProjection(device, scratchScope, kernels, inputs, coefficients),
  };
}

function rasterTarget(device: RhiDevice, scope: DeviceScope, label: string, height: number) {
  const texture = device
    .createTexture({
      label,
      size: { width: PACKED_VECTORS, height, depthOrArrayLayers: 1 },
      format: 'rgba32float',
      usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING | GPU_TEXTURE_USAGE_COPY_SRC,
    })
    .unwrap();
  scope._adopt('texture', texture, (texture) => {
    device.destroyTexture(texture).unwrap();
  });
  return { texture, view: device.createTextureView(texture, { dimension: '2d' }).unwrap() };
}

function prepareRasterProjection(
  device: RhiDevice,
  scratch: DeviceScope,
  kernels: RasterKernels,
  inputs: BindGroupEntry[],
  coefficients: Buffer,
) {
  const projected = rasterTarget(device, scratch, 'sky-sh-partials', TILE_COUNT);
  const reduced = rasterTarget(
    device,
    scratch,
    'sky-sh-subtotals',
    Math.ceil(TILE_COUNT / REDUCE_WIDTH),
  );
  const packed = rasterTarget(device, scratch, 'sky-sh-packed', 1);
  const steps = [
    { label: 'sky-sh-project', pipeline: kernels.project, target: projected.view, entries: inputs },
    {
      label: 'sky-sh-reduce-0',
      pipeline: kernels.reduce,
      target: reduced.view,
      entries: [{ binding: 3, resource: { kind: 'textureView' as const, value: projected.view } }],
    },
    {
      label: 'sky-sh-reduce-1',
      pipeline: kernels.finish,
      target: packed.view,
      entries: [{ binding: 3, resource: { kind: 'textureView' as const, value: reduced.view } }],
    },
  ].map(({ entries, ...step }) => ({
    ...step,
    bindGroup: group(device, step.label, step.pipeline, entries),
  }));
  return (encoder: RhiCommandEncoder) => {
    for (const step of steps) {
      const pass = encoder.beginRenderPass({
        label: step.label,
        colorAttachments: [
          {
            view: step.target,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
          },
        ],
      });
      pass.setPipeline(step.pipeline.pipeline);
      pass.setBindGroup(0, step.bindGroup);
      pass.draw(3);
      pass.end();
    }
    publishRasterCoefficients(encoder, packed.texture, coefficients);
  };
}

export function publishRasterCoefficients(
  encoder: RhiCommandEncoder,
  texture: Texture,
  buffer: Buffer,
) {
  encoder.copyTextureToBuffer(
    { texture },
    { buffer },
    { width: PACKED_VECTORS, height: 1, depthOrArrayLayers: 1 },
  );
}

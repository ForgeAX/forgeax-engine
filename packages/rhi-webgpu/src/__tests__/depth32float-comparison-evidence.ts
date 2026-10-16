import type {
  BindGroupLayout,
  MappedBuffer,
  RenderPipeline,
  RhiDevice,
  RhiError,
  Sampler,
  Texture,
  TextureView,
} from '@forgeax/engine-rhi';
import { createShaderModule, rhi } from '../index';

export const DEPTH32FLOAT_COMPARISON_SHADER = `
@group(0) @binding(0) var depthTexture: texture_depth_2d;
@group(0) @binding(1) var comparisonSampler: sampler_comparison;

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4<f32> {
  let positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  return vec4<f32>(positions[vertexIndex], 0.0, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
  let comparison = textureSampleCompareLevel(
    depthTexture,
    comparisonSampler,
    vec2<f32>(0.5, 0.5),
    0.5,
  );
  return vec4<f32>(comparison, 0.0, 0.0, 1.0);
}
`;

export type ComparisonRunner = 'browser' | 'dawn';

export interface ErrorReceipt {
  readonly operation: string;
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail: unknown;
}

export interface ComparisonControl {
  readonly clearValue: 0 | 1;
  readonly rawHalfWords: readonly number[];
  readonly comparison: number;
  readonly expectedRawHalfWords: readonly number[];
}

export interface Depth32floatComparisonEvidence {
  readonly runner: ComparisonRunner;
  readonly backend: string;
  readonly status: 'available' | 'unavailable' | 'failed';
  readonly shaderSourceSha256: string | null;
  readonly descriptors: {
    readonly depthTexture: Record<string, unknown>;
    readonly colorTexture: Record<string, unknown>;
    readonly readbackBuffer: Record<string, unknown>;
    readonly comparisonSampler: Record<string, unknown>;
  };
  readonly controls: readonly ComparisonControl[];
  readonly errorReceipts: readonly ErrorReceipt[];
  readonly uncapturedErrors: readonly string[];
  readonly deviceLost: { readonly reason: string; readonly message: string } | null;
}

const DEPTH_USAGE = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
const COLOR_USAGE = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC;
const READBACK_USAGE = GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST;
const READBACK_BYTES_PER_ROW = 256;

function errorReceipt(operation: string, error: RhiError): ErrorReceipt {
  return {
    operation,
    code: error.code,
    expected: error.expected,
    hint: error.hint,
    detail: error.detail,
  };
}

function unwrap<T>(
  operation: string,
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: RhiError },
): T {
  if (!result.ok) {
    throw { kind: 'rhi-error', receipt: errorReceipt(operation, result.error) };
  }
  return result.value;
}

function readHalfWords(mapped: MappedBuffer): readonly number[] {
  const range = mapped.getMappedRange(0, 8);
  if (!range.ok) {
    throw { kind: 'rhi-error', receipt: errorReceipt('readback.getMappedRange', range.error) };
  }
  return Array.from(new Uint16Array(range.value.slice(0)));
}

async function sourceDigest(source: string): Promise<string> {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi === undefined || cryptoApi.subtle === undefined) {
    throw {
      kind: 'evidence-error',
      receipt: {
        operation: 'shader-source.sha256',
        code: 'shader-digest-unavailable',
        expected: 'WebCrypto subtle.digest to be available',
        hint: 'run the real Browser or Dawn WebGPU project with WebCrypto enabled',
        detail: null,
      } satisfies ErrorReceipt,
    };
  }
  const bytes = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function unavailableEvidence(
  runner: ComparisonRunner,
  error: ErrorReceipt,
): Depth32floatComparisonEvidence {
  return {
    runner,
    backend: 'unknown',
    status: 'unavailable',
    shaderSourceSha256: null,
    descriptors: {
      depthTexture: {},
      colorTexture: {},
      readbackBuffer: {},
      comparisonSampler: {},
    },
    controls: [],
    errorReceipts: [error],
    uncapturedErrors: [],
    deviceLost: null,
  };
}

async function requestDevice(): Promise<{ device: RhiDevice; adapterBackend: string }> {
  const adapterResult = await rhi.requestAdapter();
  const adapter = unwrap('rhi.requestAdapter', adapterResult);
  const device = unwrap('adapter.requestDevice', await adapter.requestDevice());
  return { device, adapterBackend: 'webgpu' };
}

function createView(device: RhiDevice, operation: string, texture: Texture): TextureView {
  return unwrap(
    operation,
    device.createTextureView(texture, {
      label: `${operation}-view`,
      dimension: '2d',
    }),
  );
}

async function runControl(
  device: RhiDevice,
  pipeline: RenderPipeline,
  layout: BindGroupLayout,
  sampler: Sampler,
  clearValue: 0 | 1,
): Promise<ComparisonControl> {
  const depthTexture = unwrap(
    'create.depthTexture',
    device.createTexture({
      label: `depth32float-comparison-depth-${clearValue}`,
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      mipLevelCount: 1,
      sampleCount: 1,
      dimension: '2d',
      format: 'depth32float',
      usage: DEPTH_USAGE,
      viewFormats: [],
      textureBindingViewDimension: '2d',
    }),
  );
  const depthView = createView(device, 'depth32float-comparison-depth', depthTexture);
  const colorTexture = unwrap(
    'create.colorTexture',
    device.createTexture({
      label: `depth32float-comparison-color-${clearValue}`,
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      mipLevelCount: 1,
      sampleCount: 1,
      dimension: '2d',
      format: 'rgba16float',
      usage: COLOR_USAGE,
      viewFormats: [],
      textureBindingViewDimension: '2d',
    }),
  );
  const colorView = createView(device, 'depth32float-comparison-color', colorTexture);
  const bindGroup = unwrap(
    'create.bindGroup',
    device.createBindGroup({
      label: `depth32float-comparison-bind-group-${clearValue}`,
      layout,
      entries: [
        { binding: 0, resource: { kind: 'textureView', value: depthView } },
        { binding: 1, resource: { kind: 'sampler', value: sampler } },
      ],
    }),
  );
  const readback = unwrap(
    'create.readbackBuffer',
    device.createBuffer({
      label: `depth32float-comparison-readback-${clearValue}`,
      size: READBACK_BYTES_PER_ROW,
      usage: READBACK_USAGE,
      mappedAtCreation: false,
    }),
  );
  const encoder = unwrap(
    'create.commandEncoder',
    device.createCommandEncoder({
      label: `depth32float-comparison-encoder-${clearValue}`,
    }),
  );
  const depthPass = encoder.beginRenderPass({
    label: `depth32float-comparison-depth-pass-${clearValue}`,
    colorAttachments: [],
    depthStencilAttachment: {
      view: depthView,
      depthClearValue: clearValue,
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
    },
  });
  depthPass.end();
  const colorPass = encoder.beginRenderPass({
    label: `depth32float-comparison-color-pass-${clearValue}`,
    colorAttachments: [
      {
        view: colorView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      },
    ],
  });
  colorPass.setPipeline(pipeline);
  colorPass.setBindGroup(0, bindGroup);
  colorPass.draw(3, 1, 0, 0);
  colorPass.end();
  encoder.copyTextureToBuffer(
    { texture: colorTexture, mipLevel: 0, origin: { x: 0, y: 0, z: 0 }, aspect: 'all' } as never,
    { buffer: readback, offset: 0, bytesPerRow: READBACK_BYTES_PER_ROW, rowsPerImage: 1 } as never,
    { width: 1, height: 1, depthOrArrayLayers: 1 },
  );
  const commandBuffer = unwrap('encoder.finish', encoder.finish());
  unwrap('queue.submit', device.queue.submit([commandBuffer]));
  await device.queue.onSubmittedWorkDone();
  const mapped = unwrap('readback.mapAsync', await readback.mapAsync(GPUMapMode.READ));
  const rawHalfWords = readHalfWords(mapped);
  mapped.unmap();
  unwrap('destroy.readbackBuffer', device.destroyBuffer(readback));
  unwrap('destroy.colorTexture', device.destroyTexture(colorTexture));
  unwrap('destroy.depthTexture', device.destroyTexture(depthTexture));
  const expectedRawHalfWords = clearValue === 1 ? [15360, 0, 0, 15360] : [0, 0, 0, 15360];
  return {
    clearValue,
    rawHalfWords,
    comparison: clearValue === 1 ? 1 : 0,
    expectedRawHalfWords,
  };
}

export async function runDepth32floatComparisonEvidence(
  runner: ComparisonRunner,
): Promise<Depth32floatComparisonEvidence> {
  const descriptors = {
    depthTexture: {
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      mipLevelCount: 1,
      sampleCount: 1,
      dimension: '2d',
      format: 'depth32float',
      usage: DEPTH_USAGE,
      viewFormats: [],
      textureBindingViewDimension: '2d',
      clearValues: [1, 0],
    },
    colorTexture: {
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      mipLevelCount: 1,
      sampleCount: 1,
      dimension: '2d',
      format: 'rgba16float',
      usage: COLOR_USAGE,
      viewFormats: [],
      textureBindingViewDimension: '2d',
    },
    readbackBuffer: {
      size: READBACK_BYTES_PER_ROW,
      usage: READBACK_USAGE,
      bytesPerRow: READBACK_BYTES_PER_ROW,
      rowsPerImage: 1,
    },
    comparisonSampler: {
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
      magFilter: 'nearest',
      minFilter: 'nearest',
      mipmapFilter: 'nearest',
      compare: 'less',
    },
  };
  let device: RhiDevice | undefined;
  let deviceLost: { reason: string; message: string } | null = null;
  try {
    const requested = await requestDevice();
    device = requested.device;
    void device.lost.then((lost) => {
      deviceLost = { reason: lost.reason, message: lost.message };
    });
    const shaderSourceSha256 = await sourceDigest(DEPTH32FLOAT_COMPARISON_SHADER);
    const shader = unwrap(
      'create.shaderModule',
      await createShaderModule(device, {
        label: 'depth32float-comparison-shader',
        code: DEPTH32FLOAT_COMPARISON_SHADER,
      }),
    );
    const layout = unwrap(
      'create.bindGroupLayout',
      device.createBindGroupLayout({
        label: 'depth32float-comparison-bind-group-layout',
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.FRAGMENT,
            texture: { sampleType: 'depth', viewDimension: '2d', multisampled: false },
          },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
        ],
      }),
    );
    const pipelineLayout = unwrap(
      'create.pipelineLayout',
      device.createPipelineLayout({
        label: 'depth32float-comparison-pipeline-layout',
        bindGroupLayouts: [layout],
      }),
    );
    const pipeline = unwrap(
      'create.renderPipeline',
      device.createRenderPipeline({
        label: 'depth32float-comparison-pipeline',
        layout: pipelineLayout,
        vertex: { module: shader, entryPoint: 'vs_main', buffers: [] },
        fragment: { module: shader, entryPoint: 'fs_main', targets: [{ format: 'rgba16float' }] },
        primitive: { topology: 'triangle-list' },
      }),
    );
    const sampler = unwrap(
      'create.comparisonSampler',
      device.createSampler({
        label: 'depth32float-comparison-sampler',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
        addressModeW: 'clamp-to-edge',
        magFilter: 'nearest',
        minFilter: 'nearest',
        mipmapFilter: 'nearest',
        compare: 'less',
      }),
    );
    const controls = [
      await runControl(device, pipeline, layout, sampler, 1),
      await runControl(device, pipeline, layout, sampler, 0),
    ];
    return {
      runner,
      backend: requested.adapterBackend,
      status: 'available',
      shaderSourceSha256,
      descriptors,
      controls,
      errorReceipts: [],
      uncapturedErrors: [],
      deviceLost,
    };
  } catch (error) {
    const receipt: ErrorReceipt =
      error !== null && typeof error === 'object' && 'receipt' in error
        ? (error as { receipt: ErrorReceipt }).receipt
        : {
            operation: 'depth32float-comparison',
            code: 'webgpu-runtime-error',
            expected: 'public RHI depth32float comparison probe to complete',
            hint: 'inspect the structured RHI error and backend validation output',
            detail: error instanceof Error ? error.message : String(error),
          };
    return device === undefined
      ? unavailableEvidence(runner, receipt)
      : {
          runner,
          backend: device.caps.backendKind,
          status: 'failed',
          shaderSourceSha256: null,
          descriptors,
          controls: [],
          errorReceipts: [receipt],
          uncapturedErrors: [],
          deviceLost,
        };
  }
}

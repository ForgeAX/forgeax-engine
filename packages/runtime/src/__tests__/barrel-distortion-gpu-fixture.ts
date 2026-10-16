import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { Renderer, RendererOptions } from '@forgeax/engine-render';
import {
  BARREL_DISTORTION_WGSL_COORDINATE,
  type BarrelDistortionMapping,
  mapDisplayUvToSceneUv,
} from '@forgeax/engine-render';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { constructRuntimeRendererHost } from '../renderer-host';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

export const BARREL_GPU_WIDTH = 128;
export const BARREL_GPU_HEIGHT = 128;

export interface BarrelGpuExtent {
  readonly width: number;
  readonly height: number;
}

export interface BarrelRendererFixtureOptions extends BarrelGpuExtent {
  readonly rhi?: RendererOptions['rhi'];
  readonly gpuPassTiming?: RendererOptions['gpuPassTiming'];
  readonly standardProfile?: RendererOptions['standardProfile'];
  readonly shaderManifestUrl?: string;
  readonly rhiInstrumentation?: RendererOptions['rhiInstrumentation'];
}

const TEXTURE_USAGE_COPY_SRC = 0x01;
const TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
const BUFFER_USAGE_MAP_READ = 0x0001;
const BUFFER_USAGE_COPY_DST = 0x0008;
const MAP_MODE_READ = 0x0001;

const engineManifest = await buildEngineShaderManifest();
export const BARREL_ENGINE_MANIFEST_URL = shaderManifestUrl(engineManifest);

export interface BarrelRendererFixture {
  readonly renderer: Renderer;
  readonly assets: AssetRegistry;
  readonly device: GPUDevice;
  readonly renderTarget: GPUTexture;
  readonly width: number;
  readonly height: number;
  readonly canvas: HTMLCanvasElement;
}

function validExtent(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

export function rowBytes(width: number): number {
  return Math.ceil((width * 4) / 256) * 256;
}

/**
 * Construct the production renderer against an offscreen WebGPU swap-chain.
 * The texture remains copyable so tests can inspect the submitted picture
 * without introducing a second render path.
 */
export async function createBarrelRendererFixture(
  options: Partial<BarrelRendererFixtureOptions> = {},
): Promise<BarrelRendererFixture> {
  if (typeof globalThis.navigator?.gpu?.requestAdapter !== 'function') {
    throw new Error('barrel GPU fixture requires navigator.gpu');
  }
  const width = options.width ?? BARREL_GPU_WIDTH;
  const height = options.height ?? BARREL_GPU_HEIGHT;
  if (!validExtent(width) || !validExtent(height)) {
    throw new Error(`barrel GPU fixture requires positive integer extent, got ${width}x${height}`);
  }

  let sharedDevice: GPUDevice | undefined;
  const originalRequestAdapter = globalThis.navigator.gpu.requestAdapter.bind(
    globalThis.navigator.gpu,
  );
  globalThis.navigator.gpu.requestAdapter = async (options) => {
    const adapter = await originalRequestAdapter(options);
    if (adapter === null) return adapter;
    const originalRequestDevice = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async (descriptor) => {
      const device = await originalRequestDevice(descriptor);
      sharedDevice ??= device;
      return device;
    };
    return adapter;
  };

  let renderTarget: GPUTexture | undefined;
  const ensureRenderTarget = (device: GPUDevice, format: GPUTextureFormat): GPUTexture => {
    if (
      renderTarget !== undefined &&
      renderTarget.width === canvas.width &&
      renderTarget.height === canvas.height
    )
      return renderTarget;
    renderTarget?.destroy();
    renderTarget = device.createTexture({
      size: { width: canvas.width, height: canvas.height, depthOrArrayLayers: 1 },
      format,
      usage: TEXTURE_USAGE_RENDER_ATTACHMENT | TEXTURE_USAGE_COPY_SRC,
      viewFormats: format === 'rgba8unorm' ? ['rgba8unorm-srgb'] : [],
    });
    return renderTarget;
  };

  const canvas = {
    width,
    height,
    getContext(kind: string): unknown {
      if (kind !== 'webgpu') return null;
      return {
        configure(descriptor: { device: GPUDevice; format?: GPUTextureFormat }) {
          ensureRenderTarget(descriptor.device, descriptor.format ?? 'rgba8unorm');
        },
        unconfigure() {},
        getCurrentTexture(): GPUTexture {
          if (sharedDevice === undefined) throw new Error('barrel GPU device was not captured');
          return ensureRenderTarget(sharedDevice, 'rgba8unorm');
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;

  let host: Awaited<ReturnType<typeof constructRuntimeRendererHost>>;
  try {
    host = await constructRuntimeRendererHost(
      canvas,
      {
        ...(options.rhi === undefined ? {} : { rhi: options.rhi }),
        ...(options.gpuPassTiming === undefined ? {} : { gpuPassTiming: options.gpuPassTiming }),
        ...(options.standardProfile === undefined
          ? {}
          : { standardProfile: options.standardProfile }),
        ...(options.rhiInstrumentation === undefined
          ? {}
          : { rhiInstrumentation: options.rhiInstrumentation }),
      },
      {
        shaderManifestUrl: options.shaderManifestUrl ?? BARREL_ENGINE_MANIFEST_URL,
      },
    );
  } finally {
    globalThis.navigator.gpu.requestAdapter = originalRequestAdapter;
  }
  if (!host.ok) throw host.error;
  if (sharedDevice === undefined) throw new Error('barrel GPU fixture did not capture a device');
  const capturedDevice = sharedDevice;
  return {
    renderer: host.value.renderer,
    assets: host.value.assets,
    device: sharedDevice,
    get renderTarget() {
      return ensureRenderTarget(capturedDevice, 'rgba8unorm');
    },
    width,
    height,
    canvas,
  };
}

export async function readBarrelPixels(
  device: GPUDevice,
  renderTarget: GPUTexture,
  width = BARREL_GPU_WIDTH,
  height = BARREL_GPU_HEIGHT,
): Promise<Uint8Array> {
  if (!validExtent(width) || !validExtent(height)) {
    throw new Error(`barrel GPU readback requires positive integer extent, got ${width}x${height}`);
  }
  const bytesPerRow = rowBytes(width);
  const buffer = device.createBuffer({
    size: bytesPerRow * height,
    usage: BUFFER_USAGE_MAP_READ | BUFFER_USAGE_COPY_DST,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: renderTarget },
    { buffer, bytesPerRow, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  await buffer.mapAsync(MAP_MODE_READ);
  const bytes = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  return bytes;
}

export function pixelOffset(x: number, y: number, width = BARREL_GPU_WIDTH): number {
  const bytesPerRow = rowBytes(width);
  return y * bytesPerRow + x * 4;
}

export function countRgbDifferences(left: Uint8Array, right: Uint8Array): number {
  let count = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 4) {
    if (
      left[index] !== right[index] ||
      left[index + 1] !== right[index + 1] ||
      left[index + 2] !== right[index + 2]
    ) {
      count += 1;
    }
  }
  return count;
}

export function maxRgbDelta(left: Uint8Array, right: Uint8Array): number {
  let maximum = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 4) {
    maximum = Math.max(
      maximum,
      Math.abs((left[index] ?? 0) - (right[index] ?? 0)),
      Math.abs((left[index + 1] ?? 0) - (right[index + 1] ?? 0)),
      Math.abs((left[index + 2] ?? 0) - (right[index + 2] ?? 0)),
    );
  }
  return maximum;
}

export interface BarrelF32ProbeResult {
  readonly inputs: readonly [number, number][];
  readonly outputs: readonly [number, number][];
}

/**
 * Evaluate the exact production WGSL coordinate function on the selected
 * device. The readback is f32-quantized by the shader; callers compare it to
 * the binary64 CPU mapping and report the resulting pixel error separately.
 */
export async function probeBarrelDistortionF32(
  device: GPUDevice,
  mapping: BarrelDistortionMapping,
  inputs: readonly (readonly [number, number])[],
): Promise<BarrelF32ProbeResult> {
  if (inputs.length === 0) return { inputs: [], outputs: [] };
  const shader = `${BARREL_DISTORTION_WGSL_COORDINATE}
@group(0) @binding(0) var<uniform> params : BarrelDistortionParams;
@group(0) @binding(1) var<storage, read> inputUv : array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> outputUv : array<vec2<f32>>;
@compute @workgroup_size(1)
fn probe(@builtin(global_invocation_id) id : vec3<u32>) {
  let index = id.x;
  if (index >= ${inputs.length}u) { return; }
  outputUv[index] = barrel_distortion_display_to_scene_uv(
    inputUv[index], params, vec2<f32>(${mapping.width}.0, ${mapping.height}.0));
}
`;
  const module = device.createShaderModule({ code: shader });
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'probe' },
  });
  const inputBytes = new Float32Array(inputs.length * 2);
  for (let index = 0; index < inputs.length; index += 1) {
    inputBytes[index * 2] = inputs[index]?.[0] ?? 0;
    inputBytes[index * 2 + 1] = inputs[index]?.[1] ?? 0;
  }
  const inputBuffer = device.createBuffer({
    size: inputBytes.byteLength,
    usage: 0x0008 | 0x0080,
  });
  const outputBuffer = device.createBuffer({
    size: inputBytes.byteLength,
    usage: 0x0004 | 0x0080,
  });
  const readBuffer = device.createBuffer({
    size: inputBytes.byteLength,
    usage: 0x0001 | 0x0008,
  });
  const parameterBytes = new ArrayBuffer(16);
  const parameters = new DataView(parameterBytes);
  parameters.setFloat32(0, mapping.strength, true);
  parameters.setFloat32(4, mapping.centerX, true);
  parameters.setFloat32(8, mapping.centerY, true);
  parameters.setFloat32(12, mapping.radiusSquared, true);
  device.queue.writeBuffer(inputBuffer, 0, inputBytes);
  const parameterBuffer = device.createBuffer({ size: 16, usage: 0x0008 | 0x0040 });
  device.queue.writeBuffer(parameterBuffer, 0, parameterBytes);
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: parameterBuffer } },
      { binding: 1, resource: { buffer: inputBuffer } },
      { binding: 2, resource: { buffer: outputBuffer } },
    ],
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(inputs.length);
  pass.end();
  encoder.copyBufferToBuffer(outputBuffer, 0, readBuffer, 0, inputBytes.byteLength);
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  await readBuffer.mapAsync(0x0001);
  const output = new Float32Array(readBuffer.getMappedRange().slice(0));
  const outputs = Array.from(
    { length: inputs.length },
    (_, index) => [output[index * 2] ?? 0, output[index * 2 + 1] ?? 0] as [number, number],
  );
  readBuffer.unmap();
  inputBuffer.destroy();
  outputBuffer.destroy();
  readBuffer.destroy();
  parameterBuffer.destroy();
  return { inputs: inputs.map(([x, y]) => [x, y]), outputs };
}

export function cpuBarrelProbe(
  mapping: BarrelDistortionMapping,
  inputs: readonly (readonly [number, number])[],
): readonly [number, number][] {
  return inputs.map(([x, y]) => {
    const out = { x: 0, y: 0 };
    if (!mapDisplayUvToSceneUv(out, mapping, x, y)) return [Number.NaN, Number.NaN];
    return [out.x, out.y];
  });
}

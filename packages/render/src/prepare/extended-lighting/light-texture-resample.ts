import type {
  BindGroupLayout,
  Buffer,
  ComputePipeline,
  RhiDevice,
  Texture,
} from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { LIGHT_TEXTURE_RESAMPLE_WGSL } from '@forgeax/engine-shader';
import { type AssetError, err, ok, type Result, type TextureAsset } from '@forgeax/engine-types';
import { writePackedTextureLevels } from '../../device/gpu-residency';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../../gpu-texture-usage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../../gpu-usage';
import type { PipelineBuilderShaderModuleFactory } from '../../pipeline-builder';
import { deriveRenderDataTexture } from '../../render-data';
import { COOKIE_MIP_LEVEL_COUNT, COOKIE_SLICE_SIZE } from './resources';

const COMPUTE_VISIBILITY = 4;
const COPY_ROW_ALIGNMENT = 256;
const WORKGROUP_SIZE = 8;
/** One params slot per level, at the WebGPU default uniform offset alignment. */
const PARAMS_STRIDE = 256;

interface ResampleState {
  readonly layout: BindGroupLayout;
  readonly resample: ComputePipeline;
  readonly reduce: ComputePipeline;
}

const RESAMPLE_STATES = new WeakMap<RhiDevice, ResampleState>();

function sourceDescriptorError(error: AssetError): RhiError {
  return new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: `a light texture source whose block layout matches its shape (${error.expected})`,
    hint: error.hint,
  });
}

function requireValue<T>(result: Result<T, RhiError>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

function resampleState(
  device: RhiDevice,
  factory: PipelineBuilderShaderModuleFactory,
): Result<ResampleState, RhiError> {
  const cached = RESAMPLE_STATES.get(device);
  if (cached !== undefined) return ok(cached);
  try {
    const module = requireValue(
      factory.createShaderModule({
        code: LIGHT_TEXTURE_RESAMPLE_WGSL,
        label: 'light_texture_resample',
      }),
    );
    const layout = requireValue(
      device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: COMPUTE_VISIBILITY, buffer: { type: 'uniform' } },
          {
            binding: 1,
            visibility: COMPUTE_VISIBILITY,
            texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
          },
          { binding: 2, visibility: COMPUTE_VISIBILITY, buffer: { type: 'storage' } },
          { binding: 3, visibility: COMPUTE_VISIBILITY, buffer: { type: 'storage' } },
        ],
      }),
    );
    const pipelineLayout = requireValue(
      device.createPipelineLayout({
        label: 'light_texture_resample.layout',
        bindGroupLayouts: [layout],
      }),
    );
    const pipeline = (entryPoint: string): ComputePipeline =>
      requireValue(
        device.createComputePipeline({
          label: entryPoint,
          layout: pipelineLayout,
          compute: { module, entryPoint },
        }),
      );
    const state = {
      layout,
      resample: pipeline('light_texture_resample'),
      reduce: pipeline('light_texture_reduce'),
    };
    RESAMPLE_STATES.set(device, state);
    return ok(state);
  } catch (error) {
    if (error instanceof RhiError) return err(error);
    throw error;
  }
}

function compressionFeature(
  format: GPUTextureFormat,
): 'texture-compression-bc' | 'texture-compression-etc2' | 'texture-compression-astc' | undefined {
  if (format.startsWith('bc')) return 'texture-compression-bc';
  if (format.startsWith('astc')) return 'texture-compression-astc';
  if (format.startsWith('etc2') || format.startsWith('eac')) return 'texture-compression-etc2';
  return undefined;
}

/** Single-channel block formats decode to (r, 0, 0, 1); the slice splats them to grey. */
function isSingleChannel(format: GPUTextureFormat): boolean {
  return format.startsWith('bc4-') || format.startsWith('eac-r11');
}

/** Row pitch of one packed slice mip, padded for copyBufferToTexture. */
function packedRowBytes(size: number): number {
  return Math.max(size * 4, COPY_ROW_ALIGNMENT);
}

function packedChainBytes(): number {
  let bytes = 0;
  for (let level = 0; level < COOKIE_MIP_LEVEL_COUNT; level += 1) {
    const size = COOKIE_SLICE_SIZE >> level;
    bytes += packedRowBytes(size) * size;
  }
  return bytes;
}

const PACKED_CHAIN_BYTES = packedChainBytes();
const FLOAT_CHAIN_BYTES = (() => {
  let texels = 0;
  for (let level = 0; level < COOKIE_MIP_LEVEL_COUNT; level += 1) {
    texels += (COOKIE_SLICE_SIZE >> level) ** 2;
  }
  return texels * 16;
})();

/**
 * Project a 2D TextureAsset (block-compressed in production, any sampleable
 * format for parity checks) into one light-texture array slice on the GPU: a transient source texture is decoded by `textureLoad`,
 * resampled to 256x256, reduced level by level to the full mip chain and copied into
 * `slice`. The work is one queue submission ordered before the frame that
 * reads the slice; the transient resources are released after submission.
 */
export function resampleLightTextureSlice(input: {
  readonly device: RhiDevice;
  readonly factory: PipelineBuilderShaderModuleFactory | undefined;
  readonly target: Texture;
  readonly slice: number;
  readonly asset: TextureAsset;
}): Result<void, RhiError> {
  const { device, asset } = input;
  const renderData = deriveRenderDataTexture(asset);
  if (!renderData.ok) return err(sourceDescriptorError(renderData.error));
  const format = renderData.value.format;
  const feature = compressionFeature(format);
  const featureReady = feature === undefined || device.features.has(feature);
  if (!device.caps.compute || !featureReady || input.factory === undefined) {
    return err(
      new RhiError({
        code: 'feature-not-enabled',
        expected: `compute pipelines${feature === undefined ? '' : ` and '${feature}'`} for a ${format} light texture`,
        hint: 'request the compression feature on the device, or import the light texture without GPU block compression so the CPU projection fills the slice',
      }),
    );
  }
  const state = resampleState(device, input.factory);
  if (!state.ok) return state;

  const transients: { textures: Texture[]; buffers: Buffer[] } = { textures: [], buffers: [] };
  const release = (): void => {
    for (const texture of transients.textures) device.destroyTexture(texture);
    for (const buffer of transients.buffers) device.destroyBuffer(buffer);
  };
  try {
    const { width, height } = asset.shape.extent;
    const source = requireValue(
      device.createTexture({
        label: 'light-texture-resample-source',
        size: {
          width: renderData.value.physicalExtent.width,
          height: renderData.value.physicalExtent.height,
          depthOrArrayLayers: 1,
        },
        mipLevelCount: 1,
        sampleCount: 1,
        dimension: '2d',
        format,
        usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        viewFormats: [],
        textureBindingViewDimension: undefined,
      }),
    );
    transients.textures.push(source);
    // Only level 0 is read: offline block mips use the encoder's filter, not
    // the box mean the CPU projection integrates, so reading them would make
    // the slice depend on how the source was cooked. Level 0 leads the packed
    // layout for block and uncompressed formats alike.
    const level0Asset: TextureAsset = { ...asset, mips: { kind: 'none' } };
    const written = writePackedTextureLevels(device, source, level0Asset, format, asset.data);
    if (!written.ok) {
      release();
      return err(
        written.error instanceof RhiError ? written.error : sourceDescriptorError(written.error),
      );
    }
    const params = requireValue(
      device.createBuffer({
        label: 'light-texture-resample-params',
        size: PARAMS_STRIDE * COOKIE_MIP_LEVEL_COUNT,
        usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
      }),
    );
    transients.buffers.push(params);
    const levels = requireValue(
      device.createBuffer({
        label: 'light-texture-resample-levels',
        size: FLOAT_CHAIN_BYTES,
        usage: GPU_BUFFER_USAGE_STORAGE,
      }),
    );
    transients.buffers.push(levels);
    const packed = requireValue(
      device.createBuffer({
        label: 'light-texture-resample-packed',
        size: PACKED_CHAIN_BYTES,
        usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC,
      }),
    );
    transients.buffers.push(packed);
    const paramWords = new Uint32Array((PARAMS_STRIDE / 4) * COOKIE_MIP_LEVEL_COUNT);
    for (let level = 0; level < COOKIE_MIP_LEVEL_COUNT; level += 1) {
      paramWords.set(
        [width, height, isSingleChannel(format) ? 1 : 0, level],
        (PARAMS_STRIDE / 4) * level,
      );
    }
    requireValue(device.queue.writeBuffer(params, 0, paramWords));
    const view = requireValue(
      device.createTextureView(source, { label: 'light-texture-resample-source', dimension: '2d' }),
    );
    const encoder = requireValue(device.createCommandEncoder({ label: 'light-texture-resample' }));
    const pass = encoder.beginComputePass({ label: 'light-texture-resample' });
    for (let level = 0; level < COOKIE_MIP_LEVEL_COUNT; level += 1) {
      const bindings = requireValue(
        device.createBindGroup({
          layout: state.value.layout,
          entries: [
            {
              binding: 0,
              resource: {
                kind: 'buffer',
                value: { buffer: params, offset: PARAMS_STRIDE * level, size: 16 },
              },
            },
            { binding: 1, resource: { kind: 'textureView', value: view } },
            { binding: 2, resource: { kind: 'buffer', value: { buffer: levels } } },
            { binding: 3, resource: { kind: 'buffer', value: { buffer: packed } } },
          ],
        }),
      );
      const groups = Math.ceil((COOKIE_SLICE_SIZE >> level) / WORKGROUP_SIZE);
      pass.setBindGroup(0, bindings);
      pass.setPipeline(level === 0 ? state.value.resample : state.value.reduce);
      pass.dispatchWorkgroups(groups, groups);
    }
    pass.end();
    let offset = 0;
    for (let mip = 0; mip < COOKIE_MIP_LEVEL_COUNT; mip += 1) {
      const size = COOKIE_SLICE_SIZE >> mip;
      encoder.copyBufferToTexture(
        {
          buffer: packed as never,
          offset,
          bytesPerRow: packedRowBytes(size),
          rowsPerImage: size,
        },
        { texture: input.target as never, mipLevel: mip, origin: { x: 0, y: 0, z: input.slice } },
        { width: size, height: size, depthOrArrayLayers: 1 },
      );
      offset += packedRowBytes(size) * size;
    }
    const commands = requireValue(encoder.finish());
    requireValue(device.queue.submit([commands]));
    release();
    return ok(undefined);
  } catch (error) {
    release();
    if (error instanceof RhiError) return err(error);
    throw error;
  }
}

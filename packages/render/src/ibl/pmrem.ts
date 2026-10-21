import {
  type BindGroupLayout,
  err,
  ok,
  type RenderPipeline,
  type Result,
  type RhiDevice,
  type RhiError,
  type Texture,
  type TextureFormat,
  type TextureView,
} from '@forgeax/engine-rhi';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING,
} from '../gpu-texture-usage';

export const PREFILTER_SIZE = 128;
export const PMREM_FACES_PER_STEP = 2;

/** CubeUV keeps the last seven logical levels at 16 pixels per face. */
export function pmremLevelCount(size: number): number {
  return Math.log2(size) + 3;
}
export function pmremExtent(size: number) {
  return { width: 3 * Math.max(size, 112), height: 4 * size };
}
export function pmremViewport(size: number, level: number, face: number) {
  const mip = Math.log2(size) - level;
  const faceSize = 2 ** Math.max(mip, 4);
  return {
    x: Math.max(4 - mip, 0) * 48 + (face % 3) * faceSize,
    y: 4 * (size - faceSize) + Math.floor(face / 3) * faceSize,
    width: faceSize,
    height: faceSize,
  };
}

export interface PmremAtlas {
  readonly texture: Texture;
  readonly view: TextureView;
  readonly size: number;
}

export function createPmremAtlas(
  device: RhiDevice,
  label: string,
  size: number,
  format: TextureFormat,
): Result<PmremAtlas, RhiError> {
  const texture = device.createTexture({
    label,
    size: pmremExtent(size),
    format,
    textureBindingViewDimension: '2d',
    usage:
      GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING |
      GPU_TEXTURE_USAGE_COPY_SRC |
      GPU_TEXTURE_USAGE_COPY_DST,
  });
  if (!texture.ok) return texture;
  const view = device.createTextureView(texture.value, { label: `${label}-view`, dimension: '2d' });
  if (!view.ok) {
    device.destroyTexture(texture.value);
    return err(view.error);
  }
  return ok({ texture: texture.value, view: view.value, size });
}

export interface PmremPipeline {
  readonly pipeline: RenderPipeline;
  readonly parametersLayout: BindGroupLayout;
  readonly inputLayout: BindGroupLayout;
}

/** One pipeline contract for image Skylights, captured probes and Atmosphere. */
export function createPmremPipeline(
  device: RhiDevice,
  module: import('@forgeax/engine-rhi').ShaderModule,
  format: TextureFormat,
): Result<PmremPipeline, RhiError> {
  const parametersLayout = device.createBindGroupLayout({
    label: 'pmrem-parameters',
    entries: [{ binding: 1, visibility: 2, buffer: { type: 'uniform', minBindingSize: 16 } }],
  });
  if (!parametersLayout.ok) return parametersLayout;
  const inputLayout = device.createBindGroupLayout({
    label: 'pmrem-inputs',
    entries: [
      { binding: 0, visibility: 2, texture: { sampleType: 'float', viewDimension: 'cube' } },
      { binding: 1, visibility: 2, sampler: { type: 'filtering' } },
      { binding: 2, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
    ],
  });
  if (!inputLayout.ok) return inputLayout;
  const layout = device.createPipelineLayout({
    bindGroupLayouts: [parametersLayout.value, inputLayout.value],
  });
  if (!layout.ok) return layout;
  const pipeline = device.createRenderPipeline({
    label: 'ibl-prefilter-pipeline',
    layout: layout.value,
    vertex: { module, entryPoint: 'cubemap_vs', buffers: [] },
    fragment: { module, entryPoint: 'prefilterEnv_fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
  });
  if (!pipeline.ok) return pipeline;
  return ok({
    pipeline: pipeline.value,
    parametersLayout: parametersLayout.value,
    inputLayout: inputLayout.value,
  });
}

import type { TextureView } from '@forgeax/engine-rhi';
import type { RenderError } from '../errors/render';
import {
  RenderTargetDescriptorInvalidError,
  RenderTargetStateInvalidError,
} from '../errors/render';
import type { RenderResult } from '../render-contract';
import type {
  RenderTarget,
  RenderTargetDescriptor,
  RenderTargetTextureSource,
  RenderTargetTextureSourceOptions,
} from './contracts';

export interface RenderTargetMaterialSourceView {
  readonly dimension: RenderTargetTextureSourceOptions['dimension'];
  readonly mipLevel: number;
  readonly resolveRequired: boolean;
}

export interface RenderTargetMaterialSourceBinding {
  readonly source: RenderTargetTextureSource;
  readonly target: RenderTarget;
  readonly generation: number;
  readonly shape: RenderTargetDescriptor['shape'];
  readonly format: RenderTargetDescriptor['format'];
  readonly view: RenderTargetMaterialSourceView;
  /** Renderer-local physical view, present only for the active generation. */
  readonly textureView?: TextureView;
}

export interface RenderTargetMaterialSourceExpectation {
  readonly target: RenderTarget;
  readonly generation: number;
  readonly shape: RenderTargetDescriptor['shape'];
  readonly format: RenderTargetDescriptor['format'];
  readonly dimension: RenderTargetTextureSourceOptions['dimension'];
  readonly mipLevel: number;
}

const sourceBindings = new WeakMap<object, RenderTargetMaterialSourceBinding>();
const targetIdentities = new WeakMap<object, number>();
let nextTargetIdentity = 1;

function targetIdentity(target: RenderTarget): number {
  const object = target as object;
  const existing = targetIdentities.get(object);
  if (existing !== undefined) return existing;
  const identity = nextTargetIdentity;
  nextTargetIdentity += 1;
  targetIdentities.set(object, identity);
  return identity;
}

function sourceToken(): RenderTargetTextureSource {
  return Object.freeze({}) as RenderTargetTextureSource;
}

/** Resolve a source only inside the renderer-owned material projection. */
export function resolveRenderTargetMaterialSource(
  source: RenderTargetTextureSource,
): RenderTargetMaterialSourceBinding | undefined {
  return sourceBindings.get(source as object);
}

/**
 * Returns the stable renderer-local resource identity used by batch grouping.
 * The opaque source object is intentionally not stringified: target identity,
 * device generation, and view subresource are the producer-owned facts that
 * determine whether two draws may share one material bind group.
 */
export function renderTargetMaterialSourceIdentity(
  source: RenderTargetTextureSource,
): string | undefined {
  const binding = resolveRenderTargetMaterialSource(source);
  if (binding === undefined) return undefined;
  return [
    targetIdentity(binding.target),
    binding.generation,
    binding.shape,
    binding.format,
    binding.view.dimension,
    binding.view.mipLevel,
    binding.view.resolveRequired ? 1 : 0,
  ].join(':');
}

function invalid(
  field: string,
  value: unknown,
  expected: string,
): RenderResult<never, RenderError> {
  return {
    ok: false,
    error: new RenderTargetDescriptorInvalidError({ field, value, expected }),
  };
}

export function createRenderTargetMaterialSource(
  target: RenderTarget,
  descriptor: RenderTargetDescriptor,
  options: RenderTargetTextureSourceOptions & { readonly generation: number },
): RenderResult<RenderTargetMaterialSourceBinding, RenderError> {
  if (options.aspect !== 'color') return invalid('aspect', options.aspect, 'color');
  if (options.dimension !== descriptor.shape) {
    return invalid('dimension', options.dimension, `dimension matches ${descriptor.shape}`);
  }
  const mipCount =
    descriptor.mipLevels === 1
      ? 1
      : Math.floor(Math.log2(Math.max(descriptor.width, descriptor.height))) + 1;
  if (!Number.isInteger(options.mipLevel) || options.mipLevel < 0 || options.mipLevel >= mipCount) {
    return invalid('mipLevel', options.mipLevel, `an admitted mip level below ${mipCount}`);
  }
  if (!Number.isInteger(options.generation) || options.generation < 0) {
    return invalid('generation', options.generation, 'a non-negative device generation');
  }
  const result: RenderResult<RenderTargetMaterialSourceBinding, RenderError> = {
    ok: true,
    value: Object.freeze({
      source: sourceToken(),
      target,
      generation: options.generation,
      shape: descriptor.shape,
      format: descriptor.format,
      view: Object.freeze({
        dimension: options.dimension,
        mipLevel: options.mipLevel,
        resolveRequired: descriptor.sampleCount === 4,
      }),
    }),
  };
  sourceBindings.set(result.value.source as object, result.value);
  return result;
}

export function validateRenderTargetMaterialSource(
  binding: RenderTargetMaterialSourceBinding,
  expected: RenderTargetMaterialSourceExpectation,
): RenderResult<void, RenderError> {
  if (binding.target !== expected.target) {
    return {
      ok: false,
      error: new RenderTargetStateInvalidError({
        operation: 'source',
        reason: 'foreign-renderer',
        state: 'active',
        generation: binding.generation,
      }),
    };
  }
  if (binding.generation !== expected.generation) {
    return {
      ok: false,
      error: new RenderTargetStateInvalidError({
        operation: 'source',
        reason: 'generation-mismatch',
        state: 'active',
        generation: binding.generation,
      }),
    };
  }
  if (binding.shape !== expected.shape || binding.format !== expected.format) {
    return invalid(
      'descriptor',
      { shape: binding.shape, format: binding.format },
      'matching target descriptor',
    );
  }
  if (
    binding.view.dimension !== expected.dimension ||
    binding.view.mipLevel !== expected.mipLevel
  ) {
    return invalid('view', binding.view, 'matching target view subresource');
  }
  return { ok: true, value: undefined };
}

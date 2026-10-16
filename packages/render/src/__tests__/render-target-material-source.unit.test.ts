import { describe, expect, it } from 'vitest';
import { materialRenderTargetSourceForField } from '../record/main-pass-material';
import type { MaterialSnapshot } from '../render-system-extract';
import type { RenderTargetDescriptor } from '../targets/contracts';
import {
  createRenderTargetMaterialSource,
  validateRenderTargetMaterialSource,
} from '../targets/material-source';
import { createRenderTargetOwner } from '../targets/owner';

const descriptor: RenderTargetDescriptor = {
  shape: '2d',
  width: 32,
  height: 16,
  format: 'rgba8unorm-srgb',
  mipLevels: 'full',
  sampleCount: 1,
  sampled: true,
  readback: false,
};

function target() {
  const owner = createRenderTargetOwner({ rendererId: Symbol('renderer'), getGeneration: () => 4 });
  const created = owner.create(descriptor);
  if (!created.ok) throw created.error;
  return created.value;
}

describe('RenderTarget material source', () => {
  it('binds one target generation and one exact view subresource', () => {
    const binding = createRenderTargetMaterialSource(target(), descriptor, {
      aspect: 'color',
      dimension: '2d',
      mipLevel: 2,
      generation: 4,
    });
    expect(binding.ok).toBe(true);
    if (!binding.ok) return;
    expect(binding.value.source).toBeDefined();
    expect(binding.value.generation).toBe(4);
    expect(binding.value.view).toMatchObject({ dimension: '2d', mipLevel: 2 });
    expect(
      validateRenderTargetMaterialSource(binding.value, {
        target: binding.value.target,
        shape: '2d',
        format: 'rgba8unorm-srgb',
        dimension: '2d',
        mipLevel: 2,
        generation: 4,
      }).ok,
    ).toBe(true);
  });

  it('rejects a wrong shape, format, view, or stale generation before binding', () => {
    const binding = createRenderTargetMaterialSource(target(), descriptor, {
      aspect: 'color',
      dimension: '2d',
      mipLevel: 0,
      generation: 4,
    });
    expect(binding.ok).toBe(true);
    if (!binding.ok) return;
    const wrong = validateRenderTargetMaterialSource(binding.value, {
      target: binding.value.target,
      shape: 'cube',
      format: 'rgba16float',
      dimension: 'cube',
      mipLevel: 1,
      generation: 5,
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok)
      expect(['render-target-state-invalid', 'render-target-descriptor-invalid']).toContain(
        wrong.error.code,
      );
  });

  it('uses the renderer-owned physical view resolver before material bind assembly', () => {
    const binding = createRenderTargetMaterialSource(target(), descriptor, {
      aspect: 'color',
      dimension: '2d',
      mipLevel: 0,
      generation: 4,
    });
    expect(binding.ok).toBe(true);
    if (!binding.ok) return;
    const material = {
      textureSources: new Map([['baseColorTexture', binding.value.source]]),
    } as unknown as MaterialSnapshot;
    const physicalView = {} as NonNullable<typeof binding.value.textureView>;
    const resolved = materialRenderTargetSourceForField(material, 'baseColorTexture', () => ({
      ...binding.value,
      textureView: physicalView,
    }));
    expect(resolved?.textureView).toBe(physicalView);
  });
});

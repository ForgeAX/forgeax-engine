import { describe, expect, it } from 'vitest';
import { renderMaterialContext } from '../material-context';

describe('material context publication', () => {
  it('publishes immutable scalar domains while rereading mutable device limits', () => {
    const caps = { backendKind: 'webgpu' as const, storageBuffer: true };
    const limits = { maxSampledTexturesPerShaderStage: 32 };
    const first = renderMaterialContext(caps, limits);
    expect(renderMaterialContext(caps, { ...limits })).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.materialContext)).toBe(true);
    limits.maxSampledTexturesPerShaderStage = 16;
    const lower = renderMaterialContext(caps, limits);
    expect(lower).not.toBe(first);
    expect(lower.materialContext?.capability).not.toBe(first.materialContext?.capability);
    expect(first.materialContext?.capability).toBe('storage-buffer-atmosphere');
    caps.storageBuffer = false;
    expect(renderMaterialContext(caps, limits).materialContext?.capability).toBe(
      'uniform-fallback',
    );
  });

  it('separates visible-surface domains and receiving backend replacement', () => {
    const caps = { backendKind: 'webgpu' as const, storageBuffer: true };
    const plain = renderMaterialContext(caps);
    const surface = renderMaterialContext(caps, undefined, true);
    expect(surface.materialContext).toMatchObject({ visibleSurface: true });
    expect(plain.materialContext).not.toHaveProperty('visibleSurface');
    expect(renderMaterialContext(caps)).toEqual(plain);
    expect(renderMaterialContext(caps, undefined, true)).toEqual(surface);
    const webgl = renderMaterialContext({ ...caps, backendKind: 'wgpu-webgl2' });
    expect(webgl.materialContext?.backend).toBe('webgl2');
    expect(plain.materialContext?.backend).toBe('webgpu');
  });
});

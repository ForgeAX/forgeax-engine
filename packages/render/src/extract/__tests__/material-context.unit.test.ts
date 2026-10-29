import { describe, expect, it } from 'vitest';
import { renderMaterialContext } from '../material-context';

describe('material context publication', () => {
  it('selects fixed definitions for every current receiving material domain', () => {
    const definitions = new Set<unknown>();
    for (const backendKind of ['webgpu', 'wgpu-native', 'wgpu-webgl2', 'null'] as const) {
      for (const storageBuffer of [false, true]) {
        for (const limit of [undefined, -1, 0, 20, 21, 24, 25, 31, 32, Infinity, NaN]) {
          for (const visibleSurface of [false, true]) {
            const caps = { backendKind, storageBuffer };
            const limits = limit === undefined ? {} : { maxSampledTexturesPerShaderStage: limit };
            const result = renderMaterialContext(caps, limits, visibleSurface);
            expect(renderMaterialContext({ ...caps }, { ...limits }, visibleSurface)).toBe(result);
            const capability = !storageBuffer
              ? 'uniform-fallback'
              : limit !== undefined && limit >= 32
                ? 'storage-buffer-atmosphere'
                : limit === undefined || limit >= 25
                  ? 'storage-buffer'
                  : limit >= 21
                    ? 'storage-buffer-projector'
                    : 'storage-buffer-minimum';
            expect(result).toEqual({
              materialContext: {
                backend:
                  backendKind === 'null'
                    ? 'webgpu'
                    : backendKind === 'wgpu-webgl2'
                      ? 'webgl2'
                      : backendKind,
                capability,
                pipeline: 'forward',
                geometry: 'mesh',
                pass: 'forward',
                profile: 'forgeax-material-wgsl-v1',
                toolchain: 'naga-oil',
                instrumentation: 'none',
                ...(visibleSurface ? { visibleSurface: true } : {}),
              },
            });
            expect(Object.isFrozen(result)).toBe(true);
            expect(Object.isFrozen(result.materialContext)).toBe(true);
            definitions.add(result);
          }
        }
      }
    }
    expect(definitions.size).toBe(30);
  });

  it('rereads frozen getters and proxies instead of retaining their input identity', () => {
    let limit = 32;
    let reads = 0;
    const limits = Object.freeze({
      get maxSampledTexturesPerShaderStage() {
        reads++;
        return limit;
      },
    });
    const caps = { backendKind: 'webgpu' as const, storageBuffer: true };
    const first = renderMaterialContext(caps, limits);
    limit = 20;
    expect(renderMaterialContext(new Proxy(caps, {}), limits).materialContext?.capability).toBe(
      'storage-buffer-minimum',
    );
    expect(reads).toBeGreaterThan(1);
    expect(first.materialContext?.capability).toBe('storage-buffer-atmosphere');
    const fault = new Error('Current capability read failed');
    expect(() =>
      renderMaterialContext(
        new Proxy(caps, {
          get() {
            throw fault;
          },
        }),
        limits,
      ),
    ).toThrow(fault);
    expect(() =>
      renderMaterialContext(caps, {
        get maxSampledTexturesPerShaderStage(): number {
          throw fault;
        },
      }),
    ).toThrow(fault);
  });

  it('keeps unrecognized borrowed backend values detached', () => {
    for (const backendKind of [undefined, 'borrowed-backend', '__proto__', 'constructor']) {
      const caps = { backendKind, storageBuffer: false } as unknown as Parameters<
        typeof renderMaterialContext
      >[0];
      const first = renderMaterialContext(caps);
      expect(first.materialContext?.backend).toBe(backendKind);
      expect(first.materialContext?.capability).toBe('uniform-fallback');
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.materialContext)).toBe(true);
      expect(renderMaterialContext(caps)).not.toBe(first);
    }
  });

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

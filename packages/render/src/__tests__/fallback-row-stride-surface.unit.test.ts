import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FALLBACK_BYTES_PER_ROW,
  texelFallbackDescriptor,
  writeTexelFallback,
} from '../ibl/skylight-bind-group';

const ownerSource = readFileSync(new URL('../ibl/skylight-bind-group.ts', import.meta.url), 'utf8');
const consumerSources = [
  '../assembly/webgpu-ready.ts',
  '../assembly/layered-texture-fallback.ts',
  '../ssao-buffers.ts',
].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'));
const rendererSource = consumerSources[0] as string;

describe('fallback texture row-stride owner', () => {
  it('keeps every 1x1 fallback upload path on one owner', () => {
    expect(FALLBACK_BYTES_PER_ROW).toBe(256);
    expect(ownerSource.match(/export const FALLBACK_BYTES_PER_ROW\s*=\s*256/g)).toHaveLength(1);
    for (const source of consumerSources) {
      expect(source).toContain('writeTexelFallback(');
      expect(source).not.toMatch(/bytesPerRow:\s*(256|FALLBACK_BYTES_PER_ROW)/);
    }
  });

  it('pads each layer to the shared row stride', () => {
    const calls: unknown[][] = [];
    const queue = {
      writeTexture: (...args: unknown[]) => {
        calls.push(args);
        return { ok: true as const, value: undefined };
      },
    };
    const descriptor = texelFallbackDescriptor('probe', 'rg16float', 'cube');
    writeTexelFallback(queue as never, {} as never, descriptor, new Uint16Array([0x3c00, 0]));
    expect(descriptor.textureBindingViewDimension).toBe('cube');
    const [, data, layout, size] = calls[0] as [unknown, Uint8Array, unknown, unknown];
    expect(data.byteLength).toBe(FALLBACK_BYTES_PER_ROW * 6);
    expect(new DataView(data.buffer).getUint16(5 * FALLBACK_BYTES_PER_ROW, true)).toBe(0x3c00);
    expect(layout).toEqual({ offset: 0, bytesPerRow: FALLBACK_BYTES_PER_ROW, rowsPerImage: 1 });
    expect(size).toEqual({ width: 1, height: 1, depthOrArrayLayers: 6 });
  });

  it('uploads an exactly neutral normal instead of treating 128/255 as one half', () => {
    const creation = rendererSource.slice(
      rendererSource.indexOf('const fallbackNormalTextureDescriptor ='),
      rendererSource.indexOf('const fallbackNormalTextureViewResult ='),
    );
    expect(creation).toContain("'rgba16float'");
    const start = creation.indexOf('const fallbackNormalTexel =');
    const end = creation.indexOf('const fallbackNormalWriteResult =');
    // Execute the actual owner payload construction; do not duplicate its bytes.
    const texel = new Function(
      `${creation.slice(start, end)}; return fallbackNormalTexel;`,
    )() as Uint16Array;
    expect(Array.from(texel)).toEqual([0x3800, 0x3800, 0x3c00, 0x3c00]);
  });
});

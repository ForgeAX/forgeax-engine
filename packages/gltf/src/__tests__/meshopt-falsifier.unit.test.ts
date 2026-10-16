import { describe, expect, it } from 'vitest';
import type { MeshoptBufferViewJson } from '../meshopt-decode.js';
import { projectMeshoptBufferViews } from '../meshopt-decode.js';

function view(extension: Record<string, unknown>, coreByteLength = 0) {
  return [
    {
      buffer: 0,
      byteLength: coreByteLength,
      extensions: { EXT_meshopt_compression: extension },
    },
  ] as unknown as MeshoptBufferViewJson[];
}

const baseExtension = {
  buffer: 1,
  byteOffset: 0,
  byteLength: 4,
  byteStride: 4,
  count: 2,
  mode: 'ATTRIBUTES',
};

describe('EXT_meshopt_compression falsifiers', () => {
  it('fails closed when required compressed data has no decoder', async () => {
    const result = await projectMeshoptBufferViews(
      view(baseExtension),
      [new Uint8Array(0), new Uint8Array(4)],
      ['EXT_meshopt_compression'],
    );

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'gltf-meshopt-decoder-required') {
      expect(result.error.code).toBe('gltf-meshopt-decoder-required');
      expect(result.error.detail.actual).toBe('required');
      expect(result.error.detail.hasCoreFallback).toBe(false);
    }
  });

  it('rejects an out-of-range compressed payload before invoking the decoder', async () => {
    let called = false;
    const result = await projectMeshoptBufferViews(
      view({ ...baseExtension, byteOffset: 3, byteLength: 4 }),
      [new Uint8Array(0), new Uint8Array(4)],
      ['EXT_meshopt_compression'],
      {
        decode() {
          called = true;
          return new Uint8Array(8);
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(called).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('gltf-meshopt-decode-failed');
  });

  it('rejects invalid mode/filter/count/stride declarations', async () => {
    const invalidCases = [
      { mode: 'NOT_A_MODE' },
      { filter: 'NOT_A_FILTER' },
      { count: 0 },
      { byteStride: 0 },
    ];
    for (const mutation of invalidCases) {
      const result = await projectMeshoptBufferViews(
        view({ ...baseExtension, ...mutation }),
        [new Uint8Array(0), new Uint8Array(4)],
        ['EXT_meshopt_compression'],
        { decode: () => new Uint8Array(8) },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('gltf-meshopt-decode-failed');
    }
  });

  it('rejects a decoder result whose byte length disagrees with count times stride', async () => {
    const result = await projectMeshoptBufferViews(
      view(baseExtension),
      [new Uint8Array(0), new Uint8Array(4)],
      ['EXT_meshopt_compression'],
      { decode: () => new Uint8Array(7) },
    );

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'gltf-meshopt-decode-failed') {
      expect(result.error.code).toBe('gltf-meshopt-decode-failed');
      expect(result.error.detail.actual).toContain('expected=8');
    }
  });
});

import { describe, expect, it } from 'vitest';
import { projectMeshoptBufferViews } from '../meshopt-decode.js';

function compressedView(overrides: Record<string, unknown> = {}) {
  return {
    buffer: 0,
    byteOffset: 0,
    byteLength: 8,
    extensions: {
      EXT_meshopt_compression: {
        buffer: 1,
        byteOffset: 2,
        byteLength: 4,
        byteStride: 4,
        count: 2,
        mode: 'ATTRIBUTES' as const,
        ...overrides,
      },
    },
  };
}

describe('EXT_meshopt_compression projection', () => {
  it('decodes the declared compressed range and replaces the view exactly once', async () => {
    const source = new Uint8Array([9, 9, 1, 2, 3, 4, 9]);
    const calls: Array<{ source: Uint8Array; count: number; stride: number }> = [];
    const result = await projectMeshoptBufferViews(
      [compressedView()],
      [new Uint8Array(8), source],
      ['EXT_meshopt_compression'],
      {
        decode(input) {
          calls.push(input);
          return new Uint8Array(input.count * input.stride);
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.source).toEqual(new Uint8Array([1, 2, 3, 4]));
    if (result.ok) {
      expect(result.value.decodedCount).toBe(1);
      expect(result.value.bufferViews[0]).toMatchObject({
        buffer: 2,
        byteOffset: 0,
        byteLength: 8,
      });
      expect(result.value.bufferViews[0]).not.toHaveProperty('extensions');
      expect(result.value.buffers[2]).toHaveLength(8);
    }
  });

  it('preserves an optional core fallback without touching compressed bytes', async () => {
    const result = await projectMeshoptBufferViews(
      [compressedView()],
      [new Uint8Array(8), new Uint8Array([1, 2, 3, 4])],
      [],
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.decodedCount).toBe(0);
      expect(result.value.bufferViews[0]?.buffer).toBe(0);
    }
  });

  it('supports triangle and index streams through the same capability seam', async () => {
    const modes = ['TRIANGLES', 'INDICES'] as const;
    const seen: string[] = [];
    for (const mode of modes) {
      const result = await projectMeshoptBufferViews(
        [compressedView({ mode, byteStride: 2, count: 6 })],
        [new Uint8Array(12), new Uint8Array(8)],
        ['EXT_meshopt_compression'],
        {
          decode(input) {
            seen.push(`${input.mode}:${input.filter}`);
            return new Uint8Array(input.count * input.stride);
          },
        },
      );
      expect(result.ok).toBe(true);
    }
    expect(seen).toEqual(['TRIANGLES:NONE', 'INDICES:NONE']);
  });
});

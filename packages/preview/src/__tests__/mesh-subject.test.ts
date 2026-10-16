import { describe, expect, it } from 'vitest';
import { inspectMeshSubject } from '../domains/mesh.js';
import { meshFixture } from '../kit/receipt.test-fixtures.js';

describe('mesh preview subject contract', () => {
  it('accepts a finite AABB, declared slot, and complete submesh coverage', () => {
    expect(inspectMeshSubject({ guid: 'mesh-guid', asset: meshFixture() })).toMatchObject({
      ok: true,
      value: { aabb: [-1, -1, 0, 1, 1, 0], submeshCount: 1, materialSlotCount: 1 },
    });
  });

  it.each([
    ['wrong kind', { kind: 'material' }],
    [
      'empty AABB',
      { aabb: Float32Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity) },
    ],
    ['non-finite AABB', { aabb: Float32Array.of(-1, -1, 0, Number.NaN, 1, 0) }],
    ['missing material slot', { materialSlots: [] }],
    ['missing submesh coverage', { submeshes: [] }],
    [
      'slot index out of range',
      {
        submeshes: [{ topology: 'triangle-list', indexOffset: 0, indexCount: 3, materialSlot: 1 }],
      },
    ],
  ])('fails closed for %s', (label, override) => {
    const result = inspectMeshSubject({ guid: 'mesh-guid', asset: meshFixture(override) });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code:
          label === 'wrong kind'
            ? 'resource-preview-kind-mismatch'
            : 'resource-preview-subject-invalid',
      },
    });
    if (!result.ok) expect(result.error.detail.phase).toBe('subject');
  });
});

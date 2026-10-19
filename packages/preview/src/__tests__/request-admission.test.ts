import { describe, expect, it } from 'vitest';
import { materialPreviewDescriptor } from '../material.js';
import { meshPreviewDescriptor } from '../mesh.js';
import { texturePreviewDescriptor } from '../texture.js';
import { vfxPreviewDescriptor } from '../vfx.js';

const cases = [
  [materialPreviewDescriptor, { guid: 'asset', programDigest: 'program', bindings: ['color'] }],
  [
    meshPreviewDescriptor,
    {
      guid: 'asset',
      vertexDigest: 'vertices',
      indexDigest: 'indices',
      submeshes: [{ id: 'body', vertexCount: 3, indexCount: 3 }],
      aabb: { min: [0, 0, 0], max: [1, 1, 1] },
    },
  ],
  [
    texturePreviewDescriptor,
    {
      guid: 'asset',
      width: 4,
      height: 4,
      format: 'rgba8unorm',
      colorSpace: 'srgb',
      alpha: false,
      mipLevels: 1,
      channels: 4,
    },
  ],
  [vfxPreviewDescriptor, { guid: 'asset', effectDigest: 'effect' }],
] as const;

describe.each(cases)('$0.id request admission', (descriptor, binding) => {
  const request = {
    subject: { kind: descriptor.preview.subject.kind, guid: 'asset' },
    snapshot: { revision: 1, digest: 'snapshot' },
    binding,
    simulation: { seed: 1, deltaSeconds: 1 / 60, frames: 60 },
  };
  it('admits complete input and rejects malformed envelopes without throwing', () => {
    expect(descriptor.argsSchema.parse(request).ok).toBe(true);
    for (const value of [
      null,
      [],
      {},
      { ...request, snapshot: null },
      { ...request, subject: [] },
      { ...request, binding: null },
      { ...request, binding: { guid: 'asset' } },
    ]) {
      expect(() => descriptor.argsSchema.parse(value)).not.toThrow();
      expect(descriptor.argsSchema.parse(value).ok).toBe(false);
    }
  });
  it('validates every required binding field before admitting a typed request', () => {
    for (const field of Object.keys(binding)) {
      for (const invalid of [undefined, null, {}]) {
        expect(
          descriptor.argsSchema.parse({ ...request, binding: { ...binding, [field]: invalid } }).ok,
          field,
        ).toBe(false);
      }
    }
  });
});

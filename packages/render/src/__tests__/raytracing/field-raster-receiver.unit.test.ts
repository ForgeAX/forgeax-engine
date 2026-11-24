import { assert, expect, it } from 'vitest';
import { deriveFieldReceivers } from '../../raytracing/field-receiver';
import { receiverMetadataFixture } from './field-receiver.fixture';

it('publishes accepted alpha-tested raster geometry separately from primitive opacity', async () => {
  const f = await receiverMetadataFixture(0.5);
  try {
    const ready = deriveFieldReceivers(f.input).unwrap();
    assert(ready.state === 'ready');
    expect(
      ready.resolve(1, 0, f.input.acceptedSource, f.input.owner.identity).unwrap(),
    ).toMatchObject({
      state: 'identified',
      canonicalRow: 0,
      primitive: 0,
      receiverProof: 'raster-alpha-local',
      contact: { state: 'unavailable', reason: 'receiver-contact-unqualified' },
    });
    const source = ready
      .gpuSource(f.input.acceptedSource, f.input.owner.identity, 0, {
        maxTextureDimension2D: 4096,
        maxBytes: 65536,
      })
      .unwrap();
    assert(source.state === 'ready');
    expect(source.words[16]).toBe(1);
    expect(source.words[19]).toBe(2);
    expect(source.words[1]).toBe(2);
  } finally {
    f.dispose();
  }
});

it('does not publish unqualified coverage or a changed material as an alpha-local identity', async () => {
  const f = await receiverMetadataFixture(0.5);
  try {
    const material = f.source.materials[0];
    assert(material);
    const changes = [
      { ...material, facts: { ...material.facts, paramSnapshot: { alphaCutoff: 0 } } },
      {
        ...material,
        facts: { ...material.facts, renderState: { frontFace: 'cw' as const } },
      },
      { ...material, handle: material.handle + 1 },
    ];
    for (const changed of changes) {
      const ready = deriveFieldReceivers({
        ...f.input,
        sources: [{ ...f.source, materials: [changed] }],
      }).unwrap();
      assert(ready.state === 'ready');
      expect(
        ready.resolve(1, 0, f.input.acceptedSource, f.input.owner.identity).unwrap().state,
      ).toBe('unavailable');
    }
  } finally {
    f.dispose();
  }
});

it('retires a cached local projection when its actual frame owner is no longer current', async () => {
  const f = await receiverMetadataFixture(0.5);
  let current = true;
  try {
    const ready = deriveFieldReceivers({
      ...f.input,
      owner: { ...f.input.owner, current: () => current },
    }).unwrap();
    assert(ready.state === 'ready');
    const limits = { maxTextureDimension2D: 4096, maxBytes: 65536 };
    expect(
      ready.gpuSource(f.input.acceptedSource, f.input.owner.identity, 0, limits).unwrap().state,
    ).toBe('ready');
    current = false;
    expect(
      ready.gpuSource(f.input.acceptedSource, f.input.owner.identity, 0, limits).unwrap(),
    ).toEqual({ state: 'unavailable', reason: 'stale-owner' });
  } finally {
    f.dispose();
  }
});

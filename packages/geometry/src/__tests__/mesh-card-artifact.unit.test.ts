import { describe, expect, it } from 'vitest';
import { decodeMeshCardLayout, encodeMeshCardLayout } from '../mesh-card-artifact';
import { buildMeshCardLayout } from '../mesh-card-layout';

describe('card derived-data boundary', () => {
  it('round trips the exact geometry identity and rejects stale, corrupt and invalid projections', async () => {
    const layout = (await buildMeshCardLayout([-1, -1, 0, 1, -1, 0, -1, 1, 0], [0, 1, 2])).unwrap();
    const bytes = encodeMeshCardLayout(layout).unwrap();
    expect(decodeMeshCardLayout(bytes, layout.meshDigest).unwrap()).toEqual(layout);
    expect(decodeMeshCardLayout(bytes, '0'.repeat(64)).ok).toBe(false);
    expect(decodeMeshCardLayout(bytes.subarray(0, bytes.length - 1), layout.meshDigest).ok).toBe(
      false,
    );
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    for (const broken of [
      { version: 1, layout },
      { version: 2, layout: { ...layout, sampling: null } },
      { version: 2, layout: { ...layout, cards: [{ ...layout.cards[0], n: [0, 0, 0] }] } },
      { version: 2, layout: { ...layout, cards: [{ ...layout.cards[0], width: -1 }] } },
      {
        version: 2,
        layout: {
          ...layout,
          cards: [{ ...layout.cards[0], v: layout.cards[0]?.v.map((x) => -x) }],
        },
      },
      {
        version: 2,
        layout: { ...layout, sampling: { ...layout.sampling, representedWeight: 1e9 } },
      },
    ])
      expect(decodeMeshCardLayout(encode(broken), layout.meshDigest).ok).toBe(false);
    expect(decodeMeshCardLayout(new Uint8Array(262145), layout.meshDigest).ok).toBe(false);
    const oversized = { ...layout, unexpected: 'x'.repeat(262144) };
    expect(encodeMeshCardLayout(oversized).ok).toBe(false);
  });
});

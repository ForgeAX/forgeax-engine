import { describe, expect, it } from 'vitest';
import { shadowViewIdentityKey } from '../../gpu-driven/shadow-views';
import type { RenderableSnapshot } from '../../render-system-extract';
import {
  terrainShadowLayoutMatches,
  terrainShadowReceivers,
  terrainShadowTopology,
} from '../../terrain/shadow-family';

const sharedAsset = {};
const row = (worldId: number, entityKey: number, authorVisible = true) =>
  ({
    worldId,
    entityKey,
    authorVisible,
    terrain: { asset: sharedAsset },
  }) as unknown as RenderableSnapshot;
const directional = { mapSize: 1024, cascadeCount: 4 as const };
const graphKey = (receivers: ReturnType<typeof terrainShadowReceivers>, cascadeCount = 4) =>
  JSON.stringify({
    topology: {
      shadow: { directional: { ...directional, cascadeCount, terrainReceivers: receivers } },
    },
  });

describe('Terrain shadow family admission and retained routing', () => {
  it('projects full instance identity independently of section order and asset reuse', () => {
    const sources = [row(1, 4), row(0, 7), row(0, 7), row(0, 4, false)];
    const receivers = terrainShadowReceivers(sources);
    expect(receivers).toEqual([
      { worldId: 0, entityKey: 7 },
      { worldId: 1, entityKey: 4 },
    ]);
    expect(terrainShadowReceivers([...sources].reverse())).toEqual(receivers);
    const [first, second] = receivers;
    if (first === undefined || second === undefined) throw new Error('missing receiver roots');
    expect(
      shadowViewIdentityKey({ kind: 'directional', index: 0, terrainReceiver: first }),
    ).not.toBe(shadowViewIdentityKey({ kind: 'directional', index: 0, terrainReceiver: second }));
  });

  it('admits the whole family extent and rejects device or carrier exhaustion', () => {
    const roots = terrainShadowReceivers([row(0, 1), row(0, 2)]);
    expect(terrainShadowTopology(directional, roots, 11).ok).toBe(false);
    expect(terrainShadowTopology(directional, roots, 12).ok).toBe(true);
    expect(terrainShadowTopology(directional, roots, Number.NaN).ok).toBe(false);
    const many = terrainShadowReceivers(Array.from({ length: 64 }, (_, i) => row(0, i)));
    expect(terrainShadowTopology(directional, many, 2048).ok).toBe(false);
    expect(terrainShadowTopology(directional, many.slice(0, 63), 256).ok).toBe(true);
    expect(terrainShadowTopology('disabled', many, 0).unwrap()).toBe('disabled');
  });

  it('refuses an old graph on same-count root replacement, reordered mapping or cascade change', () => {
    const a = terrainShadowReceivers([row(0, 1), row(0, 2)]);
    const key = graphKey(a);
    const current = (roots = a, cascadeCount: 1 | 2 | 3 | 4 = 4) =>
      terrainShadowTopology({ ...directional, cascadeCount }, roots, 256).unwrap();
    expect(terrainShadowLayoutMatches(key, current())).toBe(true);
    expect(
      terrainShadowLayoutMatches(key, current(terrainShadowReceivers([row(0, 1), row(0, 3)]))),
    ).toBe(false);
    expect(terrainShadowLayoutMatches(key, current([...a].reverse()))).toBe(false);
    expect(terrainShadowLayoutMatches(key, current(a, 2))).toBe(false);
    expect(terrainShadowLayoutMatches(key, directional)).toBe(false);
    expect(terrainShadowLayoutMatches(key, 'disabled')).toBe(false);
    expect(terrainShadowLayoutMatches('invalid', current())).toBe(false);
    // Preparing or rejecting another roster has no mutation authority over
    // the accepted topology key; retrying its original mapping remains valid.
    expect(terrainShadowLayoutMatches(key, current())).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import {
  type BakeDataKey,
  type BakeFingerprintInput,
  bakeFingerprint,
  resolveBakeData,
} from '../bake-data';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function inputs(overrides: Partial<BakeFingerprintInput> = {}): BakeFingerprintInput {
  return {
    meshContentHash: 'mesh-a',
    worldTransform: new Float32Array(identity),
    materialHash: 'material-a',
    lightHashes: ['sun', 'lamp'],
    settingsHash: 'settings-a',
    algorithmVersion: 1,
    ...overrides,
  };
}

const floor: BakeDataKey = { sceneSourceKey: 'level-1', address: 'floor', lod: 'shared' };
const wall: BakeDataKey = { sceneSourceKey: 'level-1', address: ['house', 'wall'], lod: 0 };
const rock: BakeDataKey = { sceneSourceKey: 'level-2', address: 'rock', lod: 1 };

describe('bakeFingerprint', () => {
  it('is a stable SHA-256 hex digest that ignores light order', () => {
    const fingerprint = bakeFingerprint(inputs());
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(bakeFingerprint(inputs({ lightHashes: ['lamp', 'sun'] }))).toBe(fingerprint);
    expect(bakeFingerprint(inputs({ worldTransform: identity }))).toBe(fingerprint);
  });

  it.each<[string, Partial<BakeFingerprintInput>]>([
    ['mesh content', { meshContentHash: 'mesh-b' }],
    ['world transform', { worldTransform: [...identity.slice(0, 12), 0, 0.5, 0, 1] }],
    ['material', { materialHash: 'material-b' }],
    ['baked lights', { lightHashes: ['sun'] }],
    ['bake settings', { settingsHash: 'settings-b' }],
    ['algorithm version', { algorithmVersion: 2 }],
  ])('changes when the %s changes', (_, change) => {
    expect(bakeFingerprint(inputs(change))).not.toBe(bakeFingerprint(inputs()));
  });
});

describe('resolveBakeData', () => {
  it('keeps matching records and falls back to realtime for stale ones, one diagnostic per scene', () => {
    const records = [floor, wall, rock].map((key) => ({
      key,
      fingerprint: bakeFingerprint(inputs()),
    }));
    const moved = inputs({ worldTransform: [...identity.slice(0, 12), 3, 0, 0, 1] });
    const live = new Map<BakeDataKey, BakeFingerprintInput | undefined>([
      [floor, inputs()],
      [wall, moved],
      [rock, undefined],
    ]);

    const resolution = resolveBakeData(records, (key) => live.get(key));

    expect(resolution.baked.map((record) => record.key)).toEqual([floor]);
    expect(resolution.diagnostics).toEqual([
      {
        code: 'bake-data-stale',
        expected: expect.any(String),
        hint: expect.any(String),
        detail: { sceneSourceKey: 'level-1', stale: [wall] },
      },
      {
        code: 'bake-data-stale',
        expected: expect.any(String),
        hint: expect.any(String),
        detail: { sceneSourceKey: 'level-2', stale: [rock] },
      },
    ]);
  });

  it('reports nothing when every record matches', () => {
    const records = [{ key: floor, fingerprint: bakeFingerprint(inputs()) }];
    expect(resolveBakeData(records, () => inputs())).toEqual({ baked: records, diagnostics: [] });
  });
});

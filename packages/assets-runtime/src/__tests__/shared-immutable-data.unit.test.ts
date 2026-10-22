import type { MaterialProgramAbi } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { copyAssetData } from '../internal/asset-data.js';
import { parseRetainedPackJson } from '../internal/retained-pack-json.js';
import {
  isSharedImmutableAssetData,
  shareVerifiedArtifactBytes,
} from '../internal/shared-immutable.js';

const abi = {
  directEntry: 'vs_main',
  sceneIndexEntry: 'vs_scene_index',
  materialRow: { addressUnitBytes: 16, byteLength: 16, fields: [] },
  resourceSlots: [],
  uvSets: [],
  vertexInputs: [],
  alphaMask: { cutoff: 'alphaCutoff', source: 'baseColor.a' },
  reflection: { layoutIdentity: 'layout', resourceSlots: [], vertexInputs: [] },
  receiptIdentity: 'custom-layout',
  generation: 1,
} satisfies MaterialProgramAbi;

function retainedAbi(): object {
  const pack = parseRetainedPackJson(
    JSON.stringify({
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: 'material-0',
          kind: 'material',
          payload: {
            kind: 'material',
            cooked: { schemaVersion: 'material-cook/4', programs: [{ selections: [{ abi }] }] },
          },
        },
      ],
    }),
  ) as {
    assets: { payload: { cooked: { programs: { selections: { abi: object }[] }[] } } }[];
  };
  const retained = pack.assets[0]?.payload.cooked.programs[0]?.selections[0]?.abi;
  if (retained === undefined) throw Error('missing retained ABI');
  return retained;
}

describe('realm-shared immutable asset data', () => {
  it('returns one exact private view per verified digest', () => {
    const source = new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4);
    const first = shareVerifiedArtifactBytes('sha256:shared-test-a', source);
    const second = shareVerifiedArtifactBytes('sha256:shared-test-a', new Uint8Array([1, 2, 3]));
    expect(second).toBe(first);
    expect(first.buffer).not.toBe(source.buffer);
    expect(first.byteOffset).toBe(0);
    expect(first.buffer.byteLength).toBe(3);
    expect([...first]).toEqual([1, 2, 3]);
    expect(shareVerifiedArtifactBytes('sha256:shared-test-b', source)).not.toBe(first);
  });

  it('keeps shared facts by identity while copying every private value', () => {
    const shared = shareVerifiedArtifactBytes('sha256:shared-test-c', new Uint8Array([4, 5]));
    const facts = retainedAbi();
    const own = new Float32Array([1, 2]);
    const copied = copyAssetData({ shared, facts, own, nested: { own } });
    expect(copied.shared).toBe(shared);
    expect(copied.facts).toBe(facts);
    expect(Object.isFrozen(copied.facts)).toBe(true);
    expect(copied.own).not.toBe(own);
    expect(copied.nested.own).not.toBe(own);
    expect(copied.own.buffer).not.toBe(copied.nested.own.buffer);
    expect(isSharedImmutableAssetData(new Uint8Array([4, 5]))).toBe(false);
  });

  it('is recognised across duplicated package module instances', async () => {
    const facts = retainedAbi();
    const bytes = shareVerifiedArtifactBytes('sha256:shared-test-d', new Uint8Array([7]));
    vi.resetModules();
    const other = await import('../internal/shared-immutable.js?instance=duplicate');
    const loader = await import('../internal/retained-material-facts.js?instance=duplicate');
    expect(other.isSharedImmutableAssetData).not.toBe(isSharedImmutableAssetData);
    expect(other.isSharedImmutableAssetData(facts)).toBe(true);
    expect(other.isSharedImmutableAssetData(bytes)).toBe(true);
    expect(loader.isRetainedMaterialAbi(facts)).toBe(true);
    expect(other.shareVerifiedArtifactBytes('sha256:shared-test-d', new Uint8Array([7]))).toBe(
      bytes,
    );
  });
});

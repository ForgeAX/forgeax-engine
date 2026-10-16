import { describe, expect, it } from 'vitest';
import type { FrameReceipt } from '../../render-contract.js';
import {
  createTerrainReceiptOwner,
  querySubmittedTerrainHeight,
  type SubmittedTerrainSection,
} from '../../terrain/submitted.js';

const receipt = (frameId: number): FrameReceipt => ({
  frameId,
  deviceGeneration: 1,
  presentation: 'ready',
  completed: Promise.resolve({ ok: true, value: undefined }),
});
const section = (high = 1): SubmittedTerrainSection => ({
  worldId: 0,
  entity: 7,
  section: 0,
  asset: 1,
  sectionOrigin: [0, 0],
  translation: [10, 2, 20],
  surface: {
    vertices: 2,
    width: 1,
    lod: 0,
    neighbors: [0, 0, 0, 0],
    heightRange: [0, high],
    heights: new Uint8Array([
      0, 0, 128, 128, 0, 0, 128, 128, 0, 0, 128, 128, 255, 255, 128, 128, 0, 0, 128, 128,
    ]),
  },
});
const request = { worldId: 0, entity: 7, x: 10.8, z: 20.4 };
describe('submitted terrain receipt contract', () => {
  it('retains the exact accepted surface after a newer source arrives, and expires at a bounded horizon', async () => {
    const owner = createTerrainReceiptOwner(() => true),
      a = receipt(0);
    owner.register(a, [{ view: 'primary', sections: [section()] }]);
    expect((await querySubmittedTerrainHeight(a, request)).unwrap()).toBeCloseTo(2.2);
    owner.register(receipt(1), [{ view: 'primary', sections: [section(10)] }]);
    expect((await querySubmittedTerrainHeight(a, request)).unwrap()).toBeCloseTo(2.2);
    for (let i = 2; i < 9; i++)
      owner.register(receipt(i), [{ view: 'primary', sections: [section()] }]);
    expect(await querySubmittedTerrainHeight(a, request)).toMatchObject({
      ok: false,
      error: { code: 'terrain-query-unavailable' },
    });
  });
  it('fails closed for an ambiguous view, an incomplete frame and a stale device generation', async () => {
    let current = true;
    const owner = createTerrainReceiptOwner(() => current),
      a = receipt(0);
    owner.register(a, [
      { view: 'left', sections: [section()] },
      { view: 'right', sections: [section(2)] },
    ]);
    expect((await querySubmittedTerrainHeight(a, request)).ok).toBe(false);
    expect(
      (await querySubmittedTerrainHeight(a, { ...request, view: 'right' })).unwrap(),
    ).toBeCloseTo(2.4);
    expect(
      (await querySubmittedTerrainHeight(a, { ...request, view: 'right', expectedAsset: 2 })).ok,
    ).toBe(false);
    expect(
      (await querySubmittedTerrainHeight(a, { ...request, view: 'right', expectedAsset: 1 })).ok,
    ).toBe(true);
    current = false;
    expect((await querySubmittedTerrainHeight(a, { ...request, view: 'left' })).ok).toBe(false);
    const pending = { ...receipt(1), presentation: 'pending' as const };
    owner.register(pending, [{ view: 'primary', sections: [section()] }]);
    expect((await querySubmittedTerrainHeight(pending, request)).ok).toBe(false);
    owner.clear();
  });
});

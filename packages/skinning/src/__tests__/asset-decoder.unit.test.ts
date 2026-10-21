import { type AssetDecoderContribution, type AssetDecoderInput, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { skeletonContribution, skinContribution } from '../assets/skin-decoder';

async function decoded<P>(
  contribution: AssetDecoderContribution<P>,
  payload: object,
  refs: readonly string[] = [],
): Promise<P | undefined> {
  const result = await contribution.decoder.decode({
    envelope: {
      guid: 'decoder-test',
      kind: contribution.kind.kind,
      payload: { kind: contribution.kind.kind, ...payload },
      refs,
      artifacts: {},
    },
    artifacts: { read: async () => ok(new Uint8Array()) },
    signal: new AbortController().signal,
  } as unknown as AssetDecoderInput<P>);
  if (!result.ok) expect(result.error.code).toBe('asset-package-invalid');
  return result.ok ? result.value : undefined;
}
describe('skeletonContribution', async () => {
  it('accepts a valid inverseBindMatrices/jointCount pair', async () => {
    const out = await decoded(skeletonContribution, {
      inverseBindMatrices: new Array(16).fill(0),
      jointCount: 1,
    });
    expect((out as { kind?: string }).kind).toBe('skeleton');
  });

  it('round-trips producer-authored conservative bounds from JSON-shaped payloads', async () => {
    const out = await decoded(skeletonContribution, {
      inverseBindMatrices: new Array(16).fill(0),
      jointCount: 1,
      bounds: [-2, -1, -3, 2, 1, 3],
    });
    expect(out).toMatchObject({
      kind: 'skeleton',
      bounds: new Float32Array([-2, -1, -3, 2, 1, 3]),
    });
  });

  it('rejects a stride mismatch (byteLength !== jointCount*64)', async () => {
    expect(
      await decoded(skeletonContribution, {
        inverseBindMatrices: new Array(16).fill(0),
        jointCount: 2,
      }),
    ).toBeUndefined();
  });

  it('rejects a non-array inverseBindMatrices', async () => {
    expect(
      await decoded(skeletonContribution, { inverseBindMatrices: 'bad', jointCount: 0 }),
    ).toBeUndefined();
  });
});

describe('skinContribution', async () => {
  it('accepts a valid skeletonGuid + jointPaths', async () => {
    const out = await decoded(skinContribution, { skeletonGuid: 'g', jointPaths: ['a', 'b'] });
    expect((out as { kind?: string }).kind).toBe('skin');
  });

  it('rejects a missing skeletonGuid or non-string joint path', async () => {
    expect(await decoded(skinContribution, { jointPaths: [] })).toBeUndefined();
    expect(await decoded(skinContribution, { skeletonGuid: 'g', jointPaths: [1] })).toBeUndefined();
  });
});

it('rejects non-finite f32 data and malformed optional bounds', async () => {
  for (const value of [
    { inverseBindMatrices: Array(16).fill(Infinity), jointCount: 1 },
    { inverseBindMatrices: Array(16).fill(1e100), jointCount: 1 },
    { inverseBindMatrices: Array(16).fill(0), jointCount: 1, bounds: 'bad' },
  ])
    expect(await decoded(skeletonContribution, value)).toBeUndefined();
});

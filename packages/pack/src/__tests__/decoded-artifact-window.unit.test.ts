import type { ArtifactDescriptor } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { decodedArtifactRangeIssue, selectDecodedArtifactBytes } from '../bundle';
import { validatePackV2 } from '../schema-compiled';

const descriptor: ArtifactDescriptor = {
  path: 'bundles/programs.bin',
  mediaType: 'text/wgsl',
  contentEncoding: 'zstd',
  byteLength: 2,
  integrity: { algorithm: 'sha256', digest: `sha256:${'a'.repeat(64)}` },
  byteRange: { offset: 16, length: 50, bundleDigest: `sha256:${'b'.repeat(64)}` },
  decodedRange: { offset: 1, length: 2 },
};
const pack = (artifact: ArtifactDescriptor) => ({
  schemaVersion: '2.0.0',
  kind: 'internal-text-package',
  assets: [
    {
      guid: '11111111-1111-4111-8111-111111111111',
      kind: 'material',
      execution: 'cooked',
      payload: { kind: 'material' },
      refs: [],
      artifacts: { body: artifact },
    },
  ],
});

it('admits a grouped descriptor and returns an independently owned complete artifact', () => {
  expect(validatePackV2(pack(descriptor))).toBe(true);
  const bytes = Uint8Array.of(1, 2, 3, 4);
  const selected = selectDecodedArtifactBytes(bytes, descriptor).unwrap();
  expect(selected).toEqual(Uint8Array.of(2, 3));
  selected.fill(9);
  expect(bytes).toEqual(Uint8Array.of(1, 2, 3, 4));
});

it.each([
  { decodedRange: { offset: -1, length: 2 } },
  { decodedRange: { offset: 0.5, length: 2 } },
  { decodedRange: { offset: 1, length: 0 } },
  { contentEncoding: 'identity' as const },
  { byteRange: undefined },
  { integrity: undefined },
  { delivery: 'stream' as const },
])('rejects malformed or contradictory group descriptors: %j', (change) => {
  const invalid = { ...descriptor, ...change };
  expect(decodedArtifactRangeIssue(invalid)).toBeDefined();
  expect(validatePackV2(pack(invalid))).toBe(false);
});

it('rejects a mismatched artifact length and out-of-bounds decoded windows', () => {
  expect(decodedArtifactRangeIssue({ ...descriptor, byteLength: 3 })).toBeDefined();
  expect(
    decodedArtifactRangeIssue({
      ...descriptor,
      decodedRange: { offset: Number.MAX_SAFE_INTEGER, length: 2 },
    }),
  ).toBeDefined();
  expect(selectDecodedArtifactBytes(Uint8Array.of(1, 2), descriptor).ok).toBe(false);
});

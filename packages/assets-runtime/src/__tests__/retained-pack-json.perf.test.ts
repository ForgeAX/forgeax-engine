import { expect, it } from 'vitest';
import { parseRetainedPackJson } from '../internal/retained-pack-json.js';

it('keeps dense numeric Pack parsing within a bounded multiple of the platform parser', () => {
  const text = `{"assets":[{"payload":{"vertices":[${'1,'.repeat(1_048_575)}1]}}]}`;
  let nativeMs = Infinity;
  let retainedMs = Infinity;
  for (let round = 0; round < 3; round++) {
    const readers =
      round % 2 === 0 ? [JSON.parse, parseRetainedPackJson] : [parseRetainedPackJson, JSON.parse];
    for (const read of readers) {
      const start = performance.now();
      const value = read(text) as { assets: { payload: { vertices: number[] } }[] };
      const elapsed = performance.now() - start;
      if (read === JSON.parse) nativeMs = Math.min(nativeMs, elapsed);
      else retainedMs = Math.min(retainedMs, elapsed);
      expect(value.assets[0]?.payload.vertices).toHaveLength(1_048_576);
      expect(value.assets[0]?.payload.vertices.at(-1)).toBe(1);
    }
  }
  // Paired samples and a wide allowance absorb host/coverage noise while
  // rejecting the index-string and scalar-queue amplification of a real Pack.
  expect(retainedMs).toBeLessThan(nativeMs * 8 + 20);
});

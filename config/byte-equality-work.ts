import { expect } from 'vitest';

/** Observe the actual matcher; returning undefined preserves its comparison. */
export function observeByteEqualityWork() {
  let active = true;
  const counts = { genericComparisons: 0, genericBytes: 0 };
  expect.addEqualityTesters([
    (actual: unknown, expected: unknown) => {
      if (
        active &&
        actual !== expected &&
        actual instanceof Uint8Array &&
        expected instanceof Uint8Array &&
        Math.max(actual.byteLength, expected.byteLength) >= 16 * 1024
      ) {
        counts.genericComparisons++;
        counts.genericBytes += actual.byteLength + expected.byteLength;
      }
      return undefined;
    },
  ]);
  return {
    get counts() {
      return { ...counts };
    },
    stop() {
      // Vitest has no public removal API; leave this file's tester inert.
      active = false;
    },
    assertNoGenericComparisons() {
      if (counts.genericComparisons !== 0)
        throw new Error(
          `Dawn byte-oracle work regressed: ${counts.genericComparisons} generic comparisons ` +
            `enumerated ${counts.genericBytes} payload bytes. Use equalBytes/equalByteMaps ` +
            'and keep independent provenance and full byte checks.',
        );
    },
  };
}

import { expect, it } from 'vitest';
import { runWorldBoundsIndexCases } from './world-bounds-index.fixture';

it('preserves full-scan payload, canonical tie order and fail-closed bounds admission', async () => {
  const result = await runWorldBoundsIndexCases('strict');
  expect(result.errors).toEqual([]);
  expect(result.initialCapacity).toBe(1024);
  expect(result.initialCount).toBe(128);
  // CPU command order is distinct from the GPU payload assertions below.
  expect(
    result.editWrites.map(({ target, offset, bytes }) => [target, offset, bytes.length]),
  ).toEqual([
    ['fields', 0, 4],
    ['settings', 60, 4],
    ['bounds', 28, 4],
    ['instances', 5 * 144, 144],
    ['bounds', 96 + 5 * 48, 48],
    ['fields', (4 + 5 * 20) * 4, 80],
    ...result.candidatePayloadSpans.map(([offset, length]) => ['fields', offset, length]),
    ['settings', 48, 16],
    ['fields', 0, 4],
  ]);
  expect(result.editWrites[0]?.bytes).toEqual([0, 0, 0, 0]);
  expect(result.editWrites[1]?.bytes).toEqual([0, 0, 0, 0]);
  for (const row of result.rows) {
    if (row.name.startsWith('bad-canonical')) {
      expectRejectedComposition(row.composeBytes);
    } else if (!row.name.includes('edit')) {
      expect(row.composeBytes).toEqual(result.baselineComposeBytes);
    }
  }
  for (const row of result.rows.filter((row) => !row.name.startsWith('mutant')))
    for (const [i, entry] of row.cases.entries()) {
      expect(entry.values.slice(0, 8), `${row.name} query ${i}`).toEqual(entry.values.slice(8, 16));
      expect(entry.values[18]).toBe(entry.values[19]);
      expect(entry.enumeration).toEqual([...entry.enumeration].sort((a, b) => a - b));
      expect(new Set(entry.enumeration).size).toBe(entry.enumeration.length);
      if (row.name.startsWith('bad-canonical')) {
        expect(entry.values[20]).toBe(4);
        expect(entry.values[21]).toBe(0);
        expect(entry.enumeration).toHaveLength(0);
      } else if (row.name !== 'indexed') {
        expect(entry.values[17]).toBe(0);
        expect(entry.enumeration).toHaveLength(128);
      }
    }
  const indexed = result.rows.find((row) => row.name === 'indexed');
  expect(indexed).toBeDefined();
  // Equal-distance overlap includes a canonical oversized row and ordinary rows.
  expect(indexed?.cases[0]?.values.slice(4, 8)).toEqual([500, 1000, 1001, 1002]);
  expect(indexed?.cases[0]?.values[22]).not.toBe(indexed?.cases[0]?.values[23]);
  expect(indexed?.cases[0]?.values[23]).toBe(0);
  const mutant = result.rows.find((row) => row.name === 'mutant-row-omission');
  expect(
    mutant?.cases.filter((entry) =>
      entry.values.slice(0, 8).some((value, k) => value !== entry.values[k + 8]),
    ).length,
  ).toBeGreaterThan(0);
  assertPlacementMoveCases(result);
}, 120_000);

it('keeps the indexed Card candidate payload after an enclosed placement move', async () => {
  const result = await runWorldBoundsIndexCases('retained-move');
  expect(result.errors).toEqual([]);
  const retained = result.rows.find((row) => row.name === 'edited-retained');
  expect(retained).toBeDefined();
  for (const [i, entry] of (retained?.cases ?? []).entries()) {
    expect(entry.values.slice(0, 8), `retained query ${i}`).toEqual(entry.values.slice(8, 16));
    expect(entry.values[18]).toBe(entry.values[19]);
    expect(entry.enumeration).toEqual([...entry.enumeration].sort((a, b) => a - b));
    expect(new Set(entry.enumeration).size).toBe(entry.enumeration.length);
  }
  const smallIndex = result.probes.findIndex(
    (probe) => probe.name === 'moved-row-5-within-cell-coverage',
  );
  const sample = retained?.cases[smallIndex];
  expect(sample?.values[17]).toBe(1);
  expect(sample?.enumeration).toContain(5);
  expect(sample?.enumeration.length).toBeLessThan(128);
  expect(sample?.values[3]).toBeGreaterThan(4);
  expect((sample?.values[1] ?? 0) & 2).toBe(2);
}, 60_000);

// The mutated shader has its own cold compile and first dispatch.
it('detects a missing World guard even when composition rejects the canonical pool', async () => {
  const result = await runWorldBoundsIndexCases('guard-mutant');
  expect(result.errors).toEqual([]);
  const guardMutant = result.rows[0];
  if (!guardMutant) throw Error('Canonical guard mutant is required');
  expectRejectedComposition(guardMutant.composeBytes);
  expect(guardMutant.cases.filter((entry) => entry.values[20] !== 4).length).toBeGreaterThan(0);
}, 120_000);

function expectRejectedComposition(composeBytes: readonly number[]) {
  const words = new Uint32Array(Uint8Array.from(composeBytes).buffer);
  expect(
    Array.from(words)
      .filter((_, i) => i % 4 === 2)
      .every((status) => status === 2),
  ).toBe(true);
}

function assertPlacementMoveCases(result: Awaited<ReturnType<typeof runWorldBoundsIndexCases>>) {
  const movedQuery = result.probes.findIndex(
    (probe) => probe.name === 'moved-row-5-inside-old-domain',
  );
  const edited = result.rows.find((row) => row.name === 'edited-disabled')?.cases[movedQuery];
  expect(edited?.values[17]).toBe(0);
  expect(edited?.enumeration).toContain(5);
  expect(edited?.values.slice(4, 8)).toContain(1005);
  const stale = result.rows.find((row) => row.name === 'mutant-edit-without-disable')?.cases[
    movedQuery
  ];
  // Staying indexed proves this is inside the old CSR domain, not an outside
  // query whose automatic full-scan fallback would hide the invalidation bug.
  expect(stale?.values[17]).toBe(1);
  expect(stale?.enumeration).not.toContain(5);
  expect(stale?.values.slice(12, 16)).toContain(1005);
  expect(stale?.values.slice(0, 8)).not.toEqual(stale?.values.slice(8, 16));
}

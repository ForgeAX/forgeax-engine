import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('retains complete runtime sources without duplicating analyzed bodies in lazy accessors', () => {
  // Measure the program's owner, independently of earlier shared Vitest modules
  // and fixtures whose heap snapshot can exceed V8's string-reading limit.
  const observed = JSON.parse(
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL('./material-program-retention.fixture.mjs', import.meta.url))],
      { encoding: 'utf8', timeout: 25_000, maxBuffer: 1024 * 1024 },
    ),
  ) as { fullBodies: number; sourceLengths: number[] };
  expect(observed.sourceLengths).toHaveLength(3);
  // Keep one body per program; V8 may also retain its latest RegExp input.
  expect(observed.fullBodies).toBeGreaterThanOrEqual(observed.sourceLengths.length);
  expect(observed.fullBodies).toBeLessThanOrEqual(observed.sourceLengths.length + 1);
  for (const length of observed.sourceLengths) expect(length).toBeGreaterThan(2 * 1024 * 1024);
}, 30000);

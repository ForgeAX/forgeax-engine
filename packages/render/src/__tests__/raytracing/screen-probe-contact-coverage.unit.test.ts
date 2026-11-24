import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { screenProbeWorldWgsl } from '../../raytracing/screen-probe-kernels';
import { validateSdfSurfacePoolHeader } from '../../raytracing/sdf-surface-storage';
import {
  checkContactCoverage,
  screenContactCoverageCases,
  screenContactCoverageCode,
} from './screen-probe-contact-coverage.fixture';

it('retains real placement packet bytes and distinguishes UNKNOWN from malformed coverage', async () => {
  const cases = await screenContactCoverageCases();
  expect(cases).toHaveLength(6);
  for (const row of cases) {
    const bytes = row.composition.data.fields;
    expect(bytes).toBeInstanceOf(Uint8Array);
    const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const valid = validateSdfSurfacePoolHeader(words, 0, 1).ok;
    expect(valid, row.name).toBe(!row.name.includes('record') && !row.name.includes('tail'));
    if (row.name === 'opaque-selected' || row.name === 'unknown-selected') {
      const record = words[7] ?? 0,
        bits = (words[record + 3] ?? 0) + 4;
      expect(words[record + 2]).toBe(2);
      expect(words[bits]).toBe(row.ready ? 1 : 2);
    }
  }
  // Assessor controls are CPU records, never passed off as real GPU proof.
  const raw = new Uint8Array(96 + 64 * 32),
    words = new Uint32Array(raw.buffer);
  for (let ray = 0; ray < 64; ray++) words[24 + ray * 8 + 3] = 4 << 12;
  expect(() => checkContactCoverage(raw, false, 4)).not.toThrow();
  words[24 + 3] = 0;
  expect(() => checkContactCoverage(raw, false, 4)).toThrow();
  expect(() => checkContactCoverage(raw.subarray(4), false, 4)).toThrow();
});

it('composes actual receiver, contact and World rejection source for each independent gate mutant', async () => {
  const actual = screenProbeWorldWgsl('global-sdf');
  for (const variant of ['production', 'prepare-removed', 'contact-removed'] as const) {
    const source = screenContactCoverageCode(variant);
    expect(actual.includes(source.prefix)).toBe(true);
    const compiled = (
      await compileShader(source.code, { id: `screen-contact-coverage-${variant}` })
    ).unwrap();
    expect(compiled.reflection.boundGlobals.find((row) => row.binding === 6)?.elementStride).toBe(
      96,
    );
    expect(compiled.reflection.boundGlobals.find((row) => row.binding === 7)?.elementStride).toBe(
      32,
    );
    expect(compiled.reflection.entryPoints?.map((row) => row.name)).toEqual(
      expect.arrayContaining(['prepareScreenReceivers', 'traceWorldProbes']),
    );
  }
});

import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { booleanSetOutcomes, runSpikeVariant, spikeReport, spikeVariants } from './bevel-spike';

const REPORT = new URL('../../reports/bevel-spike.json', import.meta.url);

describe('bevel spike set (design 16)', () => {
  it('replaces every selected edge in at least 95% of the parametric hard-surface variants', {
    timeout: 600000,
  }, () => {
    const variants = spikeVariants();
    expect(variants.length).toBeGreaterThanOrEqual(200);
    // Design 16 "the same set": every boolean spike result, bevelled at all creases.
    const booleanSet = spikeReport(booleanSetOutcomes());
    const report = {
      ...spikeReport(variants.map(runSpikeVariant)),
      booleanSet: { ...booleanSet, failures: booleanSet.failures.slice(0, 24) },
    };
    if (process.env.FORGEAX_UPDATE_GOLDEN === '1') {
      writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
    }
    expect(report.effectRate).toBeGreaterThanOrEqual(0.95);
    expect(report.validRate).toBeGreaterThanOrEqual(0.95);
    expect(booleanSet.effectRate).toBeGreaterThanOrEqual(0.95);
    expect(booleanSet.validRate).toBeGreaterThanOrEqual(0.95);
    // The committed report is the measured artifact; regenerate with FORGEAX_UPDATE_GOLDEN=1.
    expect(report).toEqual(JSON.parse(readFileSync(REPORT, 'utf8')));
  });
});

import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { rasterCases, verifyRasterCase } from './material-raster-state-fixture';

describe('material raster state RHI Debug Dawn evidence', () => {
  it.each(rasterCases)('$name', async (testCase) => {
    const { bytes, ...evidence } = await verifyRasterCase(testCase);
    const output = 'artifacts/material-raster-state';
    mkdirSync(output, { recursive: true });
    writeFileSync(`${output}/${testCase.name}.rhitape`, bytes);
    writeFileSync(`${output}/${testCase.name}.json`, JSON.stringify(evidence, null, 2));
  }, 60_000);
});

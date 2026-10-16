import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

const validate = new Ajv2020().compile(
  JSON.parse(readFileSync(new URL('../../schema/material.schema.json', import.meta.url), 'utf8')),
);
const material = (renderState: Record<string, unknown>) => ({
  kind: 'material',
  passes: [{ name: 'forward', program: { module: 'test' }, renderState }],
});

describe('material raster state JSON boundary', () => {
  it.each([
    {},
    { colorWriteMask: 0 },
    { colorWriteMask: 15, depthBias: -2147483648, depthBiasSlopeScale: -1, depthBiasClamp: -0.1 },
    { depthBias: 2147483647 },
  ])('admits valid state %s', (state) => {
    expect(validate(material(state))).toBe(true);
  });
  it.each([
    { colorWriteMask: 16 },
    { colorWriteMask: -1 },
    { colorWriteMask: 1.5 },
    { depthBias: 0.5 },
    { depthBias: 2147483648 },
    { depthBias: -2147483649 },
    { depthBiasSlopeScale: Infinity },
    { depthBiasClamp: NaN },
  ])('rejects invalid GPU state %s', (state) => {
    expect(validate(material(state))).toBe(false);
  });
});

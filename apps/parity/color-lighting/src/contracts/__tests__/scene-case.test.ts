import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import type { CaptureConfig } from '../../capture/named-capture';
import { createForgeaxAdapter } from '../../adapters/forgeax-adapter';
import { createThreeAdapter } from '../../adapters/three-adapter';
import { runParityMatrix } from '../../cli/run-parity';
import { validateSceneCase } from '../load-scene-case';
import type { SceneCase } from '../types';

const schemaPath = resolve(import.meta.dirname, '../../../schemas/scene-case.schema.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as object;
const validateSchema = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

const minimalCase = {
  caseId: 'm0-minimal',
  required: true,
  colorDomain: 'linearLdr',
  scene: { width: 1, height: 1, background: [0, 0, 0, 1] },
  budget: { analyticMax: 0.01, roiMax: 0.01, byteMax: 0 },
} as const;

describe('SceneCase schema and entry contract', () => {
  it('accepts the legal minimum case', () => {
    expect(validateSchema(minimalCase)).toBe(true);
    expect(validateSceneCase(minimalCase).ok).toBe(true);
  });

  it.each([
    ['missing required field', { ...minimalCase, scene: undefined }],
    ['negative budget', { ...minimalCase, budget: { ...minimalCase.budget, roiMax: -1 } }],
    ['unknown color domain', { ...minimalCase, colorDomain: 'gammaMagic' }],
    ['non-finite budget', { ...minimalCase, budget: { ...minimalCase.budget, analyticMax: Number.NaN } }],
    ['unknown field', { ...minimalCase, unexpected: true }],
  ])('%s is rejected with a field location', (_name, value) => {
    const result = validateSceneCase(value);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid scene case');
    expect(result.error.detail.path.length).toBeGreaterThan(0);
  });

  it('defaults omitted comparison to rgba and accepts the alpha selectors', () => {
    expect(validateSceneCase(minimalCase).ok).toBe(true);
    for (const primaryMetric of ['rgba', 'alpha', 'occupancy'] as const) {
      const result = validateSceneCase({ ...minimalCase, comparison: { primaryMetric } });
      expect(result.ok).toBe(true);
    }
  });

  it('rejects an unknown primary metric', () => {
    const result = validateSceneCase({ ...minimalCase, comparison: { primaryMetric: 'rgb' } });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid primary metric');
    expect(result.error.detail.path).toContain('primaryMetric');
  });
});

const captureConfig: CaptureConfig = {
  width: 1,
  height: 1,
  colorDomain: 'linearLdr',
  background: [0, 0, 0, 0],
};

function parityCase(primaryMetric?: 'rgba' | 'alpha' | 'occupancy'): SceneCase {
  return {
    ...minimalCase,
    ...(primaryMetric === undefined ? {} : { comparison: { primaryMetric } }),
  } as SceneCase;
}

function capture(final: readonly number[]) {
  return { linear: final, final, config: captureConfig };
}

describe('primary metric capture comparison', () => {
  it('keeps default rgba byte-diff falsification as a recognized failure', async () => {
    const forgeax = createForgeaxAdapter(async () => capture([10, 20, 30, 40]));
    const three = createThreeAdapter(async () => capture([11, 20, 30, 40]));
    const result = await runParityMatrix([parityCase()], forgeax, three, {
      expectedErrors: { 'm0-minimal': 'budget-exceeded' },
    });

    expect(result.ok).toBe(true);
    expect(result.cases[0]?.report.metrics.differingBytes).toBe(1);
    expect(result.cases[0]?.report.captures.forgeax.final).toEqual([10, 20, 30, 40]);
    expect(result.cases[0]?.report.captures.three.final).toEqual([11, 20, 30, 40]);
  });

  it('uses only alpha for the alpha selector', async () => {
    const forgeax = createForgeaxAdapter(async () => capture([10, 20, 30, 40]));
    const three = createThreeAdapter(async () => capture([200, 201, 202, 40]));
    const result = await runParityMatrix([parityCase('alpha')], forgeax, three);

    expect(result.ok).toBe(true);
    expect(result.cases[0]?.report.metrics).toEqual({ analyticMax: 0, roiMax: 0, differingBytes: 0 });
  });

  it('uses binary alpha visibility for occupancy', async () => {
    const forgeax = createForgeaxAdapter(async () => capture([10, 20, 30, 0]));
    const three = createThreeAdapter(async () => capture([200, 201, 202, 128]));
    const result = await runParityMatrix([parityCase('occupancy')], forgeax, three, {
      expectedErrors: { 'm0-minimal': 'budget-exceeded' },
    });

    expect(result.ok).toBe(true);
    expect(result.cases[0]?.report.metrics).toEqual({ analyticMax: 1, roiMax: 1, differingBytes: 1 });
  });
});

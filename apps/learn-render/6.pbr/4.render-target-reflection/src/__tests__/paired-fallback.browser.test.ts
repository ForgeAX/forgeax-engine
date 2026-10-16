import browserSchema from '../../../../../../schemas/ssr-fallback/browser/manifest.schema.json';
import dawnSchema from '../../../../../../schemas/ssr-fallback/dawn/manifest.schema.json';
import { REFLECTION_FALLBACK_EXPECTATION_IDS } from '../../scripts/ssr-fallback-evidence.mjs';
import { describe, expect, it } from 'vitest';

const identity = {
  sourceHead: 'source-head-v1',
  sourceTree: 'source-tree-v1',
  lockSha256: 'lock-v1',
  buildSha256: 'build-v1',
};

const makeManifest = (lane: 'browser' | 'dawn') => ({
  schemaVersion: 'ssr-fallback-evidence/1',
  featureId: 'feat-ssr-fallback-fixture-v1',
  lane,
  status: 'pass',
  identity,
  fixture: { revision: 'fixture-v1', frames: 60 },
  execution: lane === 'browser'
    ? { url: 'http://127.0.0.1:4173/?forgeaxEvidence=reflection-fallback', backend: 'webgpu', frames: 60 }
    : { locator: 'artifacts/ssr-fallback/dawn/manifest.json', backend: 'dawn', frames: 60 },
  readback: { locator: 'readback.json', byteLength: 64, validationLog: 'validation.log' },
  png: { locator: 'frame.png', width: 256, height: 256 },
  thresholds: { linearHdrAbsErrorMax: 0.05, hdrLumaRelativeErrorMax: 0.02 },
  expectations: REFLECTION_FALLBACK_EXPECTATION_IDS.map((id) => ({
    id,
    observed: 'blocked until the matching runtime scenario executes',
    verdict: 'blocked' as const,
    confidence: 0,
  })),
});

const requiredFields = [
  'schemaVersion',
  'featureId',
  'lane',
  'status',
  'identity',
  'fixture',
  'execution',
  'readback',
  'png',
  'thresholds',
  'expectations',
];

const assertRequired = (manifest: Record<string, unknown>, schema: { required: string[] }) => {
  for (const field of schema.required) expect(manifest[field]).toBeDefined();
};

const assertPairedIdentity = (browser: ReturnType<typeof makeManifest>, dawn: ReturnType<typeof makeManifest>) => {
  expect(browser.identity).toEqual(dawn.identity);
  expect(browser.fixture).toEqual(dawn.fixture);
  expect(browser.thresholds).toEqual(dawn.thresholds);
};

describe('SSR fallback paired Browser manifest contract', () => {
  it('requires the same identity, 60-frame fixture, readback, PNG, thresholds, and expectations in both lanes', () => {
    expect(browserSchema.required).toEqual(requiredFields);
    expect(dawnSchema.required).toEqual(requiredFields);
    const browser = makeManifest('browser');
    const dawn = makeManifest('dawn');
    assertRequired(browser, browserSchema);
    assertRequired(dawn, dawnSchema);
    assertPairedIdentity(browser, dawn);
    expect(browser.execution).toMatchObject({ backend: 'webgpu', frames: 60 });
    expect(dawn.execution).toMatchObject({ backend: 'dawn', frames: 60 });
    expect(browser.readback).toBeDefined();
    expect(browser.png).toBeDefined();
    expect(browser.expectations[0]).toMatchObject({ verdict: 'blocked', confidence: 0 });
    expect(browser.expectations.map(({ id }) => id)).toEqual(REFLECTION_FALLBACK_EXPECTATION_IDS);
    expect(browser.expectations).toHaveLength(REFLECTION_FALLBACK_EXPECTATION_IDS.length);
  });

  it('rejects a missing lane field, an old identity, or a missing evidence field', () => {
    const browser = makeManifest('browser');
    expect(() => assertRequired({ ...browser, lane: undefined }, browserSchema)).toThrow();
    const oldDawn = makeManifest('dawn');
    oldDawn.identity = { ...oldDawn.identity, sourceHead: 'old-source-head' };
    expect(() => assertPairedIdentity(browser, oldDawn)).toThrow();
    const incomplete = { ...browser, png: undefined };
    expect(() => assertRequired(incomplete, browserSchema)).toThrow();
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import probe from '../probe.json' with { type: 'json' };
import recovery from '../recovery.json' with { type: 'json' };
import rectArea from '../rect-area.json' with { type: 'json' };
import spotModifiers from '../spot-modifiers.json' with { type: 'json' };
import { validateSceneCase } from '../../../src/contracts/load-scene-case';

const schemaRoot = resolve(import.meta.dirname, '../../../schemas');
const readSchema = (name: string): object => JSON.parse(readFileSync(resolve(schemaRoot, name), 'utf8')) as object;

describe('M6 extended-lighting carriers', () => {
  it.each([
    ['rect-area', rectArea],
    ['spot-modifiers', spotModifiers],
    ['probe', probe],
    ['recovery', recovery],
  ])('validates the %s carrier through the shared SceneCase contract', (carrier, fixture) => {
    const result = validateSceneCase(fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.extendedLighting?.carrier).toBe(carrier);
    expect(result.value.extendedLighting?.evidencePlan.identity.fixtureId).toBe(result.value.caseId);
    expect(result.value.extendedLighting?.evidencePlan.recordReceipt).toMatchObject({ byteLength: 160, maxBytes: 160 });
  });

  it('accepts the shared not-run carrier report and visual evidence shapes', () => {
    const report = {
      schemaVersion: 4,
      kind: 'extended-lighting',
      caseId: 'probe',
      required: true,
      invocationId: 'm6-probe-not-run',
      sourceFixtureHash: 'a'.repeat(64),
      exactHead: 'workspace-source',
      carrier: 'probe',
      expectations: ['probe-diffuse-only'],
      identity: { fixtureId: 'probe', sourceKey: 'parity/extended-lighting/probe', generation: 0 },
      observed: { state: 'not-run', summary: 'GPU carrier unavailable' },
      numericRoi: { analyticMax: 0.000001, roiMax: 0.05, epsilon: 0.000001, colorDomain: 'linearHdr' },
      recordReceipt: { status: 'not-run', byteLength: 160, maxBytes: 160 },
      resourceReceipt: { status: 'not-run', topology: 'extendedLighting', resourceCount: 0, uploadBytes: 0 },
      falsifier: [{ id: 'sky-not-contributor', status: 'not-run', observed: 'GPU unavailable', verdict: 'notRun' }],
      verdict: 'notRun',
      confidence: 'low',
      status: 'blocked',
    };
    const evidence = {
      evidenceKind: 'extended-lighting',
      caseId: 'probe',
      width: 64,
      height: 64,
      background: [0, 0, 0, 1],
      framing: 'shared color-lighting fixture',
      colorDomain: 'linearHdr',
      frameCount: 60,
      epsilon: { rgb: 0.000001 },
      sourceFixtureHash: 'a'.repeat(64),
      producers: {
        browser: {
          status: 'not-run', observed: 'WebGPU unavailable', verdict: 'notRun', confidence: 'low',
          identity: 'browser:probe:generation-0',
          numericRoi: { analyticMax: 0.000001, roiMax: 0.05, epsilon: 0.000001, colorDomain: 'linearHdr' },
          recordReceipt: { status: 'not-run', byteLength: 160 },
          resourceReceipt: { status: 'not-run', topology: 'extendedLighting', resourceCount: 0, uploadBytes: 0 },
        },
        dawn: {
          status: 'unavailable', observed: 'Dawn unavailable', verdict: 'notRun', confidence: 'low',
          identity: 'dawn:probe:generation-0',
          numericRoi: { analyticMax: 0.000001, roiMax: 0.05, epsilon: 0.000001, colorDomain: 'linearHdr' },
          recordReceipt: { status: 'not-run', byteLength: 160 },
          resourceReceipt: { status: 'not-run', topology: 'extendedLighting', resourceCount: 0, uploadBytes: 0 },
        },
      },
      falsifier: [{ id: 'sky-not-contributor', status: 'not-run', observed: 'GPU unavailable', verdict: 'notRun', confidence: 'low' }],
      artifacts: [
        { kind: 'forgeax-final', url: 'not-run://probe/forgeax', caseId: 'probe', width: 64, height: 64, background: [0, 0, 0, 1], frameId: 0, rawHash: '0'.repeat(64), observed: 'not-run', verdict: 'unknown', confidence: 'low' },
        { kind: 'three-primary-final', url: 'not-run://probe/three', caseId: 'probe', width: 64, height: 64, background: [0, 0, 0, 1], frameId: 0, rawHash: '0'.repeat(64), observed: 'not-run', verdict: 'unknown', confidence: 'low' },
        { kind: 'diff-roi', url: 'not-run://probe/diff', caseId: 'probe', width: 64, height: 64, background: [0, 0, 0, 1], frameId: 0, rawHash: '0'.repeat(64), observed: 'not-run', verdict: 'unknown', confidence: 'low' },
      ],
    };
    const validateReport = new Ajv2020({ allErrors: true, strict: false }).compile(readSchema('case-report.schema.json'));
    const validateEvidence = new Ajv2020({ allErrors: true, strict: false }).compile(readSchema('visual-evidence.schema.json'));
    expect(validateReport(report), validateReport.errors).toBe(true);
    expect(validateEvidence(evidence), validateEvidence.errors).toBe(true);
  });
});

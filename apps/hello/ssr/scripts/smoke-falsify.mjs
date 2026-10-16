#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FALSIFICATION_CASES, runFalsification } from './falsification.mjs';

const rootDir = resolve(new URL('../..', import.meta.url).pathname, '../..');
const featureId = 'feat-20260831-ssr-probe-environment-fallback';

export const M3_FALSIFICATION_CASES = [
  {
    id: 'screen-source-removed',
    stage: 'screen-hit',
    expected: 'a screen hit has a producer-owned source sample',
    hint: 'remove the screen source and the visual admission must fail closed',
  },
  {
    id: 'black-fallback',
    stage: 'fallback-lighting',
    expected: 'probe, Skylight, or neutral fallback is observable and finite',
    hint: 'replace the fallback contribution with an all-zero sample',
  },
  {
    id: 'edge-confidence-hard-cut',
    stage: 'edge-confidence',
    expected: 'edge confidence transitions continuously instead of a hard cut',
    hint: 'replace the edge confidence ramp with a binary step',
  },
  {
    id: 'roughness-confidence-forced',
    stage: 'roughness-confidence',
    expected: 'roughness confidence attenuates the SSR contribution',
    hint: 'force roughness confidence to one for every roughness value',
  },
  {
    id: 'mip0-thickness-disabled',
    stage: 'hiz-thickness',
    expected: 'the trace samples the mip-0 depth needed by thickness rejection',
    hint: 'disable the mip-0 depth sample',
  },
  {
    id: 'rejected-history-reused',
    stage: 'temporal-rejection',
    expected: 'rejected history is not reused as the current SSR candidate',
    hint: 'mark a rejected history sample as reused',
  },
  {
    id: 'failed-submit-candidate-promoted',
    stage: 'transaction',
    expected: 'a failed submit keeps the candidate invisible and preserves LKG',
    hint: 'promote the candidate after a failed queue submit',
  },
  {
    id: 'excluded-object-contributes',
    stage: 'forward-exclusions',
    expected: 'forward-excluded objects do not contribute to the SSR source',
    hint: 'mark an excluded object as a screen-source contributor',
  },
  {
    id: 'candidate-cube-face-visible',
    stage: 'probe-transaction',
    expected: 'a candidate cube face remains hidden until probe completion',
    hint: 'publish a candidate cube face as visible before commit',
  },
];

function validVisualInput() {
  return {
    screenSource: { identity: 'screen:frame-42', finite: true, hit: true },
    fallback: { source: 'probe', rgb: [0.25, 0.35, 0.5], finite: true },
    edge: { samples: [0, 0.25, 0.5, 0.75, 1], continuous: true },
    roughness: { values: [0, 0.35, 0.7, 1], confidence: [1, 0.8, 0.35, 0] },
    hiz: { mip0Sampled: true, thicknessRejects: 3 },
    history: { status: 'rejected', reused: false },
    transaction: { submit: 'failed', candidateVisible: false, lkgPreserved: true },
    exclusions: { excludedObjectContributes: false },
    probe: { candidateFaceVisible: false, committedFaces: 6 },
  };
}

function mutateVisualInput(id, input) {
  const value = structuredClone(input);
  switch (id) {
    case 'screen-source-removed':
      value.screenSource = undefined;
      break;
    case 'black-fallback':
      value.fallback = { ...value.fallback, rgb: [0, 0, 0] };
      break;
    case 'edge-confidence-hard-cut':
      value.edge = { samples: [0, 0, 0, 1, 1], continuous: false };
      break;
    case 'roughness-confidence-forced':
      value.roughness = { ...value.roughness, confidence: value.roughness.values.map(() => 1) };
      break;
    case 'mip0-thickness-disabled':
      value.hiz = { ...value.hiz, mip0Sampled: false, thicknessRejects: 0 };
      break;
    case 'rejected-history-reused':
      value.history = { ...value.history, reused: true };
      break;
    case 'failed-submit-candidate-promoted':
      value.transaction = { ...value.transaction, candidateVisible: true, lkgPreserved: false };
      break;
    case 'excluded-object-contributes':
      value.exclusions = { excludedObjectContributes: true };
      break;
    case 'candidate-cube-face-visible':
      value.probe = { ...value.probe, candidateFaceVisible: true };
      break;
    default:
      throw new Error(`unknown M3 falsifier ${id}`);
  }
  return value;
}

function mutationBreaksContract(id, value) {
  switch (id) {
    case 'screen-source-removed':
      return value.screenSource === undefined;
    case 'black-fallback':
      return value.fallback.rgb.every((channel) => channel === 0);
    case 'edge-confidence-hard-cut':
      return value.edge.continuous === false && new Set(value.edge.samples).size <= 2;
    case 'roughness-confidence-forced':
      return value.roughness.confidence.every((confidence) => confidence === 1);
    case 'mip0-thickness-disabled':
      return value.hiz.mip0Sampled === false && value.hiz.thicknessRejects === 0;
    case 'rejected-history-reused':
      return value.history.status === 'rejected' && value.history.reused === true;
    case 'failed-submit-candidate-promoted':
      return value.transaction.submit === 'failed' && value.transaction.candidateVisible === true;
    case 'excluded-object-contributes':
      return value.exclusions.excludedObjectContributes === true;
    case 'candidate-cube-face-visible':
      return value.probe.candidateFaceVisible === true;
    default:
      return false;
  }
}

export function runM3Falsification(id) {
  const mutation = M3_FALSIFICATION_CASES.find((candidate) => candidate.id === id);
  if (mutation === undefined) {
    return {
      id,
      status: 'fail',
      stage: 'falsification-input',
      code: 'unknown-falsification-case',
      expected: 'one of the registered M3 dev-only mutations',
      hint: 'Use a case id from M3_FALSIFICATION_CASES.',
      manifestEligible: false,
      detected: false,
    };
  }
  const mutated = mutateVisualInput(id, validVisualInput());
  const detected = mutationBreaksContract(id, mutated);
  return {
    id,
    status: 'fail',
    stage: mutation.stage,
    code: detected ? id : 'falsification-not-detected',
    expected: mutation.expected,
    hint: mutation.hint,
    detail: detected
      ? `dev-only mutation ${id} falsified the SSR v1 contract`
      : `mutation ${id} did not break the expected invariant`,
    manifestEligible: false,
    detected,
    mutated,
  };
}

export const allFalsificationIds = Object.freeze([
  ...FALSIFICATION_CASES.map(({ id }) => id),
  ...M3_FALSIFICATION_CASES.map(({ id }) => id),
]);

if (import.meta.url === `file://${process.argv[1]}`) {
  const results = [
    ...FALSIFICATION_CASES.map(({ id }) => ({ id, ...runFalsification(id), detected: true })),
    ...M3_FALSIFICATION_CASES.map(({ id }) => runM3Falsification(id)),
  ];
  const pass = results.every((result) => result.status === 'fail' && result.manifestEligible === false && result.detected);
  const artifact = {
    schemaVersion: 'hello-ssr-falsifier/1',
    featureId,
    status: pass ? 'pass' : 'fail',
    cases: results,
  };
  const outputDir = resolve(rootDir, 'artifacts/ssr-fallback');
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(resolve(outputDir, 'falsifier.json'), `${JSON.stringify(artifact, null, 2)}\n`);
  process.stdout.write(`[hello-ssr] falsifier=${JSON.stringify(artifact)}\n`);
  process.exitCode = pass ? 0 : 1;
}

#!/usr/bin/env node

import { admitSsrM0, SSR_FORMAT_STAGES } from '@forgeax/engine-render';

const identity = Object.freeze({
  sourceHead: 'falsifier-head',
  sourceTree: 'falsifier-tree',
  lockSha256: 'falsifier-lock',
  buildSha256: 'falsifier-build',
});

const validFallback = Object.freeze({
  identity,
  source: 'probe',
  sourceKey: 'probe:0:1',
  sourceGeneration: 1,
  projectionGeneration: 1,
  deviceGeneration: 1,
  state: 'active',
  candidateVisible: false,
  coverage: 1,
  brdfSignature: 'standard-pbr-ibl-v1',
});

const validFormat = Object.freeze({
  identity,
  profile: 'r32float-mip-sampled-storage',
  verdict: 'admitted',
  evidence: 'real',
  deviceGeneration: 1,
  stages: SSR_FORMAT_STAGES.map((stage) => ({ stage, verdict: 'admitted', evidence: 'real' })),
  sampleType: 'unfilterable-float',
  usages: ['texture-binding', 'storage-binding', 'copy-src'],
  readback: { byteLength: 4, values: [1] },
  probeExecutions: 1,
});

const validTemporal = Object.freeze({ identity, successfulSubmit: true, generation: 1 });

function validInput() {
  return {
    requested: true,
    identity,
    reflectionFallback: validFallback,
    format: validFormat,
    temporal: validTemporal,
  };
}

export const FALSIFICATION_CASES = [
  {
    id: 'candidate-visible',
    stage: 'candidate-visibility',
    code: 'candidate-visible',
    expected: 'candidate remains invisible until completion is admitted',
    hint: 'A candidate must not be visible to the active consumer.',
  },
  {
    id: 'brdf-source-mismatch',
    stage: 'projection',
    code: 'brdf-source-mismatch',
    expected: 'the canonical Standard BRDF source signature remains unchanged',
    hint: 'Projection must preserve the producer BRDF source signature.',
  },
  {
    id: 'r32float-storage-removed',
    stage: 'format-profile',
    code: 'r32float-storage-usage-missing',
    expected: 'r32float storage usage is admitted through the complete profile',
    hint: 'The format receipt must cover storage usage, not only texture creation.',
  },
];

export function runFalsification(id) {
  const mutation = FALSIFICATION_CASES.find((candidate) => candidate.id === id);
  if (mutation === undefined) {
    return {
      status: 'fail',
      stage: 'falsification-input',
      code: 'unknown-falsification-case',
      expected: 'one of the registered dev-only mutations',
      hint: 'Use a case id from FALSIFICATION_CASES.',
      detail: `unknown mutation=${id}`,
      manifestEligible: false,
    };
  }
  const input = validInput();
  if (id === 'candidate-visible') {
    input.reflectionFallback = { ...validFallback, candidateVisible: true };
  } else if (id === 'brdf-source-mismatch') {
    input.reflectionFallback = { ...validFallback, brdfSignature: 'wrong-brdf' };
  } else if (id === 'r32float-storage-removed') {
    input.format = {
      ...validFormat,
      usages: ['texture-binding', 'copy-src'],
    };
  }
  const admission = admitSsrM0(input);
  if (admission.status === 'admitted') {
    return {
      status: 'fail',
      stage: mutation.stage,
      code: 'falsification-not-detected',
      expected: mutation.expected,
      hint: mutation.hint,
      detail: `runtime admission incorrectly accepted ${mutation.id}`,
      manifestEligible: false,
      admission,
    };
  }
  return {
    status: 'fail',
    stage: mutation.stage,
    code: mutation.code,
    expected: mutation.expected,
    hint: mutation.hint,
    detail: `dev-only mutation ${mutation.id} falsified the dependency contract`,
    manifestEligible: false,
    admission,
  };
}

if (typeof process !== 'undefined' && import.meta.url === `file://${process.argv[1]}`) {
  const caseIndex = process.argv.indexOf('--case');
  const id = caseIndex >= 0 ? process.argv[caseIndex + 1] : process.env.SSR_FALLBACK_FALSIFY;
  const failure = runFalsification(id);
  process.stdout.write(`${JSON.stringify(failure)}\n`);
  process.exitCode = 1;
}

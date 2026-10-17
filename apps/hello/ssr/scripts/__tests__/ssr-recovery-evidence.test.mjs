import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveReflectionProbeRecoveryEvidence } from '../ssr-fallback-evidence.mjs';

const recoveredInspection = () => ({
  frame: { frameId: 108, deviceGeneration: 1 },
  reflectionProbes: {
    activeCount: 1,
    rawFacesCaptured: 6,
    filteredStepsCompleted: 30,
    reflectionFallbacks: [{
      source: 'probe',
      state: 'active',
      candidateVisible: false,
      frameId: 108,
      deviceGeneration: 1,
    }],
    reflectionFallbackReadback: {
      readbackStatus: 'complete',
      frameId: 108,
      deviceGeneration: 1,
    },
  },
  ssr: { status: 'admitted', history: { state: 'stable', bytes: 393216 } },
  ssrDependencies: { temporal: { successfulSubmit: true, generation: 1 } },
});

test('a promoted probe still needs a later completed probe consumer receipt', () => {
  const inspection = recoveredInspection();
  inspection.frame.frameId = 107;
  inspection.reflectionProbes.reflectionFallbacks[0].source = 'skylight';
  inspection.reflectionProbes.reflectionFallbacks[0].frameId = 107;
  inspection.reflectionProbes.reflectionFallbackReadback.frameId = 107;
  const promoted = deriveReflectionProbeRecoveryEvidence(inspection, 0);
  assert.equal(inspection.reflectionProbes.activeCount, 1);
  assert.equal(promoted.replacementSsrReady, true);
  assert.equal(promoted.matchingReplacement, false);

  const consumed = deriveReflectionProbeRecoveryEvidence(recoveredInspection(), 0);
  assert.equal(consumed.matchingReplacement, true);
  assert.equal(consumed.replacementSsrReady, true);
});

for (const [name, mutate] of [
  ['mismatched frame', (inspection) => {
    inspection.reflectionProbes.reflectionFallbackReadback.frameId = 107;
  }],
  ['old probe generation', (inspection) => {
    inspection.reflectionProbes.reflectionFallbacks[0].deviceGeneration = 0;
    inspection.reflectionProbes.reflectionFallbackReadback.deviceGeneration = 0;
  }],
  ['old readback generation', (inspection) => {
    inspection.reflectionProbes.reflectionFallbackReadback.deviceGeneration = 0;
  }],
  ['unfinished readback', (inspection) => {
    inspection.reflectionProbes.reflectionFallbackReadback.readbackStatus = 'pending';
  }],
  ['visible candidate', (inspection) => {
    inspection.reflectionProbes.reflectionFallbacks[0].candidateVisible = true;
  }],
  ['LKG receipt', (inspection) => {
    inspection.reflectionProbes.reflectionFallbacks[0].state = 'lkg';
  }],
]) {
  test(`recovery rejects a ${name}`, () => {
    const inspection = recoveredInspection();
    mutate(inspection);
    const evidence = deriveReflectionProbeRecoveryEvidence(inspection, 0);
    assert.equal(evidence.matchingReplacement, false);
    assert.equal(evidence.replacementSsrReady, true);
  });
}

test('a matching receipt cannot establish recovery without a new device generation', () => {
  const evidence = deriveReflectionProbeRecoveryEvidence(recoveredInspection(), 1);
  assert.equal(evidence.generationChanged, false);
  assert.equal(evidence.matchingReplacement, false);
});

for (const [name, mutate] of [
  ['unadmitted SSR', (inspection) => { inspection.ssr.status = 'off'; }],
  ['unstable history', (inspection) => { inspection.ssr.history.state = 'reset'; }],
  ['empty history', (inspection) => { inspection.ssr.history.bytes = 0; }],
  ['unsuccessful temporal submission', (inspection) => {
    inspection.ssrDependencies.temporal.successfulSubmit = false;
  }],
  ['old temporal generation', (inspection) => {
    inspection.ssrDependencies.temporal.generation = 0;
  }],
]) {
  test(`a matching probe receipt still rejects ${name}`, () => {
    const inspection = recoveredInspection();
    mutate(inspection);
    const evidence = deriveReflectionProbeRecoveryEvidence(inspection, 0);
    assert.equal(evidence.matchingReplacement, true);
    assert.equal(evidence.replacementSsrReady, false);
  });
}

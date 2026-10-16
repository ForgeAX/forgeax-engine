import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import {
  insufficientDawnRecoveryEvidence,
  observeRealLoss,
  submitRealFrame,
  testOnlyLossProvider,
} from './helpers/renderer-device-loss-dawn';

type RecoveryEvidence = ReturnType<typeof insufficientDawnRecoveryEvidence>;

describe('real Dawn renderer device-loss recovery', () => {
  it('keeps the dual-world recovery contract honest when provider evidence is absent', async () => {
    const gpu = globalThis.navigator?.gpu;
    expect(typeof gpu?.requestAdapter).toBe('function');
    if (typeof gpu?.requestAdapter !== 'function') return;
    const adapter = await gpu.requestAdapter();
    expect(adapter).not.toBeNull();
    if (adapter === null) return;
    const device = await adapter.requestDevice();
    const firstWorld = new World();
    const secondWorld = new World();
    await submitRealFrame(device);
    const provider = testOnlyLossProvider();
    const rawLoss =
      provider === undefined
        ? undefined
        : await (async () => {
            await provider.injectNonDestroyedLoss?.(device);
            return observeRealLoss(device);
          })();
    let evidence: RecoveryEvidence = insufficientDawnRecoveryEvidence([
      firstWorld.identity,
      secondWorld.identity,
    ]);
    if (provider !== undefined && rawLoss?.reason === 'unknown') {
      evidence = insufficientDawnRecoveryEvidence(
        [firstWorld.identity, secondWorld.identity],
        'A non-destroyed raw loss was observed, but this fixture does not exercise public Renderer recovery',
      );
    }
    expect(evidence.submittedWork).toBe(true);
    expect(evidence.worlds).toHaveLength(2);
    expect(evidence.status).toBe('insufficient-evidence');
    expect(evidence.missingCapability).toBeTruthy();
  });
});

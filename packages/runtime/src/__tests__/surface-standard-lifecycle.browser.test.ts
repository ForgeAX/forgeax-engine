import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { createSurfaceBrowserFixture } from './surface-standard-browser.fixture';
import { runSurfaceAppLifecycle } from './surface-standard-pipeline.runtime-fixture';

it('restores Standard Surface and VFX after device loss with and without queued continuations', {
  timeout: 300_000,
}, async () => {
  const { renderer, assets, vfxHost, hostLoss, evidenceBackend } =
    await createSurfaceBrowserFixture();
  const verifyAppLifecycle = async (queueVfxContinuationDuringLoss = false) => {
    const evidence = await runSurfaceAppLifecycle({
      renderer,
      assets,
      vfxHost,
      hostLossSignals: hostLoss.signals,
      queueVfxContinuationDuringLoss,
      diagnostics: {
        recorder: evidenceBackend.recorder,
        backend: evidenceBackend.metadata,
        prefix: `artifacts/surface-vfx/browser/${queueVfxContinuationDuringLoss ? 'queued-recovery' : 'empty-recovery'}`,
        async write(name, bytes) {
          let binary = '';
          for (let offset = 0; offset < bytes.length; offset += 8192)
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
          await commands.writeFile(name, btoa(binary), 'base64');
        },
      },
    });
    expect(evidence.impactIds).toEqual([701, 702]);
    expect(evidence.emittedSplashCount).toBe(2);
    expect(evidence.splashIntents.every((intent) => intent.reset && intent.spawnCount === 8)).toBe(
      true,
    );
    expect(evidence.duplicateImpactCount).toBe(1);
    expect(evidence.cameraCoverageTransitions).toBe(2);
    expect(evidence.completedFrames).toBe(evidence.submittedFrames);
    expect(evidence.splashRendererKinds).toEqual(['billboard']);
    expect(evidence.activeVfxPlayerCount).toBe(2);
    expect(evidence.expiredVfxPlayerCount).toBe(0);
    expect(evidence.paused).toEqual(evidence.active);
    expect(evidence.resumed.frameId).toBeGreaterThan(evidence.active.frameId);
    expect(evidence.preLoss.frameId).toBeGreaterThan(evidence.resumed.frameId);
    expect(evidence.recovered.frameId).toBeGreaterThan(evidence.preLoss.frameId);
    expect(evidence.recovered.label).toBe('recovered');
    expect(evidence.deviceRecovery.newGeneration).toBeGreaterThan(
      evidence.deviceRecovery.oldGeneration,
    );
    expect(evidence.deviceRecovery.staleObservationErrorCode).toBe('frame-receipt-stale');
    expect(evidence.deviceRecovery.lateObservationErrorCode).toBe(
      queueVfxContinuationDuringLoss ? 'frame-receipt-stale' : 'device-operation-failed',
    );
    if (queueVfxContinuationDuringLoss) {
      expect(evidence.deviceRecovery.observationResourcesBeforeLoss).toBe(0);
    } else {
      expect(evidence.deviceRecovery.observationResourcesBeforeLoss).toBeGreaterThan(0);
    }
    expect(evidence.deviceRecovery.observationResourcesAfterRecovery).toBe(0);
    expect(evidence.deviceRecovery.eventAgeBeforeLoss).toBeLessThan(0.34);
    expect(evidence.deviceRecovery.eventAgeAfterRecovery).toBe(
      evidence.deviceRecovery.eventAgeBeforeLoss,
    );
    if (queueVfxContinuationDuringLoss) {
      expect(evidence.deviceRecovery.queuedContinuationsBeforeLoss).toHaveLength(2);
      expect(evidence.deviceRecovery.vfxQueueSequencesBeforeLoss).toHaveLength(2);
      expect(evidence.deviceRecovery.vfxQueueSequencesAfterRecovery).toEqual([]);
      for (const queued of evidence.deviceRecovery.queuedContinuationsBeforeLoss) {
        const player = evidence.deviceRecovery.vfxPlayersAfterRecovery.find(
          (candidate) => candidate.player === queued.player,
        );
        expect(player?.lastCommitted).toMatchObject({
          sequence: queued.sequence,
          phaseTick: queued.phaseTick,
          playCycle: queued.playCycle,
          reset: false,
        });
      }
    } else {
      expect(
        evidence.deviceRecovery.vfxPlayersAfterRecovery.map((player) => ({
          player: player.player,
          lastCommitted: player.lastCommitted,
          sessions: player.sessions,
        })),
      ).toEqual(
        evidence.deviceRecovery.vfxPlayersBeforeLoss.map((player) => ({
          player: player.player,
          lastCommitted: player.lastCommitted,
          sessions: player.sessions,
        })),
      );
      expect(evidence.deviceRecovery.vfxQueueSequencesBeforeLoss).toEqual([]);
      expect(evidence.deviceRecovery.vfxQueueSequencesAfterRecovery).toEqual([]);
    }
    expect(evidence.deviceRecovery.vfxHostGenerationAfterRecovery).toBe(
      evidence.deviceRecovery.vfxHostGenerationBeforeLoss,
    );
    expect(evidence.deviceRecovery.vfxRenderGenerationAfterRecovery).toBeGreaterThanOrEqual(
      evidence.deviceRecovery.vfxRenderGenerationBeforeLoss,
    );
    expect(evidence.coverageClipped.frameId).toBeGreaterThan(evidence.resumed.frameId);
    expect(evidence.expired.frameId).toBeGreaterThan(evidence.coverageClipped.frameId);
    expect(evidence.comparisons.activeSplash.failedPixelCount).toBeGreaterThan(0);
    expect(evidence.comparisons.preLossSplash.failedPixelCount).toBeGreaterThan(0);
    expect(evidence.comparisons.recoveredSplash.failedPixelCount).toBeGreaterThan(0);
    if (!queueVfxContinuationDuringLoss) {
      expect(evidence.comparisons.recoverySplashParity.failedPixelCount).toBe(0);
      expect(evidence.comparisons.recoverySplashParity.maxError).toBeLessThanOrEqual(0.05);
    }
    expect(evidence.comparisons.expiredSplash.failedPixelCount).toBe(0);
    expect(evidence.comparisons.activeWaterB.failedPixelCount).toBe(0);
    expect(evidence.comparisons.resumedWaterB.failedPixelCount).toBe(0);
    expect(evidence.resumedEventAge).toBeGreaterThanOrEqual(0);
    expect(evidence.expiredEventAge).toBeGreaterThan(evidence.resumedEventAge);
    // biome-ignore lint/suspicious/noConsole: App/World/Surface/VFX lifecycle evidence is the test artifact.
    console.log(
      JSON.stringify({
        kind: 'surface-water-app-lifecycle',
        backend: 'browser-webgpu',
        queueVfxContinuationDuringLoss,
        ...evidence,
      }),
    );
    return evidence;
  };
  await verifyAppLifecycle();
  await verifyAppLifecycle(true);
});

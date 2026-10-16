import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { constructRendererHost } from '../../../render/src/construct-renderer';

type RecoveryAction = 'retry' | 'repair-owner' | 'rebuild-renderer';

function chooseRecoveryAction(error: {
  readonly code: string;
  readonly detail: {
    readonly guidance: RecoveryAction;
    readonly retryable: boolean;
  };
}): RecoveryAction {
  if (error.code !== 'recovery-failed') return 'rebuild-renderer';
  return error.detail.retryable ? error.detail.guidance : 'rebuild-renderer';
}

describe('runtime renderer recovery consumer', () => {
  it('chooses an action from structured detail without reading message', () => {
    const failure = {
      code: 'recovery-failed',
      message: 'renderer recovery failed',
      detail: {
        operation: 'recover' as const,
        phase: 'producer' as const,
        oldGeneration: 7,
        candidateGeneration: 8,
        lastOutcome: 'mesh-source-invalid',
        rehydratedRoots: ['render-scene'],
        staleLossEvents: 0,
        guidance: 'repair-owner' as const,
        retryable: true,
      },
    };

    expect(chooseRecoveryAction(failure)).toBe('repair-owner');
    expect(failure.message).not.toContain('mesh-residency');
    expect(failure.detail.candidateGeneration).toBe(8);
    expect(failure.detail.rehydratedRoots).toEqual(['render-scene']);
  });

  it('rebuilds when structured detail marks the failure non-retryable', () => {
    const failure = {
      code: 'recovery-failed',
      detail: {
        operation: 'recover' as const,
        phase: 'publish' as const,
        oldGeneration: 9,
        candidateGeneration: 10,
        lastOutcome: 'publication-invalid',
        rehydratedRoots: [],
        staleLossEvents: 0,
        guidance: 'rebuild-renderer' as const,
        retryable: false,
      },
    };

    expect(chooseRecoveryAction(failure)).toBe('rebuild-renderer');
  });

  it('reads production recovery evidence through the public Renderer inspect entry', async () => {
    const manifest = `data:application/json,${encodeURIComponent(JSON.stringify({ entries: [] }))}`;
    const host = await constructRendererHost(
      { width: 1, height: 1, getContext: () => null } as unknown as HTMLCanvasElement,
      { rhi },
      { shaderManifestUrl: manifest },
    );
    expect(host.ok).toBe(true);
    if (!host.ok) return;

    const before = host.value.renderer.inspect();
    expect(before.recoveryEvidence.producerRoots.length).toBeGreaterThan(0);
    expect(before.recoveryEvidence.submissions.count).toBe(0);
    expect(before.recoveryEvidence.receipts.count).toBe(0);

    const world = new World();
    const attached = host.value.renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(world.update().ok).toBe(true);
    const frame = host.value.renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    expect(frame.ok).toBe(true);
    if (frame.ok && frame.value !== undefined) {
      const after = host.value.renderer.inspect();
      expect(after.recoveryEvidence.submissions.count).toBe(1);
      expect(after.recoveryEvidence.receipts.count).toBe(1);
      expect(after.recoveryEvidence.receipts.lastGeneration).toBe(frame.value.deviceGeneration);
    }
    await host.value.renderer.dispose();
  });
});

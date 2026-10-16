import { describe, expect, it } from 'vitest';
import { RecoverError } from '../../../render/src/errors/recover';
import {
  RenderFeatureCapabilityMissingError,
  RenderFeatureStageFailedError,
} from '../../../render/src/errors/render';
import type {
  RenderFeatureErrorDescriptor,
  RenderFeatureStatus,
} from '../../../render/src/features/types';
import type { HealthSnapshot } from '../../../render/src/lifecycle';

interface RecoveryRow {
  readonly status: RenderFeatureStatus;
  readonly code: string;
  readonly detail: string;
  readonly action: string;
  readonly error: RenderFeatureErrorDescriptor | undefined;
}

function featureDetail(error: RenderFeatureErrorDescriptor): string {
  switch (error.code) {
    case 'render-feature-registration-conflict':
      return `${error.detail.featureIdentity}:${error.detail.conflictingOrder}`;
    case 'render-feature-stage-failed':
      return `${error.detail.stage}:${error.detail.recovery}`;
    case 'render-feature-capability-missing':
      return error.detail.capability;
    case 'render-feature-pass-order-conflict':
      return `${error.detail.passIdentity}:${error.detail.dependencyIdentity}`;
    case 'render-feature-preparation-failed':
      return `${error.detail.resourceKind}:${error.detail.reason}`;
    case 'render-feature-prepared-state-mismatch':
      return `${error.detail.resourceKind}:${error.detail.reason}`;
    case 'render-feature-draw-recording-failed':
      return `${error.detail.resourceKind}:${error.detail.backendReason}`;
  }
}

function healthDetail(snapshot: HealthSnapshot): string {
  switch (snapshot.reason) {
    case 'alive':
      return 'renderer is ready';
    case 'device-lost':
      return `${snapshot.detail.lostReason}:${snapshot.detail.message.length}`;
    case 'internal-fault':
      return `internal-fault:${snapshot.detail.message.length}`;
  }
}

function recoveryMatrix(): readonly RecoveryRow[] {
  const failed = new RenderFeatureStageFailedError(
    'docs.prepared-graphics',
    0,
    'prepare',
    'next-frame',
  );
  const disabled = new RenderFeatureCapabilityMissingError('docs.prepared-graphics', 0, 'compute');
  const disposed = new RenderFeatureStageFailedError(
    'docs.prepared-graphics',
    0,
    'dispose',
    'registration',
  );
  return [
    {
      status: 'active',
      code: 'none',
      detail: 'no error',
      action: 'continue renderer.draw(worlds, { cameraOwner: 0, resourceOwner: 0 })',
      error: undefined,
    },
    {
      status: 'failed',
      code: failed.code,
      detail: featureDetail(failed),
      action: 'fix feature data and retry on the next frame',
      error: failed,
    },
    {
      status: 'disabled',
      code: disabled.code,
      detail: featureDetail(disabled),
      action: 'disable the feature or use a device with the capability',
      error: disabled,
    },
    {
      status: 'disposed',
      code: disposed.code,
      detail: featureDetail(disposed),
      action: 'create a new renderer and feature registration',
      error: disposed,
    },
  ];
}

describe('runtime prepared graphics recovery documentation', () => {
  it('keeps every feature lifecycle state tied to a structured action', () => {
    const rows = recoveryMatrix();
    expect(rows.map((row) => row.status)).toEqual(['active', 'failed', 'disabled', 'disposed']);
    for (const row of rows) {
      expect(row.code).not.toBe('message');
      expect(row.detail).not.toBe('');
      expect(row.action).not.toBe('');
      if (row.error !== undefined) {
        expect(row.code).toBe(row.error.code);
        expect(row.error.expected).not.toBe('');
        expect(row.error.hint).not.toBe('');
      }
    }
  });

  it('keeps device-loss recovery aligned with generated health and recover declarations', () => {
    const health: HealthSnapshot = {
      reason: 'device-lost',
      detail: { lostReason: 'unknown', message: 'device reset' },
      recoverable: true,
    };
    const recoveryError = new RecoverError('recover-adapter-unavailable');
    expect(healthDetail(health)).toBe('unknown:12');
    expect(health.recoverable).toBe(true);
    expect(recoveryError.code).toBe('recover-adapter-unavailable');
    expect(recoveryError.expected).toContain('requestAdapter');
    expect(recoveryError.hint).toContain('retry recover()');
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { assertProfileTransfer, profileTransferSummary } from '../profile-capture-transfer.mjs';

const captureId = 'r8-profile-transfer-test';

const createProfile = () => ({
  version: 1,
  capture: {
    captureId,
    schemaVersion: '1.0',
    records: [{ kind: 'phase' }, { kind: 'event' }],
    completeness: { retainedEventCount: 2 },
  },
  model: { phases: [{ phase: 'render' }] },
  sidecars: {
    receipts: [
      {
        captureId,
        profileFrameId: 3,
        receiptFrameId: 19,
        deviceGeneration: 2,
        renderPassCpuIdentitiesComplete: true,
        renderPassCpuIdentities: [
          {
            phase: 'record',
            owner: 'render',
            viewId: 7,
            deviceGeneration: 2,
            graphGeneration: 4,
            graphExecutionIndex: 0,
            passName: 'opaque',
            passKind: 'raster',
            gpuIdentityStatus: 'available',
            gpuIdentity: { viewId: 7, passName: 'opaque', passKind: 'raster', executionIndex: 0 },
          },
        ],
      },
    ],
    completionCpu: [{ captureId, profileFrameId: 3, receiptFrameId: 19, deviceGeneration: 2 }],
    nativePhysics: [{ captureId, profileFrameId: 3, nativeStepIndex: 11, fixedStep: 11 }],
    gpu: [
      {
        captureId,
        profileFrameId: 3,
        receiptFrameId: 19,
        deviceGeneration: 2,
        timingStatus: 'complete',
        timings: {
          frame: {
            passes: [
              {
                viewId: 7,
                passName: 'opaque',
                passKind: 'raster',
                executionIndex: 0,
                status: 'measured',
              },
            ],
          },
        },
      },
    ],
    diagnostics: {
      profileSourceFailure: {
        code: 'profile-source-failed',
        expected: 'a phase declared by the source catalog',
        hint: 'Use the source-owned phase catalog and retry the frame.',
        detail: { source: 'render', phase: 'record/missing-owner', frameId: 1 },
      },
    },
    completeness: { status: 'partial' },
  },
});

test('accepts the downloaded profile only when counts and complete sidecar identities match preflight', () => {
  const profile = createProfile();
  const preflight = profileTransferSummary(profile);

  assert.equal(
    assertProfileTransfer(profile, preflight, captureId).sidecarsSha256,
    preflight.sidecarsSha256,
  );
  assert.equal(preflight.renderPassCpuIdentityCount, 1);
  assert.equal(preflight.gpuPassIdentityCount, 1);
});

test('rejects a downloaded profile whose receipt identity differs from preflight', () => {
  const preflight = profileTransferSummary(createProfile());
  const downloaded = createProfile();
  downloaded.sidecars.receipts[0].receiptFrameId += 1;

  assert.throws(
    () => assertProfileTransfer(downloaded, preflight, captureId),
    /counts or identities differ from preflight/,
  );
});

test('rejects a sidecar row attached to a different capture even if preflight includes it', () => {
  const downloaded = createProfile();
  downloaded.sidecars.gpu[0].captureId = 'other-capture';
  const preflight = profileTransferSummary(downloaded);

  assert.throws(
    () => assertProfileTransfer(downloaded, preflight, captureId),
    /unexpected capture ID/,
  );
});

test('rejects changed event or phase counts', () => {
  const preflight = profileTransferSummary(createProfile());
  const downloaded = createProfile();
  downloaded.model.phases.push({ phase: 'unexpected' });

  assert.throws(
    () => assertProfileTransfer(downloaded, preflight, captureId),
    /counts or identities differ from preflight/,
  );
});

test('rejects a changed retained source-failure diagnosis', () => {
  const preflight = profileTransferSummary(createProfile());
  const downloaded = createProfile();
  downloaded.sidecars.diagnostics.profileSourceFailure.detail.phase = 'mutated';

  assert.throws(
    () => assertProfileTransfer(downloaded, preflight, captureId),
    /counts or identities differ from preflight/,
  );
});

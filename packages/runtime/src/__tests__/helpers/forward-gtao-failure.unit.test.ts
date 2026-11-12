import { expect, it, vi } from 'vitest';
import {
  consumeVerifiedForwardGtaoCandidateFault,
  describeForwardGtaoFailure,
  forwardGtaoFailureReport,
  requireNoForwardGtaoRendererErrors,
  throwForForwardGtaoRendererErrors,
  verifyForwardGtaoCandidateFault,
  writeForwardGtaoFailureReport,
} from './forward-gtao-failure';

function candidateFault(input: { readonly causeCode?: string; readonly phase?: string } = {}) {
  const cause = Object.assign(new Error('injected candidate preparation fault'), {
    code: input.causeCode ?? 'gtao-candidate-preparation-fault-injected',
    detail: {
      phase: input.phase ?? 'post-allocation-before-promotion',
      candidateGeneration: 41,
      deviceGeneration: 9,
      passNames: ['gtao-calc-compute', 'ssao-blur'],
    },
  });
  return Object.assign(new Error('candidate graph preparation failed'), {
    code: 'graph-build-failed',
    expected: 'the candidate graph is prepared before promotion',
    hint: 'inspect the candidate cause and retry after recovery',
    detail: { operation: 'prepareFeatureGraphCandidate', cause },
    cause,
  });
}

function candidateFaultSnapshot(event: unknown) {
  return Object.freeze({
    event,
    error: describeForwardGtaoFailure(event),
    inspection: { frame: { deviceGeneration: 9 } },
  });
}

it('serializes plain errors and explicitly marks absent frame evidence', () => {
  const report = forwardGtaoFailureReport(new Error('draw failed'), {
    backend: 'webgpu',
    operation: 'renderer.draw',
  });

  expect(report).toMatchObject({
    backend: 'webgpu',
    failingOperation: 'renderer.draw',
    receipt: { status: 'not-obtained' },
    frameTrace: null,
    readback: { status: 'not-obtained' },
    diagnostics: { status: 'not-obtained' },
    failure: { name: 'Error', message: 'draw failed' },
    rendererErrors: [],
  });
});

it('preserves structured fields through both JavaScript and detail causes', () => {
  const rootCause = Object.assign(new Error('unsupported surface input'), {
    code: 'scene-data-unavailable',
    expected: 'a supported current-view surface producer',
    hint: 'remove the unsupported Morph contribution before retrying',
    detail: {
      schema: 'forgeax::scene-data::standard-surface-normal-v1',
      reason: 'coverage-incomplete',
      missingContributorIds: ['[0,4,2,0]'],
      cause: Object.assign(new Error('Morph contributor is unsupported'), {
        code: 'surface-contributor-unsupported',
        detail: { source: 0, entityKey: 4, materialHandle: 2, passIndex: 0 },
      }),
    },
  });
  const failure = Object.assign(new Error('Renderer candidate failed'), {
    code: 'device-operation-failed',
    detail: { operation: 'ensureCompiledFrameGraph', cause: rootCause },
    cause: rootCause,
  });

  expect(describeForwardGtaoFailure(failure)).toMatchObject({
    name: 'Error',
    message: 'Renderer candidate failed',
    code: 'device-operation-failed',
    detail: {
      operation: 'ensureCompiledFrameGraph',
      cause: {
        code: 'scene-data-unavailable',
        expected: 'a supported current-view surface producer',
        hint: 'remove the unsupported Morph contribution before retrying',
        detail: {
          schema: 'forgeax::scene-data::standard-surface-normal-v1',
          reason: 'coverage-incomplete',
          missingContributorIds: ['[0,4,2,0]'],
          cause: {
            code: 'surface-contributor-unsupported',
            detail: { source: 0, entityKey: 4, materialHandle: 2, passIndex: 0 },
          },
        },
      },
    },
    cause: {
      code: 'scene-data-unavailable',
      detail: { reason: 'coverage-incomplete' },
    },
  });
});

it('writes completion failure evidence before renderer disposal with available trace', async () => {
  const completionFailure = Object.assign(new Error('receipt completion rejected'), {
    code: 'frame-completion-failed',
    detail: { frameId: 17 },
  });
  const completed = Promise.reject(completionFailure);
  const receipt = { frameId: 17, presentation: 'ready' as const };
  let reportText = '';
  const report = await completed.catch((failure: unknown) =>
    writeForwardGtaoFailureReport({
      path: 'reports/forward-gtao-failure.json',
      failure,
      writeFile: async (_path, contents) => {
        reportText = contents;
      },
      context: {
        backend: 'wgpu-webgl2',
        manifestSummary: { identity: 'profile-sha256:abc', admittedEntries: 6 },
        cameraConfig: { algorithm: 'gtao', width: 129, height: 97 },
        operation: 'receipt.completed',
        receipt,
        frameTrace: { recordFrameNumber: 16, completion: 'rejected' },
        rendererErrors: [completionFailure],
      },
    }),
  );

  expect(reportText).not.toBe('');
  expect(JSON.parse(reportText)).toMatchObject({
    backend: 'wgpu-webgl2',
    manifestSummary: { identity: 'profile-sha256:abc' },
    cameraConfig: { algorithm: 'gtao', width: 129, height: 97 },
    failingOperation: 'receipt.completed',
    receipt: { frameId: 17, presentation: 'ready' },
    frameTrace: { recordFrameNumber: 16, completion: 'rejected' },
    readback: { status: 'not-obtained' },
    failure: { code: 'frame-completion-failed', detail: { frameId: 17 } },
    rendererErrors: [{ code: 'frame-completion-failed' }],
    diagnostics: { status: 'not-obtained' },
  });
  expect(report).toMatchObject({ failingOperation: 'receipt.completed' });
});

it('does not let evidence-write failure replace the original renderer error', async () => {
  const failure = new Error('original renderer failure');
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const report = await writeForwardGtaoFailureReport({
      path: 'reports/forward-gtao-failure.json',
      failure,
      writeFile: async () => {
        throw new Error('report storage unavailable');
      },
      context: { backend: 'webgpu', operation: 'renderer.draw' },
    });
    expect(report.failure).toMatchObject({ message: 'original renderer failure' });
    expect(consoleError).toHaveBeenCalledTimes(1);
  } finally {
    consoleError.mockRestore();
  }
});

it('omits non-plain native resources instead of serializing the renderer world', () => {
  class NativeBuffer {
    readonly secretPayload = new Uint8Array([1, 2, 3]);
  }
  const report = forwardGtaoFailureReport(
    Object.assign(new Error('copy failed'), {
      detail: { buffer: new NativeBuffer() },
    }),
    { backend: 'webgpu', operation: 'target-copy' },
  );

  expect(report.failure).toMatchObject({
    detail: { buffer: { omittedNonPlainObject: 'NativeBuffer' } },
  });
  expect(JSON.stringify(report)).not.toContain('secretPayload');
});

it('fails closed on unconfirmed renderer events without clearing them', () => {
  const priorFailure = Object.assign(new Error('unconfirmed earlier frame failure'), {
    code: 'graph-build-failed',
  });
  const errors = [priorFailure];

  expect(() => requireNoForwardGtaoRendererErrors(errors, 'candidate fault injection')).toThrow(
    /unconfirmed renderer errors before candidate fault injection/,
  );
  expect(errors).toEqual([priorFailure]);
});

it('consumes only one fully verified candidate fault while retaining its snapshot evidence', () => {
  const event = candidateFault();
  const snapshot = candidateFaultSnapshot(event);
  const errors = [event];
  const verified = verifyForwardGtaoCandidateFault({ errors, snapshots: [snapshot] });

  expect(verified).toMatchObject({ event, snapshot, candidateGeneration: 41 });
  expect(verified.evidence).toEqual(snapshot.error);
  expect(verified.evidence).toMatchObject({
    code: 'graph-build-failed',
    expected: 'the candidate graph is prepared before promotion',
    hint: 'inspect the candidate cause and retry after recovery',
    detail: {
      cause: {
        code: 'gtao-candidate-preparation-fault-injected',
        detail: {
          phase: 'post-allocation-before-promotion',
          candidateGeneration: 41,
          deviceGeneration: 9,
          passNames: ['gtao-calc-compute', 'ssao-blur'],
        },
      },
    },
  });

  consumeVerifiedForwardGtaoCandidateFault(errors, verified);

  expect(errors).toEqual([]);
  expect(snapshot.event).toBe(event);
  expect(snapshot.error).toEqual(verified.evidence);
  expect(snapshot.inspection.frame.deviceGeneration).toBe(9);
});

it('refuses duplicate candidate-fault events without consuming either event', () => {
  const event = candidateFault();
  const snapshot = candidateFaultSnapshot(event);
  const errors = [event, event];
  const verified = verifyForwardGtaoCandidateFault({
    errors: [event],
    snapshots: [snapshot],
  });

  expect(() => verifyForwardGtaoCandidateFault({ errors, snapshots: [snapshot] })).toThrow(
    /expected exactly one candidate-failure renderer event/,
  );
  expect(() => consumeVerifiedForwardGtaoCandidateFault(errors, verified)).toThrow(
    /exactly the verified candidate failure/,
  );
  expect(errors).toEqual([event, event]);
});

it('refuses a different candidate cause without consuming or replacing it with verified evidence', () => {
  const verifiedEvent = candidateFault();
  const verified = verifyForwardGtaoCandidateFault({
    errors: [verifiedEvent],
    snapshots: [candidateFaultSnapshot(verifiedEvent)],
  });
  const wrongCause = candidateFault({ causeCode: 'shader-validation-failed' });
  const wrongCauseErrors = [wrongCause];

  expect(() =>
    verifyForwardGtaoCandidateFault({
      errors: wrongCauseErrors,
      snapshots: [candidateFaultSnapshot(wrongCause)],
    }),
  ).toThrow(/unexpected cause or phase/);
  expect(() => consumeVerifiedForwardGtaoCandidateFault(wrongCauseErrors, verified)).toThrow(
    /exactly the verified candidate failure/,
  );
  expect(wrongCauseErrors).toEqual([wrongCause]);
});

it('reports a new frame renderer error with that completed receipt and its own trace', () => {
  const recoveryFrameError = Object.assign(new Error('recovery graph failed'), {
    code: 'graph-build-failed',
  });
  const errors = [recoveryFrameError];
  const receipt = {
    frameId: 39,
    deviceGeneration: 9,
    graphGeneration: 17,
    presentation: 'ready',
  };
  const frameTrace = {
    recordFrameNumber: 38,
    observationFrameId: 39,
    graphGeneration: 17,
    receipt: {
      publicReceiptFrameId: 39,
      deviceGeneration: 9,
      presentation: 'ready',
      completion: 'completed',
    },
  };
  let reported: unknown;
  try {
    throwForForwardGtaoRendererErrors({
      errors,
      output: { graphPassNames: ['gtao-calc-compute', 'ssao-blur', 'main'] },
      receipt,
      frameTrace,
    });
  } catch (error) {
    reported = error;
  }

  expect(reported).toBeInstanceOf(Error);
  const reportError = reported as Error & { readonly cause?: unknown };
  expect(reportError.cause).toBe(recoveryFrameError);
  expect(reportError.message.startsWith('Renderer event failure: ')).toBe(true);
  expect(JSON.parse(reportError.message.slice('Renderer event failure: '.length))).toMatchObject({
    receipt,
    frameTrace,
    errors: [{ code: 'graph-build-failed' }],
  });
  expect(errors).toEqual([recoveryFrameError]);
});

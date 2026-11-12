import { expect, it } from 'vitest';
import {
  beginClusterWorkConformanceFrame,
  type ClusterWorkConformanceState,
  type ClusterWorkSample,
  captureClusterWorkSample,
  readClusterWorkFrameTrace,
  readClusterWorkObservation,
  recordClusterWorkFrameReceiptForConformance,
  recordClusterWorkGraphTargetCopyForConformance,
  setClusterWorkConformanceEnabled,
  settleClusterWorkConformanceFrame,
} from '../cluster-work-conformance';

const sample: ClusterWorkSample = {
  frameNumber: 8,
  viewEntityKey: 14,
  deviceGeneration: 3,
  graphGeneration: 22,
  clusterTransportGeneration: 11,
  transport: 'cpu-texture',
  scope: 'cluster-texture-host-regions',
  packedLightSlots: 2,
  acceptedWriteBytes: 512,
  writeSucceeded: true,
};

function capture(enabled = true): ClusterWorkConformanceState {
  const state: ClusterWorkConformanceState = { enabled: false };
  setClusterWorkConformanceEnabled(state, enabled);
  return state;
}

it('has no history until the explicit conformance opt-in', () => {
  const state = capture(false);
  captureClusterWorkSample(state, sample);
  expect(readClusterWorkObservation(state, sample.deviceGeneration)).toBeUndefined();

  setClusterWorkConformanceEnabled(state, true);
  expect(readClusterWorkObservation(state, sample.deviceGeneration)).toEqual({
    status: 'unavailable',
    reason: 'awaiting-write',
  });
});

it('aggregates repeated writes only within the same frame, view, device, graph, transport and scope', () => {
  const state = capture();
  captureClusterWorkSample(state, sample);
  captureClusterWorkSample(state, sample);
  const observation = readClusterWorkObservation(state, sample.deviceGeneration);
  expect(observation).toEqual({
    status: 'captured',
    ...sample,
    invocations: 2,
    packedLightSlots: 4,
    acceptedWriteBytes: 1024,
  });
  expect(Object.isFrozen(observation)).toBe(true);

  captureClusterWorkSample(state, {
    ...sample,
    scope: 'light-data-buffer',
    transport: 'storage-buffer',
  });
  expect(readClusterWorkObservation(state, sample.deviceGeneration)).toMatchObject({
    status: 'captured',
    frameNumber: sample.frameNumber,
    scope: 'light-data-buffer',
    transport: 'storage-buffer',
    invocations: 1,
  });

  captureClusterWorkSample(state, { ...sample, frameNumber: sample.frameNumber + 1 });
  expect(readClusterWorkObservation(state, sample.deviceGeneration)).toMatchObject({
    status: 'captured',
    frameNumber: sample.frameNumber + 1,
    invocations: 1,
    packedLightSlots: sample.packedLightSlots,
  });
  captureClusterWorkSample(state, { ...sample, viewEntityKey: sample.viewEntityKey + 1 });
  expect(readClusterWorkObservation(state, sample.deviceGeneration)).toMatchObject({
    status: 'captured',
    viewEntityKey: sample.viewEntityKey + 1,
    invocations: 1,
  });
  captureClusterWorkSample(state, { ...sample, graphGeneration: sample.graphGeneration + 1 });
  expect(readClusterWorkObservation(state, sample.deviceGeneration)).toMatchObject({
    status: 'captured',
    graphGeneration: sample.graphGeneration + 1,
    clusterTransportGeneration: sample.clusterTransportGeneration,
    invocations: 1,
  });
  captureClusterWorkSample(state, { ...sample, deviceGeneration: sample.deviceGeneration + 1 });
  expect(readClusterWorkObservation(state, sample.deviceGeneration + 1)).toMatchObject({
    status: 'captured',
    deviceGeneration: sample.deviceGeneration + 1,
    invocations: 1,
  });
});

it('keeps write outcome separate from bytes accepted before a failure', () => {
  const state = capture();
  captureClusterWorkSample(state, sample);
  captureClusterWorkSample(state, {
    ...sample,
    packedLightSlots: 0,
    acceptedWriteBytes: 128,
    writeSucceeded: false,
    errorCode: 'device-lost',
  });
  expect(readClusterWorkObservation(state, sample.deviceGeneration)).toMatchObject({
    status: 'captured',
    invocations: 2,
    packedLightSlots: 2,
    acceptedWriteBytes: 640,
    writeSucceeded: false,
    errorCode: 'device-lost',
  });
  const failedOnly = capture();
  captureClusterWorkSample(failedOnly, {
    ...sample,
    acceptedWriteBytes: 16,
    writeSucceeded: false,
    errorCode: 'device-lost',
  });
  expect(readClusterWorkObservation(failedOnly, sample.deviceGeneration)).toMatchObject({
    status: 'captured',
    acceptedWriteBytes: 16,
    writeSucceeded: false,
    errorCode: 'device-lost',
  });
});

it('marks old device generations unavailable and clears stale samples on reset', () => {
  const state = capture();
  captureClusterWorkSample(state, sample);
  expect(readClusterWorkObservation(state, sample.deviceGeneration + 1)).toEqual({
    status: 'unavailable',
    reason: 'device-generation-changed',
  });
  setClusterWorkConformanceEnabled(state, true);
  expect(readClusterWorkObservation(state, sample.deviceGeneration)).toEqual({
    status: 'unavailable',
    reason: 'awaiting-write',
  });
  beginClusterWorkConformanceFrame(state);
  expect(readClusterWorkObservation(state, sample.deviceGeneration)).toEqual({
    status: 'unavailable',
    reason: 'awaiting-write',
  });
  captureClusterWorkSample(state, sample);
  setClusterWorkConformanceEnabled(state, false);
  expect(readClusterWorkObservation(state, sample.deviceGeneration)).toBeUndefined();
  setClusterWorkConformanceEnabled(state, true);
  expect(readClusterWorkObservation(state, sample.deviceGeneration)).toEqual({
    status: 'unavailable',
    reason: 'awaiting-write',
  });
});

it('keeps local record frame zero separate from public receipt one through completion', async () => {
  const state = capture();
  let complete: (result: unknown) => void = () => {};
  const completed = new Promise<unknown>((resolve) => {
    complete = resolve;
  });
  beginClusterWorkConformanceFrame(state, 0, 1);
  captureClusterWorkSample(state, { ...sample, frameNumber: 0 });
  recordClusterWorkGraphTargetCopyForConformance(state, {
    recordFrameNumber: 0,
    targetName: 'ssao-raw',
    expectedIdentity: { graphGeneration: 8, recordFrameNumber: 0, textureIdentity: 101 },
    actualIdentity: { graphGeneration: 8, recordFrameNumber: 0, textureIdentity: 101 },
    encoded: true,
  });
  settleClusterWorkConformanceFrame(state, 0, 'submitted');
  expect(
    recordClusterWorkFrameReceiptForConformance(state, {
      observationFrameId: 1,
      publicReceiptFrameId: 1,
      deviceGeneration: 3,
      presentation: 'ready',
      completed,
    }),
  ).toBe(true);
  expect(readClusterWorkFrameTrace(state)).toMatchObject({
    recordFrameNumber: 0,
    observationFrameId: 1,
    recordStatus: 'submitted',
    clusterWork: { status: 'captured', frameNumber: 0 },
    graphTargetCopy: { encoded: true, recordFrameNumber: 0 },
    receipt: { publicReceiptFrameId: 1, presentation: 'ready', completion: 'pending' },
  });
  complete({ ok: true, value: undefined });
  await completed;
  expect(readClusterWorkFrameTrace(state)?.receipt?.completion).toBe('completed');
  expect(Object.isFrozen(readClusterWorkFrameTrace(state))).toBe(true);
});

it('keeps same-generation ready work at zero when only graph generation changes', async () => {
  const state = capture();
  beginClusterWorkConformanceFrame(state, 8, 20);
  captureClusterWorkSample(state, sample);
  settleClusterWorkConformanceFrame(state, 8, 'submitted');
  expect(
    recordClusterWorkFrameReceiptForConformance(state, {
      observationFrameId: 20,
      publicReceiptFrameId: 40,
      deviceGeneration: sample.deviceGeneration,
      presentation: 'ready',
      completed: Promise.resolve({ ok: true, value: undefined }),
    }),
  ).toBe(true);
  await Promise.resolve();
  expect(readClusterWorkFrameTrace(state)).toMatchObject({
    recordFrameNumber: 8,
    clusterTransportGeneration: sample.clusterTransportGeneration,
    clusterWork: { packedLightSlots: 2, acceptedWriteBytes: 512 },
    receipt: { publicReceiptFrameId: 40, presentation: 'ready', completion: 'completed' },
  });

  beginClusterWorkConformanceFrame(state, 9, 21);
  captureClusterWorkSample(state, {
    ...sample,
    frameNumber: 9,
    graphGeneration: sample.graphGeneration + 1,
    packedLightSlots: 0,
    acceptedWriteBytes: 0,
  });
  settleClusterWorkConformanceFrame(state, 9, 'submitted');
  expect(
    recordClusterWorkFrameReceiptForConformance(state, {
      observationFrameId: 21,
      publicReceiptFrameId: 41,
      deviceGeneration: sample.deviceGeneration,
      presentation: 'ready',
      completed: Promise.resolve({ ok: true, value: undefined }),
    }),
  ).toBe(true);
  await Promise.resolve();
  expect(readClusterWorkFrameTrace(state)).toMatchObject({
    recordFrameNumber: 9,
    graphGeneration: sample.graphGeneration + 1,
    clusterTransportGeneration: sample.clusterTransportGeneration,
    clusterWork: {
      frameNumber: 9,
      graphGeneration: sample.graphGeneration + 1,
      clusterTransportGeneration: sample.clusterTransportGeneration,
      packedLightSlots: 0,
      acceptedWriteBytes: 0,
    },
    receipt: { publicReceiptFrameId: 41, presentation: 'ready', completion: 'completed' },
  });
});

it('does not attach a later public receipt to an unsubmitted record', () => {
  const state = capture();
  beginClusterWorkConformanceFrame(state, 5, 1);
  captureClusterWorkSample(state, { ...sample, frameNumber: 5 });
  settleClusterWorkConformanceFrame(state, 5, 'unsubmitted');
  expect(
    recordClusterWorkFrameReceiptForConformance(state, {
      observationFrameId: 1,
      publicReceiptFrameId: 1,
      deviceGeneration: 3,
      presentation: 'ready',
      completed: Promise.resolve({ ok: true, value: undefined }),
    }),
  ).toBe(false);
  expect(readClusterWorkFrameTrace(state)).toMatchObject({
    recordFrameNumber: 5,
    recordStatus: 'unsubmitted',
  });
  expect(readClusterWorkFrameTrace(state)?.receipt).toBeUndefined();
});

it('binds a barrier receipt without marking the scene graph submitted', async () => {
  const state = capture();
  beginClusterWorkConformanceFrame(state, 0, 1);
  captureClusterWorkSample(state, { ...sample, frameNumber: 0 });
  settleClusterWorkConformanceFrame(state, 0, 'pending');
  let complete!: (value: { readonly ok: true; readonly value: undefined }) => void;
  const completed = new Promise<{ readonly ok: true; readonly value: undefined }>((resolve) => {
    complete = resolve;
  });
  expect(
    recordClusterWorkFrameReceiptForConformance(state, {
      observationFrameId: 1,
      publicReceiptFrameId: 1,
      deviceGeneration: 3,
      presentation: 'pending',
      completed,
    }),
  ).toBe(true);
  expect(readClusterWorkFrameTrace(state)).toMatchObject({
    recordFrameNumber: 0,
    observationFrameId: 1,
    recordStatus: 'pending',
    clusterWork: { status: 'captured', frameNumber: 0 },
    receipt: { publicReceiptFrameId: 1, presentation: 'pending', completion: 'pending' },
  });
  complete({ ok: true, value: undefined });
  await completed;
  await Promise.resolve();
  expect(readClusterWorkFrameTrace(state)?.receipt?.completion).toBe('completed');
});

it('records graph and texture replacement as a rejected copy identity', () => {
  const state = capture();
  beginClusterWorkConformanceFrame(state, 13, 15);
  recordClusterWorkGraphTargetCopyForConformance(state, {
    recordFrameNumber: 14,
    targetName: 'ssao-raw',
    expectedIdentity: { graphGeneration: 8, recordFrameNumber: 14, textureIdentity: 101 },
    actualIdentity: { graphGeneration: 9, recordFrameNumber: 14, textureIdentity: 202 },
    encoded: false,
    reason: 'identity-mismatch',
  });
  expect(readClusterWorkFrameTrace(state)?.graphTargetCopy).toMatchObject({
    recordFrameNumber: 13,
    encoded: false,
    reason: 'wrong-record-attempt',
  });
});

it('resets the trace for each one-shot capture retry', async () => {
  const state = capture();
  beginClusterWorkConformanceFrame(state, 13, 15);
  recordClusterWorkGraphTargetCopyForConformance(state, {
    recordFrameNumber: 13,
    targetName: 'ssao-raw',
    expectedIdentity: { graphGeneration: 8, recordFrameNumber: 13, textureIdentity: 101 },
    actualIdentity: { graphGeneration: 8, recordFrameNumber: 13, textureIdentity: 101 },
    encoded: true,
  });
  settleClusterWorkConformanceFrame(state, 13, 'submitted');
  const firstCompletion = Promise.resolve({ ok: true, value: undefined });
  recordClusterWorkFrameReceiptForConformance(state, {
    observationFrameId: 15,
    publicReceiptFrameId: 15,
    deviceGeneration: 3,
    presentation: 'pending',
    completed: firstCompletion,
  });
  const first = readClusterWorkFrameTrace(state);

  beginClusterWorkConformanceFrame(state, 14, 16);
  recordClusterWorkGraphTargetCopyForConformance(state, {
    recordFrameNumber: 14,
    targetName: 'ssao-raw',
    expectedIdentity: { graphGeneration: 8, recordFrameNumber: 14, textureIdentity: 101 },
    actualIdentity: { graphGeneration: 8, recordFrameNumber: 14, textureIdentity: 101 },
    encoded: true,
  });
  settleClusterWorkConformanceFrame(state, 14, 'submitted');
  recordClusterWorkFrameReceiptForConformance(state, {
    observationFrameId: 16,
    publicReceiptFrameId: 16,
    deviceGeneration: 3,
    presentation: 'ready',
    completed: Promise.resolve({ ok: true, value: undefined }),
  });
  expect(first).toMatchObject({
    recordFrameNumber: 13,
    graphTargetCopy: { recordFrameNumber: 13 },
    receipt: { publicReceiptFrameId: 15, presentation: 'pending' },
  });
  expect(readClusterWorkFrameTrace(state)).toMatchObject({
    recordFrameNumber: 14,
    graphTargetCopy: { recordFrameNumber: 14 },
    receipt: { publicReceiptFrameId: 16, presentation: 'ready' },
  });
  expect(Object.isFrozen(first?.graphTargetCopy)).toBe(true);
});

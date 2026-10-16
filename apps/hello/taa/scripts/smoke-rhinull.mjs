import {
  SCENE_DATA_TEMPORAL_V1_DESCRIPTOR,
  TemporalFrameCoordinator,
  aggregateTemporalDemand,
  describeTemporalDemand,
  standardTemporalLaneAdmission,
} from '@forgeax/engine-render/internal/temporal';
import { createFeatureEvidence } from './required-evidence.mjs';

const STRUCTURAL_FRAME_COUNT = 60;

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

const activeDemand = aggregateTemporalDemand({ taa: true, motionBlur: true });
const activeDescription = describeTemporalDemand(activeDemand);
const activeAdmission = standardTemporalLaneAdmission({
  lane: 'rhi-null',
  demand: activeDemand,
  capabilities: { compute: true, storageBuffer: true, rgba16floatRenderable: true },
});
requireCondition(
  activeAdmission.status === 'available' && activeAdmission.structuralOnly,
  'RhiNull temporal admission must be structural-only',
);
requireCondition(activeDescription.consumerCount === 2, 'RhiNull topology lost a temporal consumer');
requireCondition(
  activeDescription.targetCount === 1 &&
    activeDescription.producerPassCount === 1 &&
    activeDescription.historyCount === 1,
  'RhiNull topology must share one target, producer, and history resource',
);
requireCondition(
  SCENE_DATA_TEMPORAL_V1_DESCRIPTOR.format === activeAdmission.format &&
    SCENE_DATA_TEMPORAL_V1_DESCRIPTOR.sampleCount === 1 &&
    SCENE_DATA_TEMPORAL_V1_DESCRIPTOR.extent === 'render-resolution',
  'RhiNull scene-data access contract is not render-resolution sampled data',
);

const zeroDemand = aggregateTemporalDemand({ taa: false, motionBlur: false });
const zeroDescription = describeTemporalDemand(zeroDemand);
requireCondition(
  zeroDescription.consumerCount === 0 &&
    zeroDescription.targetCount === 0 &&
    zeroDescription.producerPassCount === 0 &&
    zeroDescription.historyCount === 0 &&
    zeroDescription.byteLength === 0,
  'RhiNull zero-work demand must allocate no temporal resources',
);

const unavailable = standardTemporalLaneAdmission({
  lane: 'rhi-null',
  demand: aggregateTemporalDemand({ taa: false, motionBlur: true }),
  capabilities: { compute: false, storageBuffer: false, rgba16floatRenderable: false },
});
requireCondition(
  unavailable.status === 'unavailable' && unavailable.reason === 'capability-missing',
  'RhiNull capability loss was not closed',
);

const coordinator = new TemporalFrameCoordinator();
const recoveryPhases = {
  build: () => undefined,
  encode: () => undefined,
  finish: () => undefined,
  submit: () => undefined,
};
const failed = coordinator.run(
  { current: 'rhi-null-failure', antialias: 'none', temporalDemand: true },
  { ...recoveryPhases, submit: () => { throw new Error('injected RhiNull submit failure'); } },
);
requireCondition(!failed.ok, 'RhiNull failure-recovery matrix did not observe the injected failure');
const failedInspection = coordinator.inspect();
requireCondition(
  failedInspection.epoch === 0 && failedInspection.lastFailure === 'submit',
  'RhiNull failed frame published temporal state',
);
const recovered = coordinator.run(
  { current: 'rhi-null-recovery', antialias: 'none', temporalDemand: true },
  recoveryPhases,
);
requireCondition(recovered.ok, 'RhiNull failure-recovery matrix did not recover');
const recoveredInspection = coordinator.inspect();
requireCondition(
  recoveredInspection.epoch === 1 && recoveredInspection.previous === 'rhi-null-recovery',
  'RhiNull recovery did not publish the first post-failure frame',
);

for (let frame = 0; frame < STRUCTURAL_FRAME_COUNT; frame += 1) {
  const frameDemand = aggregateTemporalDemand({ taa: false, motionBlur: true });
  const frameDescription = describeTemporalDemand(frameDemand);
  const frameAdmission = standardTemporalLaneAdmission({
    lane: 'rhi-null',
    demand: frameDemand,
    capabilities: { compute: true, storageBuffer: true, rgba16floatRenderable: true },
  });
  requireCondition(
    frameAdmission.status === 'available' && frameAdmission.structuralOnly,
    `RhiNull structural frame ${frame} was not admitted`,
  );
  requireCondition(
    frameDescription.consumerCount === 1 &&
      frameDescription.targetCount === 1 &&
      frameDescription.producerPassCount === 1 &&
      frameDescription.historyCount === 0,
    `RhiNull structural frame ${frame} changed motion-blur topology`,
  );
  const receipt = coordinator.run(
    { current: `rhi-null-frame-${frame}`, antialias: 'none', temporalDemand: true },
    recoveryPhases,
  );
  requireCondition(receipt.ok, `RhiNull structural frame ${frame} failed`);
}

const finalInspection = coordinator.inspect();
requireCondition(
  finalInspection.epoch === STRUCTURAL_FRAME_COUNT + 1 &&
    finalInspection.previous === `rhi-null-frame-${STRUCTURAL_FRAME_COUNT - 1}` &&
    finalInspection.lastFailure === undefined,
  'RhiNull structural frame loop did not publish all recovered frames',
);

console.log(JSON.stringify({
  schemaVersion: 'hello-taa-rhinull-smoke/2',
  backend: 'null',
  structuralOnly: true,
  acceptance: 'structural-only',
  pixel: 'not-applicable',
  framesObserved: STRUCTURAL_FRAME_COUNT,
  matrix: {
    topology: activeDescription,
    access: {
      schema: SCENE_DATA_TEMPORAL_V1_DESCRIPTOR.schema,
      format: SCENE_DATA_TEMPORAL_V1_DESCRIPTOR.format,
      sampleCount: SCENE_DATA_TEMPORAL_V1_DESCRIPTOR.sampleCount,
      extent: SCENE_DATA_TEMPORAL_V1_DESCRIPTOR.extent,
      mode: 'sampled-read',
    },
    dependency: {
      producerId: activeAdmission.producerId,
      consumerIds: activeDemand.consumerIds,
      producerPassCount: activeDemand.producerPassCount,
    },
    zeroWork: zeroDescription,
    failureRecovery: {
      failureStage: failedInspection.lastFailure,
      epochAfterFailure: failedInspection.epoch,
      recoveryEpoch: recoveredInspection.epoch,
      recovered: recovered.ok,
    },
  },
  capabilityUnavailable: {
    ...unavailable,
    requiredVisualFailure: false,
    evidencePolicy: 'record-only',
  },
  requiredProbe: 'RhiNull topology/access/dependency/zero-work/failure-recovery matrix',
  featureEvidence: createFeatureEvidence({
    backend: 'rhi-null',
    runner: { kind: 'node', id: 'smoke-rhinull' },
    frames: STRUCTURAL_FRAME_COUNT,
    resolution: { width: 1, height: 1 },
    stages: ['linear-HDR', 'linear-LDR', 'final-sRGB'].map((domain, index) => ({
      id: ['linear-hdr', 'linear-ldr', 'final-display'][index],
      domain,
      readback: { rawHash: '0'.repeat(64), frame: STRUCTURAL_FRAME_COUNT - 1 },
    })),
    resourceGrowth: { stableFrames: 60, byteLengthDelta: 0, bindGroupDelta: 0 },
  }),
}));

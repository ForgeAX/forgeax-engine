import type {
  WaterAdvancedSimulationSource,
  WaterDispersiveOceanConfig,
} from '@forgeax/engine-types';
import { assert, expect, it } from 'vitest';
import { WaterOceanPatch } from '../ocean-patch';
import { validateWaterAsset } from '../validate';

const config: WaterDispersiveOceanConfig = {
  algorithm: 'mode-projected-gravity/1',
  fftResolution: 32,
  domainLengthM: 16,
  centerXZ: [0, 0],
  baseHeightM: 0,
  referenceDepthM: 4,
  gravityMPerSec2: 9.81,
  sourceSlabBoundariesM: [-4, -3, -2, -1, 0],
  collisions: {
    kind: 'simple',
    collisionGroups: 0xffffffff,
    maxElements: 10,
    fieldStepM: 0.1,
    maximumFieldSamplesPerColumn: 128,
  },
  maximumIntervalSeconds: 0.2,
  boundary: { kind: 'periodic' },
  foam: { slopeThreshold: 0.1, emissionPerSecond: 1, decayPerSecond: 0.1 },
  normalRtFormat: 'rgba32float',
  gridMesh: null,
};
const source: WaterAdvancedSimulationSource & { readonly kind: 'water-simulation-recipe' } = {
  kind: 'water-simulation-recipe',
  system: 'water-advanced',
  configurationVersion: 1,
  enabledFeatures: ['oceanPatch'],
  materialGuids: [],
  textureGuids: [],
  oceanPatchConfig: config,
};
const visualNoiseGuid = '019ffa97-7000-7000-8000-000000000012';
const visualNormalDetailFft = {
  noiseTextureGuid: visualNoiseGuid,
  fftResolution: 64,
  domainLengthM: 64,
  normalDomainSizeM: 32,
  gravityMPerSec2: 9.81,
  phillipsAmplitude: 1,
  windAngleDegrees: 45,
  windSpeedMPerSec: 12,
  windAlignment: 4.5,
  timeScale: 1,
  slosh: 0.5,
  normalRtFormat: 'rgba32float' as const,
};
const fullNiagaraConfig = {
  algorithm: 'ue-5.8.1-niagara-fft' as const,
  windAngleDegrees: 45,
  windSpeedMPerSec: 12,
  noiseTextureGuid: visualNoiseGuid,
  fftResolution: 64,
  domainLengthM: 64,
  normalDomainSizeM: 32,
  gravityMPerSec2: 9.81,
  phillipsAmplitude: 1,
  windAlignment: 4,
  timeScale: 1,
  slosh: 0.5,
  chopHack: 0,
  twiddle: 'positive' as const,
  normalization: 'none' as const,
  normalRtFormat: 'rgba32float' as const,
  gridMesh: null,
};
const create = (oceanPatchConfig: WaterDispersiveOceanConfig = config) =>
  WaterOceanPatch.create({
    guid: '019ffa97-7000-7000-8000-000000000011',
    contentVersion: 'native-clock-test',
    asset: { ...source, oceanPatchConfig },
  }).unwrap();
const liveConfig = (ocean: WaterOceanPatch) =>
  ocean.recipe.asset.oceanPatchConfig as WaterDispersiveOceanConfig;

it('projects a positive physical impulse radius below one cell without changing its momentum input', () => {
  const ocean = create();
  ocean.update(1 / 60).unwrap();
  ocean.bindNativeSourceTime({}, 0, 0).unwrap();
  const initial = ocean.frame();
  assert(initial);
  ocean.submitted(initial).unwrap();
  ocean.allocated(1, 0);
  const input = {
    positionXZ: [1, 2] as const,
    radiusM: 0.12,
    velocityImpulseMps: 3,
    timeSeconds: 0,
  };
  expect(ocean.enqueueWaveImpulse(input).ok).toBe(true);
  expect(ocean.frame()?.waveImpulses?.[0]).toMatchObject(input);
  for (const radiusM of [0, -1, Number.MIN_VALUE, Number.POSITIVE_INFINITY])
    expect(ocean.enqueueWaveImpulse({ ...input, radiusM }).ok).toBe(false);
});

it('holds detached wave impulses through discarded frames and consumes only submitted impulses', () => {
  const ocean = create();
  const native = {};
  ocean.update(1 / 60).unwrap();
  ocean.bindNativeSourceTime(native, 1, 60).unwrap();
  const initial = ocean.frame();
  assert(initial);
  ocean.submitted(initial).unwrap();
  ocean.allocated(1, 0);
  const positionXZ: [number, number] = [1, 2];
  ocean
    .enqueueWaveImpulse({ positionXZ, radiusM: 0.6, velocityImpulseMps: 2, timeSeconds: 1 })
    .unwrap();
  positionXZ[0] = 7;
  const held = ocean.frame();
  assert(held);
  expect(held.waveImpulses?.[0]?.positionXZ).toEqual([1, 2]);
  ocean
    .enqueueWaveImpulse({ positionXZ: [3, 2], radiusM: 1, velocityImpulseMps: -1, timeSeconds: 1 })
    .unwrap();
  expect(held.waveImpulses).toHaveLength(1);
  ocean.discarded(held);
  const retry = ocean.frame();
  assert(retry);
  expect(retry.waveImpulses).toHaveLength(2);
  ocean.submitted(retry).unwrap();
  expect(ocean.frame()?.waveImpulses).toHaveLength(0);
  ocean
    .enqueueWaveImpulse({ positionXZ: [0, 0], radiusM: 1, velocityImpulseMps: 1, timeSeconds: 2 })
    .unwrap();
  expect(ocean.frame()?.waveImpulses).toHaveLength(0);
  ocean.reset();
  expect(ocean.inspect().pendingWaveImpulses).toBe(0);
});
const queryBinding = (bodyGeneration = 1) => ({
  worldIdentity: 'world',
  bodyGuid: 'body',
  bodyGeneration,
  maximumAgeSeconds: 0.2,
});
it('releases an unretained query reservation when a new impulse replaces its pending frame', () => {
  const ocean = create();
  const native = {};
  ocean.configureQueryFeedback(queryBinding());
  ocean.update(1 / 60).unwrap();
  ocean.bindNativeSourceTime(native, 1, 60).unwrap();
  ocean.allocated(1, 0);
  for (let index = 0; index < 5; index++) {
    ocean.requestQueryRegion('body', 1, [[0, 0, 0]]);
    expect(ocean.frame()?.queryFeedback).toBeDefined();
    expect(ocean.inspect().queryFeedback.inFlight).toBe(1);
    ocean
      .enqueueWaveImpulse({ positionXZ: [0, 0], radiusM: 1, velocityImpulseMps: 1, timeSeconds: 1 })
      .unwrap();
    expect(ocean.inspect().queryFeedback.inFlight).toBe(0);
  }
  ocean.setPaused(true);
  expect(ocean.frame()?.waveImpulses).toHaveLength(0);
  expect(ocean.inspect().pendingWaveImpulses).toBe(5);
  ocean.setPaused(false);
  expect(ocean.frame()?.waveImpulses).toHaveLength(5);
  ocean.setEnabled(false);
  expect(ocean.inspect().pendingWaveImpulses).toBe(0);
  expect(
    ocean.enqueueWaveImpulse({
      positionXZ: [0, 0],
      radiusM: 1,
      velocityImpulseMps: 1,
      timeSeconds: 1,
    }).ok,
  ).toBe(false);
});
it('queues impulses across the bootstrap allocation until the resolved field is requested', () => {
  const ocean = create();
  ocean.update(1 / 60).unwrap();
  ocean.bindNativeSourceTime({}, 1, 60).unwrap();
  ocean
    .enqueueWaveImpulse({ positionXZ: [0, 0], radiusM: 1, velocityImpulseMps: 1, timeSeconds: 1 })
    .unwrap();
  const bootstrap = ocean.frame();
  assert(bootstrap);
  expect(bootstrap.waveImpulses).toHaveLength(0);
  ocean.submitted(bootstrap).unwrap();
  expect(ocean.inspect().pendingWaveImpulses).toBe(1);
  ocean.allocated(1, 0);
  const resolved = ocean.frame();
  assert(resolved);
  expect(resolved.waveImpulses).toHaveLength(1);
  ocean.submitted(resolved).unwrap();
  expect(ocean.inspect().pendingWaveImpulses).toBe(0);
});
const issueQueryFrame = (ocean: WaterOceanPatch, native: object, step = 60) => {
  ocean.update(1 / 60).unwrap();
  ocean.bindNativeSourceTime(native, step / 60, step).unwrap();
  const frame = ocean.frame();
  assert(frame?.queryFeedback);
  return frame;
};
const createVisual = () =>
  WaterOceanPatch.create({
    guid: '019ffa97-7000-7000-8000-000000000011',
    contentVersion: 'visual-child-test',
    asset: {
      ...source,
      configurationVersion: 2,
      textureGuids: [visualNoiseGuid],
      oceanPatchConfig: { ...config, visualNormalDetailFft },
    },
  }).unwrap();

function completeVisualOutput(ocean: WaterOceanPatch, frameId: number) {
  ocean.update(1 / 60).unwrap();
  ocean.bindNativeSourceTime({}, 1, 60).unwrap();
  ocean.bindVisualNormalDetailNoiseRevision(12);
  const frame = ocean.frame();
  assert(frame?.visualNormalDetailFft);
  ocean.submitted(frame).unwrap();
  ocean.visualNormalDetailFftSubmitted(frame, 64, 0).unwrap();
  const completion = { frameId, deviceGeneration: 0, graphGeneration: 1 };
  ocean.completed(frame, completion, 32, false).unwrap();
  return { frame, completion };
}

it('admits only the closed configuration-version-2 visual FFT mode-projected shape', () => {
  const valid = {
    ...source,
    configurationVersion: 2,
    textureGuids: [visualNoiseGuid],
    oceanPatchConfig: { ...config, visualNormalDetailFft },
  };
  expect(validateWaterAsset(valid).ok).toBe(true);
  expect(validateWaterAsset({ ...valid, configurationVersion: 1 }).ok).toBe(false);
  expect(validateWaterAsset({ ...valid, oceanPatchConfig: config }).ok).toBe(false);
  expect(
    validateWaterAsset({
      ...valid,
      oceanPatchConfig: fullNiagaraConfig,
    }).ok,
  ).toBe(false);
  expect(
    validateWaterAsset({
      ...source,
      textureGuids: [visualNoiseGuid],
      oceanPatchConfig: fullNiagaraConfig,
    }).ok,
  ).toBe(true);
  expect(
    validateWaterAsset({
      ...valid,
      oceanPatchConfig: {
        ...config,
        visualNormalDetailFft: { ...visualNormalDetailFft, fftResolution: 48 },
      },
    }).ok,
  ).toBe(false);
  expect(validateWaterAsset({ ...valid, textureGuids: [] }).ok).toBe(false);
  expect(
    validateWaterAsset({
      ...valid,
      oceanPatchConfig: {
        ...config,
        visualNormalDetailFft: { ...visualNormalDetailFft, domainLengthM: 1e-50 },
      },
    }).ok,
  ).toBe(false);
});

it('changes the visual FFT child revision without resetting residual or query history', () => {
  const ocean = createVisual();
  const ownedConfig = ocean.recipe.asset.oceanPatchConfig;
  assert(ownedConfig.algorithm === 'mode-projected-gravity/1');
  assert('visualNormalDetailFft' in ownedConfig);
  expect(Object.isFrozen(ownedConfig.visualNormalDetailFft)).toBe(true);
  const native = {};
  ocean.configureQueryFeedback({
    worldIdentity: 'world',
    bodyGuid: 'body',
    bodyGeneration: 1,
    maximumAgeSeconds: 0.2,
  });
  ocean.requestQueryRegion('body', 1, [[0, 0, 0]]);
  ocean.update(1 / 60).unwrap();
  ocean.bindNativeSourceTime(native, 1, 60).unwrap();
  const first = ocean.frame();
  assert(first?.queryFeedback);
  ocean.submitted(first).unwrap();
  const completion = { frameId: 1, deviceGeneration: 0, graphGeneration: 1 };
  ocean.completed(first, completion, 32, false).unwrap();
  expect(ocean.inspect().visualNormalDetailFft?.valid).toBe(false);
  const heights = new Float32Array(32 * 32).fill(0.25);
  ocean
    .acceptQueryReadback(first, {
      width: 32,
      height: 32,
      bytesPerRow: 128,
      bytes: new Uint8Array(heights.buffer),
      completion,
    })
    .unwrap();
  const before = ocean.inspect();
  assert(before.queryFeedback.accepted);

  ocean.bindVisualNormalDetailNoiseRevision(12);
  const invalidated = ocean.inspect();
  expect(invalidated).toMatchObject({
    generation: before.generation,
    timeSeconds: before.timeSeconds,
    queryFeedback: { accepted: before.queryFeedback.accepted },
    visualNormalDetailFft: { noiseRevision: 12, valid: false },
  });
  const childFrame = ocean.frame();
  assert(childFrame?.visualNormalDetailFft);
  expect(Object.isFrozen(childFrame.visualNormalDetailFft)).toBe(true);
  expect(childFrame).toMatchObject({
    generation: first.generation,
    timeSeconds: first.timeSeconds,
    reset: false,
    visualNormalDetailFft: { noiseRevision: 12, reset: true },
  });
  ocean.submitted(childFrame).unwrap();
  expect(ocean.visualNormalDetailFftSubmitted(childFrame, 32, 0).ok).toBe(false);
  ocean.visualNormalDetailFftSubmitted(childFrame, 64, 0).unwrap();
  const childCompletion = { frameId: 2, deviceGeneration: 0, graphGeneration: 1 };
  ocean.completed(childFrame, childCompletion, 32, false).unwrap();
  expect(ocean.inspect()).toMatchObject({
    generation: before.generation,
    timeSeconds: before.timeSeconds,
    queryFeedback: { accepted: before.queryFeedback.accepted },
    visualNormalDetailFft: {
      noiseRevision: 12,
      valid: true,
      output: {
        generation: first.generation,
        revision: 2,
        noiseRevision: 12,
        size: 64,
        completion: childCompletion,
      },
    },
  });

  ocean.bindVisualNormalDetailNoiseRevision(13);
  const visualError = ocean.failure(
    'water-advanced-invalid-input',
    'an accepted child FFT noise texture revision',
  );
  ocean.unavailableVisualNormalDetailFft(visualError);
  expect(ocean.inspect()).toMatchObject({
    generation: before.generation,
    timeSeconds: before.timeSeconds,
    queryFeedback: { accepted: before.queryFeedback.accepted },
    visualNormalDetailFft: { noiseRevision: 13, valid: false, error: visualError },
  });
});

it('releases unretained query reservations across repeated visual-noise changes', () => {
  const ocean = createVisual();
  const native = {};
  ocean.configureQueryFeedback({
    worldIdentity: 'world',
    bodyGuid: 'body',
    bodyGeneration: 1,
    maximumAgeSeconds: 0.2,
  });
  ocean.requestQueryRegion('body', 1, [[0, 0, 0]]);
  ocean.update(1 / 60).unwrap();
  ocean.bindNativeSourceTime(native, 1, 60).unwrap();
  const first = ocean.frame();
  assert(first?.queryFeedback);
  expect(ocean.inspect().queryFeedback.inFlight).toBe(1);
  ocean.bindVisualNormalDetailNoiseRevision(12);
  expect(ocean.inspect().queryFeedback.inFlight).toBe(0);

  const second = ocean.frame();
  assert(second?.queryFeedback);
  expect(ocean.inspect().queryFeedback.inFlight).toBe(1);
  ocean.bindVisualNormalDetailNoiseRevision(13);
  expect(ocean.inspect().queryFeedback.inFlight).toBe(0);
});

it('invalidates the current visual output on disable while retaining its qualified completion', () => {
  const ocean = createVisual();
  completeVisualOutput(ocean, 7);
  const before = ocean.inspect();
  expect(before.visualNormalDetailFft).toMatchObject({
    revision: 2,
    noiseRevision: 12,
    valid: true,
    output: {
      generation: before.generation,
      revision: 2,
      noiseRevision: 12,
      size: 64,
      completion: { frameId: 7, deviceGeneration: 0, graphGeneration: 1 },
    },
  });

  ocean.setEnabled(false);
  expect(ocean.inspect()).toMatchObject({
    generation: before.generation + 1,
    state: { status: 'disabled' },
    visualNormalDetailFft: {
      revision: 2,
      noiseRevision: 12,
      valid: false,
      output: {
        generation: before.generation,
        revision: 2,
        noiseRevision: 12,
        size: 64,
        completion: { frameId: 7, deviceGeneration: 0, graphGeneration: 1 },
      },
    },
  });

  ocean.setEnabled(true);
  expect(ocean.inspect()).toMatchObject({
    generation: before.generation + 2,
    state: { status: 'initializing' },
    visualNormalDetailFft: {
      revision: 2,
      valid: false,
      output: { generation: before.generation, revision: 2, noiseRevision: 12 },
    },
  });
});

it('retains a paused visual output and marks a paused noise revision unavailable', () => {
  const ocean = createVisual();
  completeVisualOutput(ocean, 8);
  const accepted = ocean.inspect();
  ocean.setPaused(true);
  expect(ocean.inspect()).toMatchObject({
    generation: accepted.generation,
    timeSeconds: accepted.timeSeconds,
    visualNormalDetailFft: { revision: 2, noiseRevision: 12, valid: true },
  });

  ocean.bindVisualNormalDetailNoiseRevision(13);
  const changed = ocean.inspect();
  expect(changed).toMatchObject({
    generation: accepted.generation,
    timeSeconds: accepted.timeSeconds,
    visualNormalDetailFft: {
      revision: 3,
      noiseRevision: 13,
      valid: false,
      output: {
        generation: accepted.generation,
        revision: 2,
        noiseRevision: 12,
        size: 64,
        completion: { frameId: 8, deviceGeneration: 0, graphGeneration: 1 },
      },
    },
  });
  const frame = ocean.frame();
  assert(frame?.visualNormalDetailFft);
  expect(frame).toMatchObject({
    generation: accepted.generation,
    timeSeconds: accepted.timeSeconds,
    paused: true,
    visualNormalDetailFft: { revision: 3, noiseRevision: 13, reset: true },
  });
});

it.each([
  undefined,
  0,
  1,
  8,
])('accepts entry wave gain %s without changing the recipe version', (entryWaveMultiplier) => {
  const asset = { ...source, oceanPatchConfig: { ...config, entryWaveMultiplier } };
  expect(validateWaterAsset(asset).ok).toBe(true);
});

it.each([
  -1,
  NaN,
  Infinity,
  1e40,
])('refuses entry wave gain %s before GPU upload', (entryWaveMultiplier) => {
  const asset = { ...source, oceanPatchConfig: { ...config, entryWaveMultiplier } };
  expect(validateWaterAsset(asset).ok).toBe(false);
});

it.each([
  undefined,
  0.35,
  1,
])('accepts positive free-wave dissipation %s', (waveDampingPerSecond) => {
  expect(
    validateWaterAsset({ ...source, oceanPatchConfig: { ...config, waveDampingPerSecond } }).ok,
  ).toBe(true);
});

it.each([
  undefined,
  0,
  1,
  2,
  1e-50,
])('accepts surface transport gain %s', (surfaceTransportMultiplier) => {
  expect(
    validateWaterAsset({ ...source, oceanPatchConfig: { ...config, surfaceTransportMultiplier } })
      .ok,
  ).toBe(true);
});

it.each([
  -1,
  NaN,
  Infinity,
  1e40,
])('refuses invalid surface transport gain %s', (surfaceTransportMultiplier) => {
  expect(
    validateWaterAsset({ ...source, oceanPatchConfig: { ...config, surfaceTransportMultiplier } })
      .ok,
  ).toBe(false);
});

it.each([
  0,
  -1,
  NaN,
  Infinity,
  1e40,
  1e-50,
])('refuses invalid free-wave dissipation %s', (waveDampingPerSecond) => {
  expect(
    validateWaterAsset({ ...source, oceanPatchConfig: { ...config, waveDampingPerSecond } }).ok,
  ).toBe(false);
});

it('publishes all-source and receiver-excluded planes under the same native receipt and bounded flight', () => {
  const ocean = create(),
    receiver = { entity: 12, generation: 4 },
    native = {};
  ocean.configureQueryFeedback({
    worldIdentity: 'world',
    bodyGuid: 'body',
    bodyGeneration: 1,
    maximumAgeSeconds: 0.2,
  });
  ocean.requestQueryRegion('body', 1, [[0, 0, 0]], receiver);
  ocean.update(1 / 60).unwrap();
  ocean.bindNativeSourceTime(native, 1, 60).unwrap();
  const initial = ocean.frame();
  assert(initial);
  ocean.submitted(initial).unwrap();
  ocean
    .completed(initial, { frameId: 0, deviceGeneration: 0, graphGeneration: 1 }, 32, true)
    .unwrap();
  ocean.acceptQueryReadback(initial, undefined);
  ocean.allocated(32, 0);
  ocean.update(1 / 60).unwrap();
  ocean.bindNativeSourceTime(native, 1 + 1 / 60, 61).unwrap();
  const frame = ocean.frame();
  assert(frame?.queryFeedback);
  expect(frame.queryFeedback.receivers).toEqual([receiver]);
  ocean.submitted(frame).unwrap();
  const completion = { frameId: 1, deviceGeneration: 0, graphGeneration: 1 };
  ocean.completed(frame, completion, 32, false).unwrap();
  const heights = new Float32Array(32 * 64);
  heights.fill(0.3, 0, 32 * 32);
  heights.fill(0.02, 32 * 32);
  ocean
    .acceptQueryReadback(frame, {
      width: 32,
      height: 64,
      bytesPerRow: 128,
      bytes: new Uint8Array(heights.buffer),
      completion,
    })
    .unwrap();
  const source = ocean.queryFeedbackSnapshot('body');
  expect(source?.field?.receivers).toEqual([receiver]);
  expect(source?.field?.size).toEqual([32, 32]);
  expect(source?.field?.heightsM).toHaveLength(2048);
  expect(ocean.inspect().queryFeedback.maximumBytesPerFrame).toBe(8192);
  expect(ocean.inspect().queryFeedback.inFlight).toBe(0);
  ocean.retainQueryReceivers([]);
  expect(ocean.inspect().queryFeedback.maximumBytesPerFrame).toBe(4096);
});

it.each([
  { accepted: 1024, rejected: 1 },
  { accepted: 1000, rejected: 25 },
])('rejects the whole over-limit request call and recovers for a suffix (%o)', ({
  accepted,
  rejected,
}) => {
  const ocean = create(),
    native = {};
  ocean.configureQueryFeedback(queryBinding());
  ocean.requestQueryRegion(
    'body',
    1,
    Array.from({ length: accepted }, () => [0, 0, 0] as const),
  );
  ocean.requestQueryRegion(
    'body',
    1,
    Array.from({ length: rejected }, () => [7, 0, 7] as const),
  );
  expect(ocean.inspect().queryFeedback.error).toMatchObject({
    detail: { reason: 'region-request-limit' },
  });

  ocean.requestQueryRegion('body', 1, [[0, 0, 0]]);
  expect(ocean.inspect().queryFeedback.error).toBeUndefined();
  const frame = issueQueryFrame(ocean, native);
  expect(frame.queryFeedback?.offset).toEqual([31, 31]);
  expect(frame.queryFeedback?.size).toEqual([32, 32]);
});

it('clears world bounds after a region-limit failure before accepting the next suffix', () => {
  const ocean = create(),
    native = {};
  ocean.configureQueryFeedback(queryBinding());
  ocean.requestQueryRegion('body', 1, [[0, 0, 0]]);
  ocean.requestQueryRegion('body', 1, [
    [-8, 0, -8],
    [8, 0, 8],
  ]);
  expect(ocean.inspect().queryFeedback.error).toMatchObject({
    detail: { reason: 'region-limit' },
  });

  ocean.requestQueryRegion('body', 1, [[0, 0, 0]]);
  expect(ocean.inspect().queryFeedback.error).toBeUndefined();
  const frame = issueQueryFrame(ocean, native);
  expect(frame.queryFeedback?.offset).toEqual([31, 31]);
});

it('captures point coordinates at request time rather than retaining caller arrays', () => {
  const ocean = create(),
    native = {};
  ocean.configureQueryFeedback(queryBinding());
  const held: [number, number, number] = [0, 0, 0];
  ocean.requestQueryRegion('body', 1, [held]);
  held[0] = 7.5;
  ocean.requestQueryRegion('body', 1, [[0, 0, 0]]);

  const frame = issueQueryFrame(ocean, native);
  expect(frame.queryFeedback?.offset).toEqual([31, 31]);
});

it('projects accumulated world extrema through the immutable admitted recipe domain', () => {
  const authoredConfig = { ...config, centerXZ: [2, 0] as [number, number] };
  const ocean = create(authoredConfig),
    native = {};
  ocean.configureQueryFeedback(queryBinding());
  ocean.requestQueryRegion('body', 1, [[0, 0, 0]]);
  expect(Reflect.set(liveConfig(ocean).centerXZ, 0, 0)).toBe(false);
  authoredConfig.centerXZ = [0, 0];
  ocean.requestQueryRegion('body', 1, [[2, 0, 0]]);

  const frame = issueQueryFrame(ocean, native);
  expect(frame.queryFeedback?.offset).toEqual([29, 31]);
});

it('rejects negative resolution and enforces region limits on the admitted positive domain', () => {
  const authoredConfig = { ...config, domainLengthM: 256, fftResolution: 512 };
  expect(
    WaterOceanPatch.create({
      guid: '019ffa97-7000-7000-8000-000000000011',
      contentVersion: 'invalid-resolution-test',
      asset: { ...source, oceanPatchConfig: { ...authoredConfig, fftResolution: -512 } },
    }).ok,
  ).toBe(false);
  const ocean = create(authoredConfig);
  ocean.configureQueryFeedback(queryBinding());
  expect(Reflect.set(liveConfig(ocean), 'domainLengthM', 16)).toBe(false);
  expect(Reflect.set(liveConfig(ocean), 'fftResolution', -512)).toBe(false);

  ocean.requestQueryRegion('body', 1, [
    [-128, 0, -128],
    [128, 0, 128],
  ]);

  expect(ocean.inspect().queryFeedback.error).toMatchObject({
    detail: { reason: 'region-limit' },
  });
});

it('preserves binding, generation, frame-reset and receiver admission timing', () => {
  const ocean = create(),
    native = {};
  const firstReceiver = { entity: 12, generation: 4 };
  ocean.configureQueryFeedback(queryBinding());
  ocean.requestQueryRegion('other-body', 1, [[7, 0, 7]], { entity: 14, generation: 1 });
  ocean.requestQueryRegion('body', 2, [[7, 0, 7]], { entity: 15, generation: 1 });
  ocean.requestQueryRegion('body', 1, [[0, 0, 0]], firstReceiver);

  const first = issueQueryFrame(ocean, native);
  expect(first.queryFeedback?.offset).toEqual([31, 31]);
  expect(first.queryFeedback?.receivers).toEqual([firstReceiver]);
  ocean.discarded(first);

  ocean.requestQueryRegion('body', 1, [[1, 0, 0]]);
  const second = issueQueryFrame(ocean, native, 61);
  expect(second.queryFeedback?.offset).toEqual([1, 31]);
  expect(second.queryFeedback?.receivers).toEqual([firstReceiver]);
  ocean.discarded(second);

  ocean.configureQueryFeedback(queryBinding(2));
  ocean.requestQueryRegion('body', 1, [[0, 0, 0]], firstReceiver);
  const nextReceiver = { entity: 16, generation: 7 };
  ocean.requestQueryRegion('body', 2, [[2, 0, 0]], nextReceiver);
  const nextGeneration = issueQueryFrame(ocean, native, 62);
  expect(nextGeneration.queryFeedback?.binding.bodyGeneration).toBe(2);
  expect(nextGeneration.queryFeedback?.offset).toEqual([3, 31]);
  expect(nextGeneration.queryFeedback?.receivers).toEqual([nextReceiver]);
});

it('retains a nonfinite readback failure until a new completed field succeeds', () => {
  const ocean = create(),
    native = {};
  ocean.configureQueryFeedback({
    worldIdentity: 'world',
    bodyGuid: 'body',
    bodyGeneration: 1,
    maximumAgeSeconds: 0.2,
  });
  ocean.update(1 / 60).unwrap();
  const observation = (step: number, height: number) => {
    ocean.requestQueryRegion('body', 1, [[0, 0, 0]]);
    ocean.bindNativeSourceTime(native, step / 60, step).unwrap();
    const frame = ocean.frame();
    assert(frame?.queryFeedback);
    ocean.submitted(frame).unwrap();
    const completion = { frameId: step, deviceGeneration: 0, graphGeneration: 1 };
    ocean.completed(frame, completion, 32, false).unwrap();
    return {
      frame,
      readback: {
        width: 32,
        height: 32,
        bytesPerRow: 128,
        bytes: new Uint8Array(new Float32Array(32 * 32).fill(height).buffer),
        completion,
      },
    };
  };
  const first = observation(60, 0.1);
  ocean.acceptQueryReadback(first.frame, first.readback).unwrap();
  const failed = observation(61, NaN);
  expect(ocean.acceptQueryReadback(failed.frame, failed.readback)).toMatchObject({
    ok: false,
    error: { detail: { reason: 'nonfinite-readback' } },
  });
  expect(ocean.inspect().queryFeedback).toMatchObject({
    accepted: { sourcePhysicsStep: 60 },
    error: { detail: { reason: 'nonfinite-readback' } },
  });
  expect(ocean.acceptQueryReadback(failed.frame, undefined).ok).toBe(false);
  ocean.requestQueryRegion('body', 1, [[0, 0, 0]]);
  expect(ocean.inspect().queryFeedback.error).toMatchObject({
    detail: { reason: 'nonfinite-readback' },
  });
  const recovered = observation(62, 0.2);
  ocean.acceptQueryReadback(recovered.frame, recovered.readback).unwrap();
  expect(ocean.inspect().queryFeedback.error).toBeUndefined();
  expect(ocean.inspect().queryFeedback.accepted?.sourcePhysicsStep).toBe(62);
});

it('bounds query feedback to three original flights and recovers after discard/reset', () => {
  const ocean = create(),
    native = {};
  ocean.configureQueryFeedback({
    worldIdentity: 'world',
    bodyGuid: 'body',
    bodyGeneration: 1,
    maximumAgeSeconds: 0.2,
  });
  ocean.requestQueryRegion('body', 1, [[0, 0, 0]]);
  ocean.update(1 / 60).unwrap();
  const frames = [1, 1.05, 1.1].map((time) => {
    ocean.bindNativeSourceTime(native, time, Math.round(time * 60)).unwrap();
    const frame = ocean.frame();
    assert(frame?.queryFeedback);
    return frame;
  });
  ocean.bindNativeSourceTime(native, 1.15, 69).unwrap();
  expect(ocean.frame()?.queryFeedback).toBeUndefined();
  expect(ocean.inspect().queryFeedback).toMatchObject({ inFlight: 3, skipped: 1 });
  const [firstFrame, secondFrame, thirdFrame] = frames;
  assert(firstFrame && secondFrame && thirdFrame);
  ocean.discarded(firstFrame);
  ocean.bindNativeSourceTime(native, 1.2, 72).unwrap();
  const next = ocean.frame();
  assert(next?.queryFeedback);
  ocean.submitted(next).unwrap();
  const completion = { frameId: 12, deviceGeneration: 4, graphGeneration: 8 };
  ocean.completed(next, completion, 32, false).unwrap();
  const bytes = new Uint8Array(new Float32Array(32 * 32).fill(0.1).buffer);
  expect(
    ocean.acceptQueryReadback(structuredClone(next), {
      width: 32,
      height: 32,
      bytesPerRow: 128,
      bytes,
      completion,
    }).ok,
  ).toBe(false);
  expect(
    ocean.acceptQueryReadback(next, { width: 32, height: 32, bytesPerRow: 128, bytes, completion })
      .ok,
  ).toBe(true);
  expect(ocean.inspect().queryFeedback).toMatchObject({
    completed: 1,
    bytesReceived: 4096,
    accepted: { sourcePhysicsStep: 72 },
  });
  ocean.deviceLost();
  expect(ocean.inspect().queryFeedback).toMatchObject({ inFlight: 2 });
  expect(ocean.inspect().queryFeedback.accepted).toBeUndefined();
  ocean.discarded(secondFrame);
  ocean.discarded(thirdFrame);
  expect(ocean.inspect().queryFeedback.inFlight).toBe(0);
});

it('admits the explicit geometry-driven recipe and rejects invalid slab, boundary and FFT configurations', () => {
  expect(validateWaterAsset(source).ok).toBe(true);
  for (const edit of [
    { fftResolution: 30 },
    { sourceSlabBoundariesM: [-4, -2, -2, -1, 0] },
    { sourceSlabBoundariesM: [-4, -3, -2, -1, 0.1] },
    { sourceSlabBoundariesM: [-4, -3, 0] },
    { boundary: { kind: 'absorbing', widthM: 9, dampingPerSecond: 1 } },
    { noiseTextureGuid: '019ffa97-7000-7000-8000-000000000012' },
    { domainLengthM: 1e300 },
    { gravityMPerSec2: 1e-300 },
    { baseHeightM: 1e300 },
    { centerXZ: [1e300, 0] },
    { sourceSlabBoundariesM: [-4, -3, -2, -1e-300, 0] },
  ])
    expect(validateWaterAsset({ ...source, oceanPatchConfig: { ...config, ...edit } }).ok).toBe(
      false,
    );
});

it('rejects late A/off/A readbacks and clears accepted fields across pause/resume', () => {
  const ocean = create(),
    native = {};
  const binding = {
    worldIdentity: 'world',
    bodyGuid: 'body',
    bodyGeneration: 1,
    maximumAgeSeconds: 0.2,
  };
  ocean.configureQueryFeedback(binding);
  ocean.requestQueryRegion('body', 1, [
    [1e30, 0, 1e30],
    [0, 0, 0],
  ]);
  ocean.update(1 / 60).unwrap();
  const issue = (step: number) => {
    ocean.bindNativeSourceTime(native, step / 60, step).unwrap();
    const frame = ocean.frame();
    assert(frame?.queryFeedback);
    ocean.submitted(frame).unwrap();
    return frame;
  };
  const first = issue(60);
  ocean.configureQueryFeedback(undefined);
  ocean.configureQueryFeedback(binding);
  const completion = { frameId: 12, deviceGeneration: 4, graphGeneration: 8 };
  ocean.completed(first, completion, 32, false).unwrap();
  const readback = {
    width: 32,
    height: 32,
    bytesPerRow: 128,
    bytes: new Uint8Array(new Float32Array(32 * 32).fill(0.1).buffer),
    completion,
  };
  expect(ocean.acceptQueryReadback(first, readback).ok).toBe(false);
  ocean.requestQueryRegion('body', 1, [[0, 0, 0]]);
  const current = issue(61);
  ocean.completed(current, completion, 32, false).unwrap();
  ocean.acceptQueryReadback(current, readback).unwrap();
  expect(ocean.queryFeedbackSnapshot('body')?.field).toBeDefined();
  const lifecycle = ocean.queryLifecycleIdentity('body');
  ocean.setPaused(true);
  ocean.setPaused(false);
  expect(ocean.queryLifecycleIdentity('body')).not.toBe(lifecycle);
  expect(ocean.queryFeedbackSnapshot('body')?.field).toBeUndefined();
  expect(ocean.acceptQueryReadback(current, readback).ok).toBe(false);
  const failed = issue(62);
  expect(ocean.acceptQueryReadback(failed, undefined).ok).toBe(false);
  expect(ocean.inspect().queryFeedback.inFlight).toBe(0);
  ocean.setPaused(true);
  const paused = issue(100);
  ocean.completed(paused, completion, 32, false).unwrap();
  ocean.acceptQueryReadback(paused, readback).unwrap();
  expect(ocean.queryFeedbackSnapshot('body')?.field).toMatchObject({
    sourcePhysicsStep: 100,
    timeSeconds: 100 / 60,
    simulationTimeSeconds: 62 / 60,
  });
});

it('retains held submitted readbacks in the physical quota across lifecycle changes', () => {
  const ocean = create(),
    native = {};
  const binding = {
    worldIdentity: 'world',
    bodyGuid: 'body',
    bodyGeneration: 1,
    maximumAgeSeconds: 0.2,
  };
  ocean.configureQueryFeedback(binding);
  ocean.update(1 / 60).unwrap();
  ocean.requestQueryRegion('body', 1, [[0, 0, 0]]);
  const held = [1, 2, 3].map((step) => {
    ocean.bindNativeSourceTime(native, step / 60, step).unwrap();
    const frame = ocean.frame();
    assert(frame?.queryFeedback);
    ocean.submitted(frame).unwrap();
    return frame;
  });
  ocean.configureQueryFeedback(undefined);
  ocean.configureQueryFeedback(binding);
  ocean.setPaused(true);
  ocean.setPaused(false);
  ocean.reset();
  ocean.requestQueryRegion('body', 1, [[0, 0, 0]]);
  ocean.bindNativeSourceTime(native, 4 / 60, 4).unwrap();
  expect(ocean.inspect().queryFeedback.inFlight).toBe(3);
  expect(ocean.frame()?.queryFeedback).toBeUndefined();
  const firstHeld = held[0];
  assert(firstHeld);
  expect(ocean.acceptQueryReadback(structuredClone(firstHeld), undefined).ok).toBe(false);
  expect(ocean.inspect().queryFeedback.inFlight).toBe(3);
  expect(ocean.acceptQueryReadback(firstHeld, undefined).ok).toBe(false);
  ocean.bindNativeSourceTime(native, 5 / 60, 5).unwrap();
  expect(ocean.frame()?.queryFeedback).toBeDefined();
  expect(ocean.inspect().queryFeedback.inFlight).toBe(3);
});

it('accepts the original submitted observation after its last source-frame reference retires', () => {
  const ocean = create(),
    native = {};
  ocean.configureQueryFeedback({
    worldIdentity: 'world',
    bodyGuid: 'body',
    bodyGeneration: 1,
    maximumAgeSeconds: 0.2,
  });
  ocean.update(1 / 60).unwrap();
  ocean.requestQueryRegion('body', 1, [[0, 0, 0]]);
  ocean.bindNativeSourceTime(native, 1, 60).unwrap();
  const frame = ocean.frame();
  assert(frame?.queryFeedback);
  ocean.retain(frame);
  ocean.submitted(frame).unwrap();
  ocean.discarded(frame);
  expect(ocean.inspect().queryFeedback.inFlight).toBe(1);
  const completion = { frameId: 12, deviceGeneration: 4, graphGeneration: 8 };
  ocean.completed(frame, completion, 32, false).unwrap();
  ocean
    .acceptQueryReadback(frame, {
      width: 32,
      height: 32,
      bytesPerRow: 128,
      bytes: new Uint8Array(new Float32Array(32 * 32).fill(0.1).buffer),
      completion,
    })
    .unwrap();
  expect(ocean.inspect().queryFeedback).toMatchObject({
    inFlight: 0,
    completed: 1,
    accepted: { sourcePhysicsStep: 60 },
  });
});

it('uses the completed native source time and retains it until submission', () => {
  const ocean = create(),
    native = {};
  ocean.update(1 / 60).unwrap();
  expect(ocean.frame()).toBeUndefined();
  ocean.bindNativeSourceTime(native, 10).unwrap();
  const initial = ocean.frame();
  assert(initial);
  expect(initial).toMatchObject({ timeSeconds: 10, reset: true, reseedSource: true });
  expect(ocean.inspect().timeSeconds).toBe(0);
  ocean.submitted(initial).unwrap();
  ocean.update(100).unwrap();
  ocean.bindNativeSourceTime(native, 10.05).unwrap();
  const next = ocean.frame();
  assert(next);
  expect(next).toMatchObject({ timeSeconds: 10.05, reset: false, reseedSource: false });
  expect(ocean.frame()).toBe(next);
  expect(ocean.inspect().timeSeconds).toBe(10);
  expect(ocean.bindNativeSourceTime(native, -1)).toMatchObject({
    ok: false,
    error: { code: 'water-advanced-invalid-input' },
  });
});

it('holds paused wave time and reseeds moved geometry on resume without discarding the wave generation', () => {
  const ocean = create(),
    native = {};
  ocean.update(1 / 60).unwrap();
  ocean.bindNativeSourceTime(native, 2).unwrap();
  const initial = ocean.frame();
  assert(initial);
  ocean.submitted(initial).unwrap();
  ocean.setPaused(true);
  ocean.bindNativeSourceTime(native, 20).unwrap();
  expect(ocean.frame()).toMatchObject({ timeSeconds: 2, paused: true });
  ocean.setPaused(false);
  const resumed = ocean.frame();
  assert(resumed);
  expect(resumed).toMatchObject({
    generation: initial.generation,
    timeSeconds: 20,
    paused: false,
    reset: false,
    reseedSource: true,
  });
  ocean.submitted(resumed).unwrap();
  ocean.bindNativeSourceTime(native, 20.05).unwrap();
  expect(ocean.frame()).toMatchObject({ reseedSource: false, timeSeconds: 20.05 });
});

it('invalidates prior acknowledgments when the native source owner or clock is replaced', () => {
  const ocean = create(),
    native = {};
  ocean.update(1 / 60).unwrap();
  ocean.bindNativeSourceTime(native, 10).unwrap();
  const old = ocean.frame();
  assert(old);
  ocean.submitted(old).unwrap();
  ocean.bindNativeSourceTime(native, 0).unwrap();
  const rewound = ocean.frame();
  assert(rewound);
  expect(rewound).toMatchObject({
    generation: old.generation + 1,
    reset: true,
    reseedSource: true,
  });
  expect(ocean.submitted(old).ok).toBe(false);
  ocean.submitted(rewound).unwrap();
  ocean.bindNativeSourceTime({}, 1).unwrap();
  expect(ocean.frame()).toMatchObject({
    generation: rewound.generation + 1,
    reset: true,
    reseedSource: true,
  });
});

it.each([
  undefined,
  60,
])('retains the actual native step in captured Ocean frame identity (%s)', (nativeSourceStep) => {
  const ocean = create();
  ocean.update(1 / 60).unwrap();
  ocean.bindNativeSourceTime({}, 1, nativeSourceStep).unwrap();
  ocean.requestStageCapture();
  const frame = ocean.frame();
  assert(frame);
  const completion = { frameId: 1, deviceGeneration: 3, graphGeneration: 5 };
  ocean.submitted(frame).unwrap();
  ocean.completed(frame, completion, 1, true).unwrap();
  ocean
    .acceptReadbacks(frame, [
      {
        name: 'height',
        format: 'rgba32float',
        width: 1,
        height: 1,
        bytesPerRow: 256,
        bytes: new Uint8Array(256),
        completion,
      },
    ])
    .unwrap();
  expect(ocean.textureReadbacks()[0]?.sourceFrame).toEqual({
    generation: frame.generation,
    sequence: frame.sequence,
    timeSeconds: frame.timeSeconds,
    ...(nativeSourceStep === undefined ? {} : { nativeSourceStep }),
  });
});

it('accepts an issued predecessor without clearing its successor or newer source and capture requests', () => {
  const ocean = create(),
    native = {};
  ocean.update(1 / 60).unwrap();
  ocean.bindNativeSourceTime(native, 1).unwrap();
  ocean.requestStageCapture();
  const first = ocean.frame();
  assert(first);
  ocean.bindNativeSourceTime(native, 1.05).unwrap();
  const second = ocean.frame();
  assert(second);
  expect(ocean.submitted(structuredClone(first)).ok).toBe(false);
  expect(ocean.submitted(first).ok).toBe(true);
  const captured = {
    name: 'height',
    format: 'rgba32float' as const,
    width: 1,
    height: 1,
    bytesPerRow: 256,
    bytes: new Uint8Array(256),
    completion: { frameId: 1, deviceGeneration: 3, graphGeneration: 5 },
  };
  ocean.completed(first, captured.completion, 1, true).unwrap();
  ocean.acceptReadbacks(first, [captured]).unwrap();
  expect(ocean.textureReadbacks()[0]?.sourceFrame).toEqual({
    generation: first.generation,
    sequence: first.sequence,
    timeSeconds: first.timeSeconds,
  });
  expect(ocean.frame()).toBe(second);
  ocean.requestStageCapture();
  ocean.acceptReadbacks(first, [captured]).unwrap();
  expect(ocean.textureReadbacks()).toEqual([]);
  ocean.setPaused(true);
  ocean.setPaused(false);
  expect(ocean.submitted(second).ok).toBe(true);
  const third = ocean.frame();
  assert(third);
  expect(third).toMatchObject({ captureStages: true, reseedSource: true });
  expect(ocean.submitted(first).ok).toBe(false);
  const completion = { frameId: 7, deviceGeneration: 3, graphGeneration: 11 };
  ocean.completed(second, completion, 32, false).unwrap();
  ocean.fail(
    ocean.failure('water-advanced-invalid-input', 'the complete permitted native interval'),
  );
  expect(ocean.inspect()).toMatchObject({
    state: { status: 'unavailable' },
    completion,
    timeSeconds: second.timeSeconds,
  });
  ocean.reset();
  expect(ocean.submitted(third).ok).toBe(false);
});

it('keeps retirement terminal across late allocation, failure, capture, and query configuration', () => {
  const ocean = create();
  ocean.retire();

  ocean.allocated(1, 0);
  expect(ocean.inspect().state).toEqual({ status: 'retired' });
  ocean.allocated(32, 0);
  expect(ocean.inspect().state).toEqual({ status: 'retired' });
  ocean.fail(ocean.failure('water-advanced-invalid-input', 'a live World OceanPatch'));
  expect(ocean.inspect().state).toEqual({ status: 'retired' });

  ocean.requestStageCapture();
  ocean.configureQueryFeedback({
    worldIdentity: 'world',
    bodyGuid: 'body',
    bodyGeneration: 1,
    maximumAgeSeconds: 0.2,
  });
  expect(ocean.inspect().state).toEqual({ status: 'retired' });
  expect(ocean.inspect().queryFeedback.binding).toBeUndefined();
  expect(ocean.bindNativeSourceTime({}, 0, 0)).toMatchObject({
    ok: false,
    error: { code: 'water-advanced-disabled' },
  });
  expect(ocean.update(1 / 60).ok).toBe(false);
  expect(ocean.frame()).toBeUndefined();
});

it('keeps submitted query readback reservations until a late retired readback is released', () => {
  const ocean = create(),
    native = {};
  ocean.configureQueryFeedback({
    worldIdentity: 'world',
    bodyGuid: 'body',
    bodyGeneration: 1,
    maximumAgeSeconds: 0.2,
  });
  ocean.requestQueryRegion('body', 1, [[0, 0, 0]], { entity: 12, generation: 4 });
  ocean.update(1 / 60).unwrap();
  ocean.bindNativeSourceTime(native, 1, 60).unwrap();
  const frame = ocean.frame();
  assert(frame?.queryFeedback);
  ocean.submitted(frame).unwrap();
  ocean
    .completed(frame, { frameId: 1, deviceGeneration: 0, graphGeneration: 1 }, 32, false)
    .unwrap();
  ocean.submittedQueryReadback(frame);
  expect(ocean.inspect().queryFeedback.inFlight).toBe(1);

  ocean.retire();
  expect(ocean.inspect()).toMatchObject({
    state: { status: 'retired' },
    queryFeedback: { inFlight: 1 },
  });
  expect(ocean.acceptQueryReadback(frame, undefined)).toMatchObject({
    ok: false,
    error: { detail: { reason: 'retired-readback' } },
  });
  expect(ocean.inspect()).toMatchObject({
    state: { status: 'retired' },
    queryFeedback: { inFlight: 0 },
  });
});

it.each([
  true,
  false,
])('accepts exact-frame query and stage pixels independently, queryFirst=%s', (queryFirst) => {
  const ocean = create(),
    native = {};
  ocean.configureQueryFeedback({
    worldIdentity: 'world',
    bodyGuid: 'body',
    bodyGeneration: 1,
    maximumAgeSeconds: 0.2,
  });
  ocean.requestQueryRegion('body', 1, [[0, 0, 0]]);
  ocean.requestStageCapture();
  ocean.update(1 / 60).unwrap();
  ocean.bindNativeSourceTime(native, 1, 60).unwrap();
  const frame = ocean.frame();
  assert(frame?.queryFeedback);
  ocean.submitted(frame).unwrap();
  const completion = { frameId: 1, deviceGeneration: 0, graphGeneration: 1 };
  ocean.completed(frame, completion, 32, true).unwrap();
  const query = () =>
    ocean
      .acceptQueryReadback(frame, {
        width: 32,
        height: 32,
        bytesPerRow: 128,
        bytes: new Uint8Array(4096),
        completion,
      })
      .unwrap();
  const stage = () =>
    ocean
      .acceptReadbacks(frame, [
        {
          name: 'normal',
          format: 'rgba32float',
          width: 1,
          height: 1,
          bytesPerRow: 256,
          bytes: new Uint8Array(256),
          completion,
        },
      ])
      .unwrap();
  if (queryFirst) {
    query();
    stage();
  } else {
    stage();
    query();
  }
  expect(ocean.inspect().queryFeedback.completed).toBe(1);
  expect(ocean.textureReadbacks()).toHaveLength(1);
  expect(ocean.acceptQueryReadback(frame, undefined).ok).toBe(false);
});

import { readFileSync } from 'node:fs';
import { mat4, vec3 } from '@forgeax/engine-math';
import type { Buffer, RhiQueue } from '@forgeax/engine-rhi';
import { expect, it } from 'vitest';
import type { CameraSnapshot } from '../../render-contract';
import { createTemporalView, type TemporalView } from '../../temporal/view';
import { validateVolumetricFog } from '../../volume/component';
import { admitVolumeHistory, volumeTemporalSignature } from '../../world/history-admission-systems';
import { reprojectDiffuseGiHistory } from '../frame-diffuse-gi';
import { buildFramePostProcessParams, resolveFrameTemporal } from '../frame-temporal';
import { computeViewProjectionMatrix } from '../helpers';
import { writeViewUbo } from '../view-ubo';

function camera(x: number): CameraSnapshot {
  const world = mat4.identity(mat4.create());
  world[12] = x;
  return {
    entityKey: 1,
    historyVersion: 0,
    position: vec3.create(x, 0, 0),
    world,
    fov: Math.PI / 3,
    aspect: 1,
    near: 0.1,
    far: 100,
    projection: 'perspective',
    orthoLeft: -1,
    orthoRight: 1,
    orthoBottom: -1,
    orthoTop: 1,
    tonemap: 'none',
    exposure: 1,
    whitePoint: 4,
    antialias: 'taa',
    bloom: 'off',
    bloomThreshold: 1,
    bloomIntensity: 1,
    bloomSmoothWidth: 0.01,
    bloomRadius: 0,
    clearColor: [0, 0, 0, 1],
    motionBlur: { shutterAngle: 180, maxRadiusPixels: 16, sampleCount: 8, targetFps: 60 },
  };
}

function previousView(): TemporalView {
  return createTemporalView({
    antialias: 'taa',
    width: 32,
    height: 32,
    frameIndex: 2,
    historyVersion: 0,
    viewIdentity: 'camera:1',
    environmentSignature: 'env-a',
    fogSignature: 'fog-a',
    deviceGeneration: 1,
    historyValid: true,
    sampleTimeSeconds: 1,
    currentUnjitteredViewProjection: computeViewProjectionMatrix(camera(0), mat4.create()),
    currentCameraPosition: [0, 0, 0],
  });
}

function resolve(
  options: {
    previous?: TemporalView | undefined;
    camera?: CameraSnapshot;
    width?: number;
    device?: number;
    environment?: string;
    fog?: string;
    reset?: boolean;
    time?: number;
  } = {},
) {
  const prior = 'previous' in options ? options.previous : previousView();
  const current = options.camera ?? camera(0.15);
  const internals = { deviceScope: { generation: options.device ?? 1 } };
  const frameState = { temporalView: { accepted: prior, frameIndex: 3, stage: () => {} } };
  const result = resolveFrameTemporal(
    internals as never,
    frameState as never,
    current,
    1,
    options.width ?? 32,
    32,
    undefined,
    true,
    { deltaSeconds: 1 / 60, elapsedSeconds: options.time ?? 1 + 1 / 60, invalidSampleTime: false },
    options.environment ?? 'env-a',
    options.fog ?? 'fog-a',
    true,
    options.reset ?? false,
    computeViewProjectionMatrix(current, mat4.create()),
  );
  return { ...result, current, internals, frameState, prior };
}

function uploadedView(view: TemporalView, current: CameraSnapshot) {
  let uploaded: Float32Array<ArrayBufferLike> = new Float32Array();
  const queue = {
    writeBuffer: (_buffer: Buffer, offset: number, data: ArrayBufferView) => {
      if (offset === 0)
        uploaded = new Float32Array(
          data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        );
      return { ok: true, value: undefined } as const;
    },
  } as unknown as RhiQueue;
  writeViewUbo(
    queue,
    {} as Buffer,
    current,
    {
      kind: 'directional',
      direction: vec3.create(0, -1, 0),
      color: vec3.create(1, 1, 1),
      intensity: 1,
      contactShadowLength: 0,
    },
    { point: [], spot: [], pointShadow: [] } as never,
    [],
    view,
  );
  return uploaded;
}

/** Independent homogeneous projection of an authored world point, with y-down UV. */
function uv(matrix: ArrayLike<number>, point: readonly number[]) {
  const clip = [0, 1, 3].map(
    (row) =>
      (matrix[row] ?? 0) * (point[0] ?? 0) +
      (matrix[row + 4] ?? 0) * (point[1] ?? 0) +
      (matrix[row + 8] ?? 0) * (point[2] ?? 0) +
      (matrix[row + 12] ?? 0),
  );
  expect(clip[2]).toBeGreaterThan(0);
  return [0.5 + (clip[0] ?? 0) / (2 * (clip[2] ?? 1)), 0.5 - (clip[1] ?? 0) / (2 * (clip[2] ?? 1))];
}

it.each([
  'environment',
  'fog',
] as const)('keeps actual 15cm geometry motion while resetting %s color history', (kind) => {
  const r = resolve({ [kind]: `${kind}-b` });
  expect(r.view.resetReason).toBe(`${kind}-change`);
  expect(r.view.historyValid).toBe(false);
  expect(r.view.temporalFrameIndex).toBe(0);
  expect(r.continuousGeometry).toBe(true);
  expect(r.view.previousUnjitteredViewProjection).toBe(r.prior?.currentUnjitteredViewProjection);
  expect(r.view.previousCameraPosition).toBeUndefined();
  const payload = uploadedView(r.view, r.current);
  expect(payload.subarray(212, 228)).toEqual(r.prior?.currentUnjitteredViewProjection);
  expect(payload[235]).toBe(0);
  let giPrevious: { viewProjection: ArrayLike<number> } | undefined;
  reprojectDiffuseGiHistory(
    {
      screenProbe: {
        reproject: (value: typeof giPrevious) => {
          giPrevious = value;
        },
      },
    } as never,
    r.current,
    r.view,
    r.prior,
    r.continuousGeometry,
  );
  expect(giPrevious).toBeDefined();
  const point = [0.3, 0.2, -2];
  expect(uv(payload.subarray(212, 228), point)).toEqual(
    uv(giPrevious?.viewProjection ?? [], point),
  );
  expect(uv(payload.subarray(196, 212), point)[0]).not.toBe(
    uv(payload.subarray(212, 228), point)[0],
  );
  const params = buildFramePostProcessParams(
    r.internals as never,
    r.frameState as never,
    r.current,
    new Map(),
    r.motionBlurDemand,
    r.deltaSeconds,
    r.view,
    32,
    undefined,
    new Map(),
  );
  const blur = params.get('forgeax.motion-blur');
  expect(blur).toBeDefined();
  expect(new DataView(blur?.buffer ?? new ArrayBuffer(0)).getUint32(12, true)).toBe(1);
});

it('retains the ordinary continuous history pair', () => {
  const r = resolve();
  expect(r.view.historyValid).toBe(true);
  expect(r.view.resetReason).toBeUndefined();
  expect(r.continuousGeometry).toBe(true);
  expect(r.view.previousUnjitteredViewProjection).toBe(r.prior?.currentUnjitteredViewProjection);
  expect(r.view.previousCameraPosition).toBe(r.prior?.currentCameraPosition);
  expect(uploadedView(r.view, r.current)[235]).toBe(1);
});

it.each([false, true])('preserves volume history admission after environment reset=%s', (reset) => {
  // Keep the camera fixed: a cameraRevision change would hide the second-gate regression.
  const current = camera(0);
  const r = resolve({ camera: current, environment: reset ? 'env-b' : 'env-a' });
  const fog = {
    status: 'available' as const,
    lightKind: 'directional' as const,
    lightEntity: 1 as never,
    fog: validateVolumetricFog({
      light: 1 as never,
      sampling: 'uniform',
      bounds: { min: [-1, -1, -3], max: [1, 1, -1] },
      extinction: [0.1, 0.1, 0.1],
      albedo: [1, 1, 1],
      emission: [0, 0, 0],
      anisotropy: 0,
      maxDistance: 10,
    }).unwrap(),
  };
  const prepared = { densityGeneration: 1 };
  const lights = {
    point: [],
    spot: [],
    directional: {
      entity: 1,
      kind: 'directional',
      direction: new Float32Array([0, -1, 0]),
      color: new Float32Array([1, 1, 1]),
      intensity: 1,
      contactShadowLength: 0,
    },
  };
  const signature = volumeTemporalSignature(
    fog,
    prepared as never,
    current,
    lights as never,
    32,
    32,
  );
  const admission = admitVolumeHistory(
    {
      volumetricFogHistorySlot: 0,
      volumetricFogHistorySignature: signature,
      temporalFrameTransaction: { accepted: () => ({ resetReason: 'none' }) },
    } as never,
    fog,
    prepared as never,
    current,
    lights as never,
    32,
    32,
  );
  expect(admission.readSlot).toBe(0);
  // Execute the exact production shader gate on the real admission and View UBO.
  const shader = readFileSync(
    new URL('../../../../shader/src/volume/volume-temporal.wgsl', import.meta.url),
    'utf8',
  );
  const gate = 'volume_params.optics.w >= 0.5 && volume_view.temporalPreviousCameraPos.w >= 0.5';
  expect(shader.split(`let historyValid = ${gate};`)).toHaveLength(2);
  const admitted = Function(
    'volume_params',
    'volume_view',
    `return ${gate};`,
  )(
    { optics: { w: Number(admission.readSlot !== null) } },
    { temporalPreviousCameraPos: { w: uploadedView(r.view, current)[235] } },
  );
  expect(admitted).toBe(!reset);
  expect(r.view.previousUnjitteredViewProjection).toBe(r.prior?.currentUnjitteredViewProjection);
});

it.each([
  ['first frame', { previous: undefined }],
  ['resize', { width: 33 }],
  ['camera cut', { camera: { ...camera(0.15), historyVersion: 1 } }],
  ['another camera', { camera: { ...camera(0.15), entityKey: 2 } }],
  ['device recovery', { device: 2 }],
  ['time reset', { reset: true }],
  ['nonmonotonic time', { time: 0.5 }],
  ['lighting and time reset', { environment: 'env-b', reset: true }],
] as const)('does not borrow a geometry pair across %s', (_name, options) => {
  const r = resolve(options);
  expect(r.view.historyValid).toBe(false);
  expect(r.continuousGeometry).toBe(false);
  expect(r.view.previousUnjitteredViewProjection).toBeUndefined();
  expect(r.view.previousCameraPosition).toBeUndefined();
  expect(Array.from(uploadedView(r.view, r.current).subarray(212, 228))).toEqual(
    new Array(16).fill(0),
  );
});

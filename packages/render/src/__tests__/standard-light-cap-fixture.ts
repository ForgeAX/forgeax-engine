import { createHash } from 'node:crypto';
import { mat4, vec3 } from '@forgeax/engine-math';
import { prepareFrameLighting } from '../record/frame-lighting';
import type { RenderFrameState } from '../record/frame-snapshot';
import type { RenderSystemInternals } from '../record/render-context';
import type { CameraSnapshot } from '../render-contract';
import type {
  DirectionalLightSnapshot,
  PointLightSnapshot,
  RectAreaDirectLightSnapshot,
  SpotLightSnapshot,
} from '../render-system-extract';
import type { ViewLights } from '../world/render-lights';
import {
  packTestClusterUniform,
  packTestDirectLightSlot,
  STANDARD_CLUSTER_TEST_ABI,
} from './cluster-test-abi';

/** Deterministic pseudo-random sequence for light fixtures. */
function sequence(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export function fixtureCamera(z = 5): CameraSnapshot {
  return {
    position: vec3.create(0, 0, z),
    world: mat4.fromTranslation(mat4.create(), [0, 0, z]),
    fov: Math.PI / 3,
    aspect: 16 / 9,
    near: 0.1,
    far: 200,
    projection: 'perspective',
    orthoLeft: -1,
    orthoRight: 1,
    orthoBottom: -1,
    orthoTop: 1,
    tonemap: 'none',
    exposure: 1,
    whitePoint: 4,
    antialias: 'none',
    bloom: 'off',
    bloomThreshold: 1,
    bloomIntensity: 1,
    bloomSmoothWidth: 0.01,
    bloomRadius: 0,
    clearColor: [0, 0, 0, 1],
  };
}

export interface FixtureCounts {
  readonly point: number;
  readonly spot: number;
  readonly rect: number;
  readonly additionalDirectional?: number;
  readonly range?: number;
}

/** Point, spot and rect lights scattered in front of the fixture camera, each with its own entity. */
export function fixtureLights(counts: FixtureCounts, seed = 7): ViewLights {
  const next = sequence(seed);
  const range = counts.range ?? 6;
  const invRangeSquared = 1 / (range * range);
  let entity = 1;
  const place = () => vec3.create(next() * 40 - 20, next() * 20 - 10, -next() * 60);
  const color = () => vec3.create(next() + 0.1, next() + 0.1, next() + 0.1);
  const point: PointLightSnapshot[] = [];
  for (let i = 0; i < counts.point; i++)
    point.push({
      kind: 'point',
      position: place(),
      color: color(),
      intensity: 1,
      invRangeSquared,
      entity: entity++,
      worldId: 0,
    } as unknown as PointLightSnapshot);
  const spot: SpotLightSnapshot[] = [];
  for (let i = 0; i < counts.spot; i++)
    spot.push({
      kind: 'spot',
      position: place(),
      direction: vec3.normalize(vec3.create(0, 0, 0), vec3.create(next() - 0.5, -1, next() - 0.5)),
      color: color(),
      intensity: 1,
      invRangeSquared,
      cosInner: Math.cos(0.3),
      cosOuter: Math.cos(0.6),
      castShadow: false,
      shadowAtlasTile: -1,
      entity: entity++,
      worldId: 0,
    } as unknown as SpotLightSnapshot);
  const rect: RectAreaDirectLightSnapshot[] = [];
  for (let i = 0; i < counts.rect; i++)
    rect.push({
      kind: 'rect-area',
      position: place(),
      axisX: vec3.create(1, 0, 0),
      axisY: vec3.create(0, 0, 1),
      halfWidth: 0.5,
      halfHeight: 0.25,
      color: color(),
      intensity: 1,
      invRangeSquared,
      entity: entity++,
      worldId: 0,
    } as unknown as RectAreaDirectLightSnapshot);
  const additionalDirectional: DirectionalLightSnapshot[] = [];
  for (let i = 0; i < (counts.additionalDirectional ?? 0); i++)
    additionalDirectional.push({
      kind: 'directional',
      direction: vec3.normalize(vec3.create(0, 0, 0), vec3.create(next() - 0.5, -1, next() - 0.5)),
      color: color(),
      intensity: 1,
      contactShadowLength: 0,
      sourceAngle: 0,
      entity: entity++,
    } as unknown as DirectionalLightSnapshot);
  return {
    directional: {
      kind: 'directional',
      direction: vec3.create(0, -1, 0),
      color: vec3.create(1, 1, 1),
      intensity: 1,
      contactShadowLength: 0,
      sourceAngle: 0,
    },
    directionalCount: 1 + additionalDirectional.length,
    ...(additionalDirectional.length === 0 ? {} : { additionalDirectional }),
    point,
    spot,
    rect,
    depthBias: undefined,
    normalBias: undefined,
    directionalShadowError: undefined,
    pointShadow: [],
    directionalCsmConfig: undefined,
    directionalCsmDirection: undefined,
    cascades: undefined,
    shadowViews: [],
  } as unknown as ViewLights;
}

export function fixtureInternals(lightCount?: number): RenderSystemInternals {
  return {
    device: {
      caps: { storageBuffer: true, compute: false },
      limits: { maxTextureDimension2D: 8192 },
    },
    standardProfile: lightCount === undefined ? undefined : { lightCount, renderPath: 'forward' },
    standardClusterAbi: STANDARD_CLUSTER_TEST_ABI,
    errorRegistry: { fire: () => undefined },
  } as unknown as RenderSystemInternals;
}

export function fixtureFrameState(): RenderFrameState {
  return {
    pointShadowSnapshots: [],
    spotShadowSnapshots: [],
    installedPipelineConfig: {},
    warnedStandardLocalLightCap: false,
    warnedStandardClusterEntryCap: false,
  } as unknown as RenderFrameState;
}

/** Everything the Cluster upload derives from one prepared frame. */
export function clusterPayload(
  lights: ViewLights,
  internals = fixtureInternals(),
  frameState = fixtureFrameState(),
  camera = fixtureCamera(),
) {
  const result = prepareFrameLighting(internals, frameState, lights, camera);
  if (!result.ok) throw result.error;
  const standard = result.value.standard;
  if (standard.kind !== 'clustered') throw new Error('expected a clustered frame');
  const { prepared, transport } = standard;
  const slots = prepared.local.map((light) =>
    light.source === undefined ? new Float32Array(0) : packTestDirectLightSlot(light.source),
  );
  const uniform = packTestClusterUniform({
    grid: prepared.layout.grid,
    near: camera.near,
    far: camera.far,
    lightCount: prepared.membershipLightCount,
    directionalLightCount: prepared.local.length - prepared.membershipLightCount,
  });
  return {
    prepared,
    transport,
    grid: prepared.clusterGrid,
    indices: prepared.lightIndexList.subarray(0, prepared.membershipEntryCount),
    bounds: prepared.lightBounds,
    slots,
    uniform: new Uint8Array(uniform),
  };
}

export function hashPayload(payload: ReturnType<typeof clusterPayload>): string {
  const hash = createHash('sha256');
  const bytes = (view: ArrayBufferView) =>
    hash.update(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  bytes(payload.grid);
  bytes(payload.indices);
  bytes(payload.bounds);
  for (const slot of payload.slots) bytes(slot);
  bytes(payload.uniform);
  return hash.digest('hex');
}

import { World } from '@forgeax/engine-ecs';
import { describe, expect, it, vi } from 'vitest';
import { DirectionalLight } from '../../components/directional-light';
import { VolumetricCloudLayer } from '../../components/volumetric-cloud-layer';
import {
  type CloudDensityControls,
  type CloudDensityPoint,
  evaluateReferenceConservative,
  evaluateReferenceMedium,
} from '../density/reference-model';
import { extractStandardCloudLayer } from '../extract';
import { inspectCloudLayer } from '../inspection';
import { cloudHenyeyGreenstein } from '../lighting/optics';
import {
  cloudRayShadowTransmittance,
  createCloudShadowProjection,
  projectCloudShadowUv,
} from '../lighting/shadow';
import { bilateralCloudUpsample, composeCloudTransport } from '../reconstruction/composition';
import {
  abortCloudHistory,
  acceptCloudHistory,
  cloudHistoryExtent,
  createCloudHistoryState,
  prepareCloudHistory,
} from '../reconstruction/history';
import { selectCloudReconstructionSample } from '../reconstruction/reconstruction';

const controls: CloudDensityControls = {
  layoutScaleMeters: 1000,
  coverageBias: 0,
  extinctionPerMeter: 0.001,
  albedo: [1, 0.8, 0.5, 1],
  layoutWeight: 1,
  maskWeight: 1,
  profileWeight: 1,
  bodyWeight: 1,
  erosionWeight: 1,
};
const point: CloudDensityPoint = {
  positionMeters: [5000, 6000, 7000],
  cameraRelativeMeters: [0, 6000, 0],
  heightFraction: 0.5,
  windOffsetMeters: [0, 0, 0],
};
const textures = {
  pattern: () => [0.5, 0.6, 0.7, 1] as const,
  mask: () => [0, 0, 0, 1] as const,
  profile: () => [0.8, 0.8, 0.8, 1] as const,
  body: () => [0.8, 0.7, 0.6, 1] as const,
};

describe('sampled cloud field and transport contracts', () => {
  it('does not consume light or resource state when no volumetric cloud owner exists', () => {
    const world = new World();
    world.components.register(VolumetricCloudLayer).unwrap();
    world.spawn({ component: DirectionalLight, data: {} }).unwrap();
    const resources = vi.spyOn(world, 'getResource');
    const query = vi.spyOn(world, 'query');
    expect(extractStandardCloudLayer(world).unwrap()).toBeUndefined();
    expect(resources).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('keeps fixed texture samples deterministic and coverage monotonic', () => {
    const c4 = evaluateReferenceConservative(point, controls, textures, false);
    expect(evaluateReferenceConservative(point, controls, textures, false)).toEqual(c4);
    const density = (coverageBias: number) =>
      evaluateReferenceMedium(
        point,
        { ...controls, coverageBias },
        evaluateReferenceConservative(point, { ...controls, coverageBias }, textures, false),
      ).extinctionPerMeter;
    expect(density(-0.2)).toBeLessThanOrEqual(density(0));
    expect(density(0)).toBeLessThanOrEqual(density(0.2));
  });
  it('advects the sampled field through the authored world-space wind offset', () => {
    const visited: number[][] = [];
    const body = (uv: readonly number[]) => {
      visited.push([...uv]);
      return [0.8, 0.7, 0.6, 1] as const;
    };
    evaluateReferenceConservative(point, controls, { ...textures, body }, false);
    const before = [...visited];
    visited.length = 0;
    evaluateReferenceConservative(
      { ...point, windOffsetMeters: [100, 200, 300] },
      controls,
      { ...textures, body },
      false,
    );
    expect(visited).not.toEqual(before);
    expect(visited[0]).not.toEqual(before[0]);
    expect(visited[1]).not.toEqual(before[1]);
  });
  it('keeps vertical wind moving at late times and continuous across a five-second boundary', () => {
    const body = (uv: readonly number[]) => {
      const value = 0.5 + 0.5 * Math.sin((uv[2] ?? 0) * 2 * Math.PI);
      return [value, value, value, 1] as const;
    };
    const density = (seconds: number) => {
      const sample = { ...point, windOffsetMeters: [0, 10 * seconds, 0] as const };
      return evaluateReferenceMedium(
        sample,
        controls,
        evaluateReferenceConservative(sample, controls, { ...textures, body }, false),
      ).extinctionPerMeter;
    };
    expect(Math.abs(density(7) - density(0))).toBeGreaterThan(0.00001);
    expect(Math.abs(density(107) - density(100))).toBeGreaterThan(0.00001);
    expect(Math.abs(density(5.00001) - density(4.99999))).toBeLessThan(0.000001);
  });
  it('keeps light-path extinction and normalized directional phase independent of camera transport', () => {
    expect(cloudRayShadowTransmittance(100, 16, () => 0.02, 1, 0)[0]).toBeCloseTo(Math.exp(-2), 12);
    expect(cloudHenyeyGreenstein(0, -1)).toBeCloseTo(1 / (4 * Math.PI), 12);
    expect(cloudHenyeyGreenstein(0.5, 1)).toBeGreaterThan(cloudHenyeyGreenstein(0.5, -1));
    expect(composeCloudTransport([2, 4, 6], [1, 2, 3, 0.5])).toEqual([2, 4, 6]);
  });
  it('keeps a detached world-space shadow projection stable within its texel', () => {
    const projection = createCloudShadowProjection({
      center: [0, 0, 0],
      sunDirection: [0, 1, 0],
      range: 1024,
      resolution: 1024,
    });
    const moved = createCloudShadowProjection({
      center: [0.1, 0, 0.1],
      sunDirection: [0, 1, 0],
      range: 1024,
      resolution: 1024,
    });
    expect(moved.origin).toEqual(projection.origin);
    expect(projectCloudShadowUv(projection, [0, 0, 0])).toEqual({ uv: [0.5, 0.5], inRange: true });
    expect(projectCloudShadowUv(projection, [10000, 0, 0]).inRange).toBe(false);
    expect(
      createCloudShadowProjection({ center: [0, 0, 0], sunDirection: [1, 0, 0], range: 1024 })
        .lowSun,
    ).toBe(true);
  });
  it('rejects disoccluded and outside history while retaining bounded reprojection', () => {
    const current = {
      far: [1, 2, 3, 0.5] as const,
      near: [0, 0, 0, 1] as const,
      depthMeters: [5000, 6000, 6000, 6000] as const,
    };
    const input = {
      current,
      history: { ...current, far: [2, 3, 4, 0.5] as const },
      historyUv: [0.5, 0.5] as const,
      pixel: [1, 0] as const,
      pixelOffset: [0, 0] as const,
      currentExposure: 1,
      historyExposure: 1,
      minimumReprojectionDistanceMeters: 1000,
      disableDisocclusionDistanceMeters: 100000,
    };
    expect(selectCloudReconstructionSample(input).reason).toBe('history');
    expect(selectCloudReconstructionSample({ ...input, historyUv: [-0.1, 0.5] }).reason).toBe(
      'outside',
    );
    expect(
      selectCloudReconstructionSample({
        ...input,
        history: { ...current, depthMeters: [5000, 10000, 6000, 6000] },
      }).reason,
    ).toBe('depth');
    expect(bilateralCloudUpsample([current], 10, [1])).toEqual([0, 0, 0, 1]);
  });
  it('keeps physical measurements unknown without a receipt and ceil-halves odd history extents', () => {
    const inspection = inspectCloudLayer({ authored: true, generation: 1 });
    expect(inspection.budget.measured).toBe(false);
    expect(inspection.resourceFacts).toBeUndefined();
    expect(inspection.capability.physicalGpu).toBe('unknown');
    expect(cloudHistoryExtent(1919, 1079)).toEqual({ width: 960, height: 540 });
  });
  it('captures borrowed history stamps and rejects source, resize, recovery, initialization and cut discontinuities', () => {
    const stamp = {
      viewId: 'main',
      width: 64,
      height: 32,
      deviceGeneration: 0,
      materialIdentity: 'program:a',
      policyIdentity: 'mode0',
      initializationRevision: 0,
      exposure: 1,
    };
    const state = createCloudHistoryState<string>();
    const pending = prepareCloudHistory(state, stamp);
    stamp.width = 128;
    expect(pending.stamp.width).toBe(64);
    acceptCloudHistory(state, pending, 'accepted');
    const original = { ...stamp, width: 64 };
    for (const [change, reason] of [
      [{ materialIdentity: 'program:b' }, 'material-changed'],
      [{ width: 128 }, 'resize'],
      [{ deviceGeneration: 1 }, 'device-generation'],
      [{ initializationRevision: 1 }, 'initialization'],
      [{ cameraCut: true }, 'camera-cut'],
    ] as const) {
      const candidate = prepareCloudHistory(state, { ...original, ...change });
      expect(candidate.resetReasons).toContain(reason);
      expect(candidate.history).toBeUndefined();
      abortCloudHistory(state, candidate);
      expect(state.accepted?.resource).toBe('accepted');
    }
    const continuous = prepareCloudHistory(state, { ...original, exposure: 2 });
    expect(continuous.history?.resource).toBe('accepted');
    expect(continuous.resetReasons).toEqual([]);
  });
});

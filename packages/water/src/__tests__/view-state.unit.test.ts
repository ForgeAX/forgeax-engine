import { vec3 } from '@forgeax/engine-math';
import type { PhysicsWorld, SphereSweepHit } from '@forgeax/engine-physics';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import type {
  WaterBodyAsset,
  WaterBodySnapshot,
  WaterDependencySnapshot,
  WaterQueryResult,
  WaterWaveSetAsset,
} from '../contracts.js';
import { WaterQueryFlags } from '../contracts.js';
import {
  selectWaterView,
  WATER_DEFAULT_UNDERWATER_TRACE_FILTER_MASK,
  type WaterViewInput,
} from '../view-state.js';

const view: WaterViewInput = {
  viewId: 'camera:7',
  traceGeneration: 12,
  positionM: [0, 0, 0],
  timeSeconds: 2,
  nearPlaneCornerDistanceM: 0.05,
};
const waveGuid = '00000000-0000-7000-8000-000000000009';
const waves: WaterWaveSetAsset = {
  kind: 'water-wave-set',
  sourceMode: 'predefined',
  inputDigest: 'a'.repeat(64),
  waves: [{ directionXZ: [1, 0], wavelengthM: 8, amplitudeM: 0.1, steepness: 0.2 }],
  depthMaskM: 2,
  maxWaveHeightM: 0.1,
  timeSource: 'scene-clock',
};
const acceptedWaves: WaterDependencySnapshot = {
  guid: waveGuid,
  field: 'waveSetGuid',
  kind: 'water-wave-set',
  status: 'valid',
  payload: waves,
};
function body(
  entity: number,
  overrides: Partial<WaterBodyAsset> = {},
  dependencies: readonly WaterDependencySnapshot[] = [],
): WaterBodySnapshot {
  const guid = `body:${entity}`;
  return {
    guid,
    sourceAssetGuid: guid,
    instanceEntity: entity,
    worldMatrixM: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    sourceVersion: '1',
    sceneGeneration: 3,
    exclusionVolumes: [],
    asset: {
      kind: 'water-body',
      type: 'lake',
      surfaceMaterialGuid: 'surface',
      underwaterPostProcessMaterialGuid: 'underwater',
      baseHeightM: 0,
      overlapPriority: 0,
      maxWaveHeightM: 0,
      flags: { affectsWaterInfo: false, affectsWaterMesh: false, affectsLandscape: false },
      collision: { type: 'polygon', enabled: true },
      spline: { closed: true, points: [] },
      queryFootprint: [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ],
      ...overrides,
    },
    binding: { kind: 'zone-unbound', retryOnCatalogChange: true },
    dependencies,
    outputs: {
      geometry: 'ready',
      waterInfo: 'not-requested',
      waterMesh: 'not-requested',
      terrainBrush: 'not-requested',
      collision: 'ready',
      query: 'ready',
      material: 'ready',
    },
    outputGenerations: {
      geometry: 1,
      waterInfo: 0,
      waterMesh: 0,
      terrainBrush: 0,
      collision: 1,
      query: 1,
      material: 1,
    },
    outputReceipts: {},
    dirty: new Set(),
  };
}
const hit = (entity: number, y = -1, colliderId = entity): SphereSweepHit => ({
  entity,
  colliderId,
  timeOfImpact: 0,
  point: vec3.create(0, y, 0),
  normal: vec3.create(0, 1, 0),
  initialOverlap: true,
});
function sample(bodyGuid: string, immersionM = 1, maxHeightM = 0): WaterQueryResult {
  return {
    bodyGuid,
    bodyGeneration: 3,
    adjustedFlags:
      WaterQueryFlags.ComputeImmersionDepth |
      WaterQueryFlags.ComputeLocation |
      WaterQueryFlags.IncludeWaves,
    valid: new Set(['location', 'immersion', 'waves']),
    surfaceM: [0, immersionM, 0],
    immersionM,
    excluded: false,
    source: 'plane',
    waveInfo: { timeSeconds: 2, heightM: 0, maxHeightM, attenuation: 1, normalYUp: [0, 1, 0] },
  };
}
function select(
  bodies: readonly WaterBodySnapshot[],
  coarse: readonly SphereSweepHit[],
  options: {
    precise?: readonly SphereSweepHit[];
    view?: Partial<WaterViewInput>;
    collisionFilterMask?: number;
    samples?: Readonly<Record<string, WaterQueryResult>>;
  } = {},
) {
  const sweepSphereAll = vi
    .fn<NonNullable<PhysicsWorld['sweepSphereAll']>>()
    .mockReturnValueOnce(ok(coarse))
    .mockReturnValueOnce(ok(options.precise ?? []));
  const queryBody = vi.fn((guid: string) => ok(options.samples?.[guid] ?? sample(guid)));
  const state = selectWaterView({
    view: { ...view, ...options.view },
    collisionFilterMask: options.collisionFilterMask ?? WATER_DEFAULT_UNDERWATER_TRACE_FILTER_MASK,
    sceneGeneration: 8,
    bodies,
    physics: { sweepSphereAll },
    queryBody,
  }).unwrap();
  return { state, queryBody, sweepSphereAll };
}

describe('Water view selection', () => {
  it('finishes classification at the first eligible body in the ordered coarse hits', () => {
    const first = body(1, { waveSetGuid: waveGuid, overlapPriority: 10 }, [acceptedWaves]);
    const later = body(2, { waveSetGuid: waveGuid }, [acceptedWaves]);
    const { state, queryBody } = select([first, later], [hit(2), hit(1)], {
      samples: { 'body:1': sample('body:1', 2, 0.1), 'body:2': sample('body:2', 3, 4) },
    });
    expect(state).toMatchObject({ selectedBody: 'body:1', intersection: 'underwater' });
    expect(queryBody.mock.calls.map(([guid]) => guid)).toEqual(['body:1', 'body:2']);
    expect(state.candidates.map((entry) => entry.outcome)).toEqual(['selected', 'accepted']);
  });

  it('clamps an above-surface selection to the one-centimeter outside sentinel', () => {
    const { state } = select([body(1)], [hit(1)], {
      samples: { 'body:1': sample('body:1', -0.02) },
    });
    expect(state).toMatchObject({
      selectedBody: 'body:1',
      immersionDepthM: -0.01,
      audioUnderwater: false,
      visualPpActive: true,
    });
  });

  it('uses strict coarse hit height before requesting the precise sphere', () => {
    const { state, sweepSphereAll } = select([body(1)], [hit(1, 0)], {
      view: { positionM: [0, 0.01, 0] },
    });
    expect(state.selectedBody).toBe('body:1');
    expect(state.trace.usedPrecise).toBe(false);
    expect(sweepSphereAll).toHaveBeenCalledTimes(1);
  });

  it('retains native precise ordering instead of applying material overlap priority', () => {
    const { state, sweepSphereAll } = select(
      [body(1), body(2, { overlapPriority: 100 })],
      [hit(2, 0)],
      {
        precise: [hit(1), hit(2)],
        collisionFilterMask: 0x00020004,
      },
    );
    expect(state).toMatchObject({ selectedBody: 'body:1', trace: { usedPrecise: true } });
    expect(
      sweepSphereAll.mock.calls.map(([start, end, radius, mask]) => [
        Array.from(start),
        Array.from(end),
        radius,
        mask,
      ]),
    ).toEqual([
      [[0, 0, 0], [0, 1, 0], 1, 0x00020004],
      [[0, 0, 0], [0, 0, 0], 0.1, 0x00020004],
    ]);
  });

  it.each([
    { name: 'missing', dependencies: [] },
    { name: 'unavailable', dependencies: [{ ...acceptedWaves, status: 'unavailable' as const }] },
    { name: 'wrong kind', dependencies: [{ ...acceptedWaves, payload: { kind: 'mesh' } }] },
    { name: 'empty waves', dependencies: [{ ...acceptedWaves, payload: { ...waves, waves: [] } }] },
  ])('does not rank a $name wave dependency as HasWaves', ({ dependencies }) => {
    const declared = body(1, { waveSetGuid: waveGuid, overlapPriority: 100 }, dependencies);
    const actual = body(2, { waveSetGuid: waveGuid, overlapPriority: -100 }, [acceptedWaves]);
    const { state } = select([declared, actual], [hit(1), hit(2)]);
    expect(state.selectedBody).toBe('body:2');
    expect(state.candidates[0]?.hasWaves).toBe(true);
  });

  it('never ranks River wave references as supported waves', () => {
    const { state } = select(
      [
        body(1, { type: 'river', waveSetGuid: waveGuid, overlapPriority: 100 }, [acceptedWaves]),
        body(2, { waveSetGuid: waveGuid }, [acceptedWaves]),
      ],
      [hit(1), hit(2)],
    );
    expect(state.selectedBody).toBe('body:2');
  });

  it('includes accepted Custom waves in the coarse wave ordering', () => {
    const { state } = select(
      [
        body(1, { overlapPriority: 100 }),
        body(2, { type: 'custom', waveSetGuid: waveGuid }, [acceptedWaves]),
      ],
      [hit(1), hit(2)],
    );
    expect(state.selectedBody).toBe('body:2');
    expect(state.candidates[0]?.hasWaves).toBe(true);
  });

  it('resets disabled camera post processing before any native query', () => {
    const { state, queryBody, sweepSphereAll } = select([body(1)], [hit(1)], {
      view: { postProcessEnabled: false },
    });
    expect(state).toMatchObject({
      intersection: 'none',
      immersionDepthM: -0.01,
      visualPpActive: false,
      audioUnderwater: false,
      candidates: [],
    });
    expect(sweepSphereAll).not.toHaveBeenCalled();
    expect(queryBody).not.toHaveBeenCalled();
  });

  it('preserves native order when coarse wave and priority keys are equal', () => {
    const { state } = select([body(1), body(2)], [hit(1, -1, 20), hit(2, -1, 1)]);
    expect(state.selectedBody).toBe('body:1');
  });

  it('filters non-Water, hidden, missing-PP and excluded bodies before selection', () => {
    const hidden = body(1, {
      renderOptions: { castShadow: true, receiveShadow: true, visible: false },
    });
    const withoutPp = body(2);
    delete (withoutPp.asset as { underwaterPostProcessMaterialGuid?: string })
      .underwaterPostProcessMaterialGuid;
    const { state, queryBody } = select(
      [hidden, withoutPp, body(3), body(4)],
      [hit(99), hit(1), hit(2), hit(3), hit(3, -1, 30), hit(4)],
      {
        samples: { 'body:3': { ...sample('body:3'), excluded: true } },
      },
    );
    expect(state.selectedBody).toBe('body:4');
    expect(state.candidates.map((entry) => entry.outcome)).toEqual([
      'not-rendered',
      'missing-post-process',
      'excluded',
      'selected',
    ]);
    expect(queryBody.mock.calls.map(([guid]) => guid)).toEqual(['body:3', 'body:4']);
  });

  it('keeps PP blend enablement separate from positive-immersion audio', () => {
    const { state } = select(
      [
        body(1, {
          underwaterSettings: {
            enabled: false,
            priority: 4,
            blendRadiusM: 3,
            blendWeight: 0,
            maxDepthM: 10,
          },
        }),
      ],
      [hit(1)],
    );
    expect(state).toMatchObject({
      selectedBody: 'body:1',
      immersionDepthM: 1,
      audioUnderwater: true,
      visualPpActive: false,
      postProcess: { priority: 4, blendRadiusM: 3 },
    });
  });

  it('reports native failures and retains their structured cause', () => {
    const cause = {
      code: 'sweep-unavailable' as const,
      expected: 'native sweep',
      hint: 'load physics',
      detail: { field: 'world' },
    };
    expect(
      selectWaterView({
        view,
        collisionFilterMask: WATER_DEFAULT_UNDERWATER_TRACE_FILTER_MASK,
        sceneGeneration: 8,
        bodies: [body(1)],
        physics: { sweepSphereAll: () => err(cause) },
        queryBody: (guid) => ok(sample(guid)),
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'water-view-sweep-failed', detail: { field: 'coarse', cause } },
    });
  });
});

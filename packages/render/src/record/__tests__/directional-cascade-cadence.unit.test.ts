import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { describe, expect, it } from 'vitest';
import { MeshChanges, ShadowMeshReads } from '../../device/mesh-changes';
import { worldRenderResources } from '../../publication/resource-scope';
import { MaterialFrame } from '../../scene/material-dispatch';
import { MeshFrame } from '../../scene/mesh-frame';
import type { PersistentShadowCasterProjection } from '../../scene/render-scene';
import { RenderScene } from '../../scene/render-scene';
import type { ViewLights } from '../../world/render-lights';
import {
  type DirectionalCascadeCadenceState,
  directionalCascadeDue,
  directionalShadowSourceChanged,
  prepareDirectionalCascadeCadence,
} from '../directional-cascade-cadence';
import { prepareDirectionalShadowCache } from '../directional-shadow-cache';
import type { RenderFrameState } from '../frame-snapshot';
import type { RenderSystemInternals } from '../render-context';

const matrices = () =>
  Array.from({ length: 4 }, (_, index) => {
    const matrix = new Float32Array(16);
    matrix[0] = index + 1;
    return matrix;
  });
const lights = (enabled = true, cascadeCount = 3) => ({
  cascades: { lightViewProj: matrices(), cascadeCount },
  directionalCsmConfig: { staggerCascades: enabled },
});

describe('authored CPU directional cascade cadence', () => {
  it('refreshes opted source replacement before a whole-map World cache hit', () => {
    const world = new World();
    const lease = createRenderReadLease(world);
    // The existing terrain shadow-cache owner fixture uses the same narrow
    // record-stage inputs; no renderer/device is constructed by this test.
    const internals = {
      assets: { catalogEpoch: 1 },
      gpuStore: { meshResidencyEpoch: 1 },
    } as unknown as RenderSystemInternals;
    const state = {
      compiledFrameGraph: { topologyKey: 'same-light-graph' },
      installedPipelineHandle: 9,
      directionalShadowCache: null,
    } as unknown as RenderFrameState;
    const config = {
      cascadeCount: 3,
      splitLambda: 0.5,
      cascadeBlend: 0.1,
      mapSize: 1024,
      shadowDistance: 90,
      shadowFilter: 0,
      shadowAngularRadius: 0,
      maxPenumbraTexels: 0,
    };
    let input = {
      cascades: {
        ...lights(false).cascades,
        directionalShadowQuality: { kind: 'pcf', kernel: 3 },
      },
      directionalCsmConfig: config,
    } as unknown as ViewLights;
    const owner = {};
    const changes = new MeshChanges();
    const reads = new ShadowMeshReads(changes);
    reads.add(changes.create());
    const casters = (dispatchRevision: number) =>
      ({
        content: {
          owner,
          sceneRevision: 1,
          dispatchRevision,
          materials: new MaterialFrame(undefined),
          meshes: new MeshFrame(),
          subsurface: { source: 0, authorVisible: 0, admitted: 0 },
        },
        meshDraws: new RenderScene(),
        renderables: [],
        dispatch: [],
        worldBoundsOf: () => false,
      }) satisfies PersistentShadowCasterProjection;
    const decide = (dispatchRevision: number, proven = true) =>
      prepareDirectionalShadowCache(
        internals,
        state,
        [world].map(worldRenderResources),
        proven ? [lease] : undefined,
        input,
        1024,
        { reads, epoch: changes.epoch, change: 'quiet' },
        casters(dispatchRevision),
      );
    try {
      const first = decide(1);
      expect(first.miss).toBe('first-publication');
      state.directionalShadowCache = first.next;
      const accepted = state.directionalShadowCache;
      // The default continues accepting the unchanged World proof, exactly as
      // before this opt-in. Cadence must not inherit that hit for a new source.
      expect(decide(2).miss).toBeUndefined();
      input = { ...input, directionalCsmConfig: { ...config, staggerCascades: true } };
      expect(decide(1).miss).toBeUndefined();
      expect(decide(2).miss).toBe('source-changed');
      expect(state.directionalShadowCache).toBe(accepted);
      expect(decide(2, false)).toEqual({ miss: 'uncached', next: null });
    } finally {
      reads.release();
      changes.reset();
      lease.dispose();
    }
  });

  it('keeps default/absent/single cascade and unproven lease-less cache policy', () => {
    for (const input of [
      lights(false),
      { cascades: { lightViewProj: matrices(), cascadeCount: 3 } },
      lights(true, 1),
    ]) {
      expect(prepareDirectionalCascadeCadence(input, undefined, 'content-changed')).toEqual({
        cascadeMiss: undefined,
        next: null,
      });
    }
    expect(prepareDirectionalCascadeCadence(lights(), undefined, 'uncached')).toEqual({
      cascadeMiss: undefined,
      next: null,
    });
  });

  it('bounds moving-caster lag and schedules at most one far cascade', () => {
    let state: DirectionalCascadeCadenceState | undefined;
    const observed: number[][] = [];
    for (let frame = 0; frame < 9; frame += 1) {
      const decision = prepareDirectionalCascadeCadence(lights(), state, 'content-changed');
      observed.push(
        (decision.cascadeMiss ?? []).flatMap((reason, cascade) =>
          reason === undefined ? [] : [cascade],
        ),
      );
      state = decision.next ?? undefined;
    }
    expect(observed).toEqual([[0, 1, 2], [0, 1], [0, 2], [0, 1], [0], [0, 1], [0, 2], [0, 1], [0]]);
    for (let frame = 0; frame < 64; frame += 1) {
      expect(directionalCascadeDue(0, frame)).toBe(true);
      expect(
        [1, 2, 3].filter((cascade) => directionalCascadeDue(cascade, frame)).length,
      ).toBeLessThanOrEqual(1);
    }
  });

  it('keeps exact far projection and immediately refreshes camera/light projection changes', () => {
    const input = lights();
    const first = prepareDirectionalCascadeCadence(input, undefined, 'first-publication');
    if (first.next === null) throw new Error('expected submitted projection candidate');
    const movedMatrix = input.cascades.lightViewProj[2];
    if (movedMatrix === undefined) throw new Error('expected cascade projection');
    movedMatrix[12] = 1;
    const moved = prepareDirectionalCascadeCadence(input, first.next, 'view-changed');
    expect(moved.cascadeMiss).toEqual(['view-changed', 'view-changed', 'view-changed']);
    expect(first.next.lightViewProj[2]?.[12]).toBe(0);
  });

  it('flushes settled stale layers and never advances a rejected submission candidate', () => {
    const first = prepareDirectionalCascadeCadence(lights(), undefined, 'first-publication').next;
    if (first === null) throw new Error('expected candidate');
    const rejected = prepareDirectionalCascadeCadence(lights(), first, 'content-changed');
    expect(first.frame).toBe(0);
    const retry = prepareDirectionalCascadeCadence(lights(), first, 'content-changed');
    expect(retry).toEqual(rejected);
    if (retry.next === null) throw new Error('expected candidate');
    const settled = prepareDirectionalCascadeCadence(lights(), retry.next, undefined);
    expect(settled.cascadeMiss).toEqual([undefined, undefined, 'content-changed']);
    const clean = prepareDirectionalCascadeCadence(lights(), settled.next ?? undefined, undefined);
    expect(clean.cascadeMiss).toEqual([undefined, undefined, undefined]);
  });

  it('cannot retain a layer across resource/configuration/feature/aborted-source invalidation', () => {
    const first = prepareDirectionalCascadeCadence(lights(), undefined, 'first-publication').next;
    for (const reason of [
      'configuration-changed',
      'source-changed',
      'feature-draws',
      'submit-aborted',
      'graph-compiled',
      'artifact-changed',
      'view-clipping-changed',
    ] as const) {
      expect(
        prepareDirectionalCascadeCadence(lights(), first ?? undefined, reason).cascadeMiss,
      ).toEqual([reason, reason, reason]);
    }
  });

  it('requires fresh layers for asset/residency/World identity, membership or dispatch replacement', () => {
    const world = new World();
    const lease = createRenderReadLease(world);
    try {
      const worldStateToken = {
        worldIdentity: lease.worldIdentity,
        version: lease.captureVersion(),
      };
      const source = {
        worlds: [worldRenderResources(world)],
        shadowMaterials: undefined,
        worldStateTokens: [worldStateToken],
        assetCatalogEpoch: 1,
        meshReads: {} as ShadowMeshReads,
        lodSelection: undefined,
        casterContent: {
          owner: {},
          sceneRevision: 1,
          dispatchRevision: 1,
          materials: new MaterialFrame(undefined),
          meshes: new MeshFrame(),
          subsurface: { source: 0, authorVisible: 0, admitted: 0 },
        },
      };
      expect(
        directionalShadowSourceChanged(source, {
          ...source,
          casterContent: { ...source.casterContent, sceneRevision: 2 },
        }),
      ).toBe(false);
      const unrelatedCatalog = { ...source, assetCatalogEpoch: 2 };
      expect(directionalShadowSourceChanged(source, unrelatedCatalog)).toBe(false);
      for (const changed of [
        { ...source, meshReads: {} as ShadowMeshReads },
        { ...source, lodSelection: {} },
        { ...source, worlds: [] },
        { ...source, casterContent: { ...source.casterContent, owner: {} } },
        { ...source, casterContent: { ...source.casterContent, dispatchRevision: 2 } },
        { ...source, worldStateTokens: [{ ...worldStateToken, worldIdentity: 'replacement' }] },
        {
          ...source,
          worldStateTokens: [
            {
              ...worldStateToken,
              version: {
                ...worldStateToken.version,
                structureEpoch: worldStateToken.version.structureEpoch + 1,
              },
            },
          ],
        },
      ])
        expect(directionalShadowSourceChanged(source, changed)).toBe(true);
    } finally {
      lease.dispose();
    }
  });
});

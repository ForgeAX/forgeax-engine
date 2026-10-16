import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import type { TerrainAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { prepareDirectionalShadowCache } from '../../record/directional-shadow-cache';
import type { DirectionalShadowCache, RenderFrameState } from '../../record/frame-snapshot';
import type { RenderSystemInternals } from '../../record/render-context';
import type { CameraSnapshot } from '../../render-contract';
import type {
  ExtractedFrame,
  ExtractedLights,
  RenderableSnapshot,
} from '../../render-system-extract';
import type { PersistentShadowCasterProjection } from '../../scene/render-scene';
import { projectTerrainView } from '../../terrain/view';

it('invalidates real cache decisions for only fractional or neighbor geometry while old World/caster/light proofs remain true', () => {
  const world = new World(),
    lease = createRenderReadLease(world);
  const root = {
    kind: 'terrain',
    materialEncoding: { kind: 'weights' },
    columns: 8,
    rows: 8,
    subsectionVertices: 8,
    spacing: 1,
    heightRange: [0, 1],
    sections: [{ x: 0, z: 0, minHeight: 0, maxHeight: 0 }],
  } as unknown as TerrainAsset;
  const source = {
    worldId: 0,
    entityKey: 42,
    transform: { world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) },
    materials: [{ materialHandle: 1 }],
    terrain: {
      asset: root,
      handle: 3,
      grids: [10, 11, 12],
      heightTextures: [4],
      weightTextures: [5],
      passes: [[]],
      forcedLod: -1,
      lod0Diameter: 1,
      layer: 0,
    },
  } as unknown as RenderableSnapshot;
  const project = (lod: number) => {
    const distance = (7 * 2 ** lod) / Math.tan(Math.PI / 6);
    const camera = {
      projection: 'perspective',
      position: new Float32Array([3.5, 0, 3.5 + distance]),
      near: 0.1,
      fov: Math.PI / 3,
    } as CameraSnapshot;
    return projectTerrainView(
      { renderables: [source], dispatch: [], cameras: [camera] } as unknown as ExtractedFrame,
      new Map(),
    ).renderables;
  };
  const owner = {},
    a = project(0.25),
    b = project(0.75);
  const casters = (sections: readonly RenderableSnapshot[]) =>
    ({
      content: { owner, sceneRevision: 1, dispatchRevision: 1, terrainSections: sections },
      renderables: sections,
      dispatch: [],
      worldBoundsOf: () => undefined,
    }) satisfies PersistentShadowCasterProjection;
  const internals = {
    assets: { catalogEpoch: 1 },
    gpuStore: { meshResidencyEpoch: 1 },
  } as unknown as RenderSystemInternals;
  const state = {
    compiledFrameGraph: { topologyKey: 'same-light-graph' },
    installedPipelineHandle: 9,
    directionalShadowCache: null,
  } as unknown as RenderFrameState;
  const lights = {
    cascadeCount: 1,
    lightViewProj: [new Float32Array(16)],
    directionalShadowQuality: { kind: 'pcf', kernel: 3 },
  } as unknown as ExtractedLights;
  const shadowMesh = { contentEpoch: 1 };
  const decide = (sections: readonly RenderableSnapshot[]) =>
    prepareDirectionalShadowCache(
      internals,
      state,
      [world],
      [lease],
      lights,
      1024,
      [{ mesh: shadowMesh }] as never,
      casters(sections),
    );
  const version = lease.captureVersion();
  try {
    const first = decide(a);
    expect(first.miss).toBe('first-publication');
    state.directionalShadowCache = first.next;
    const accepted = state.directionalShadowCache;
    expect(decide(a).miss).toBeUndefined();
    // Same root, same integer grid, same immutable caster revisions and fixed lightVP.
    expect(a[0]?.assetHandle).toBe(b[0]?.assetHandle);
    expect(a[0]?.terrainSection?.lod).not.toBe(b[0]?.terrainSection?.lod);
    expect(lease.captureVersion()).toEqual(version);
    const changed = decide(b);
    expect(changed.miss).toBe('content-changed');
    // Preparing/rejecting the candidate cannot rewrite the retained cache.
    expect(state.directionalShadowCache).toBe(accepted);
    expect(decide(b).miss).toBe('content-changed');
    state.directionalShadowCache = changed.next;
    expect(decide(b).miss).toBeUndefined();
    const next = b.map((row) => {
      if (row.terrainSection === undefined) throw new Error('expected terrain section');
      return {
        ...row,
        terrainSection: { ...row.terrainSection, neighbors: [1, 0.75, 0.75, 0.75] },
      };
    });
    expect(decide(next).miss).toBe('content-changed');
    expect(lease.captureVersion()).toEqual(version);
    expect(
      (state.directionalShadowCache as DirectionalShadowCache).meshContent[0]?.contentEpoch,
    ).toBe(1);
  } finally {
    lease.dispose();
  }
});

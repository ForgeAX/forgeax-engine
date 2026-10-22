import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { expect, it } from 'vitest';
import { MeshChanges, ShadowMeshReads } from '../../device/mesh-changes';
import { worldRenderResources } from '../../publication/resource-scope';
import { prepareDirectionalShadowCache } from '../../record/directional-shadow-cache';
import type { DirectionalShadowCache, RenderFrameState } from '../../record/frame-snapshot';
import type { RenderSystemInternals } from '../../record/render-context';
import type { CameraSnapshot } from '../../render-contract';
import type {
  ExtractedFrame,
  ExtractedLights,
  RenderableSnapshot,
} from '../../render-system-extract';
import type { FrameList } from '../../scene/frame-list';
import { MaterialFrame } from '../../scene/material-dispatch';
import { MeshFrame } from '../../scene/mesh-frame';
import type { PersistentShadowCasterProjection } from '../../scene/render-scene';
import { projectTerrainView } from '../../terrain/view';
import { runtimeTerrainFixture, terrainViewPreparation } from './runtime-fixture';

it('invalidates real cache decisions for only fractional or neighbor geometry while old World/caster/light proofs remain true', () => {
  const fixture = runtimeTerrainFixture({
    columns: 8,
    rows: 8,
    subsectionVertices: 8,
    spacing: 1,
    heights: new Float32Array(64),
  });
  const { world, source } = fixture,
    lease = createRenderReadLease(world);
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
      source.materials.reduce(
        (frame, material) => frame.with(material),
        new MaterialFrame(undefined),
      ),
      [world].map(worldRenderResources),
      ...terrainViewPreparation(fixture.assets),
    ).frame.renderables;
  };
  const owner = {},
    a = project(0.25),
    b = project(0.75);
  const casters = (sections: FrameList<RenderableSnapshot>) =>
    ({
      meshDraws: { meshDrawSlot: () => 0, beginMeshDrawFrame: () => {} },
      prepareDrawDispatch: () => [],
      content: {
        meshes: new MeshFrame(),
        subsurface: { source: 0, authorVisible: 0, admitted: 0 },
        owner,
        sceneRevision: 1,
        dispatchRevision: 1,
        viewDraws: sections,
        materials: new MaterialFrame(undefined),
      },
      renderables: sections,
      dispatch: [],
      worldBoundsOf: () => false,
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
  const changes = new MeshChanges();
  const reads = new ShadowMeshReads(changes);
  reads.add(changes.create());
  const decide = (sections: FrameList<RenderableSnapshot>) =>
    prepareDirectionalShadowCache(
      internals,
      state,
      [world].map(worldRenderResources),
      [lease],
      lights,
      1024,
      { reads, epoch: changes.epoch, change: 'quiet' },
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
    expect(a.at(0)?.assetHandle).toBe(b.at(0)?.assetHandle);
    expect(a.at(0)?.terrainSection?.lod).not.toBe(b.at(0)?.terrainSection?.lod);
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
    expect((state.directionalShadowCache as DirectionalShadowCache).meshEpoch).toBe(1);
  } finally {
    reads.release();
    changes.reset();
    lease.dispose();
  }
});

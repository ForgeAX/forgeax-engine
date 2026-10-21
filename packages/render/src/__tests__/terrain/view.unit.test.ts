import { terrainHeightBounds, terrainSurfaceVertex } from '@forgeax/engine-terrain';
import { cookTerrain } from '@forgeax/engine-terrain/cook';
import { expect, it } from 'vitest';
import { worldRenderResources } from '../../publication/resource-scope';
import type { CameraSnapshot } from '../../render-contract.js';
import type { ExtractedFrame, RenderableSnapshot } from '../../render-system-extract.js';
import { MaterialFrame } from '../../scene/material-dispatch';
import { projectTerrainView } from '../../terrain/view.js';
import { runtimeTerrainFixture, terrainViewPreparation } from './runtime-fixture';

it('encloses exact section heights independently of a distant height maximum', () => {
  for (const n of [2, 8]) {
    const columns = (n - 1) * 2 + 1;
    const heights = new Float32Array(columns * n).fill(0.1);
    heights[columns - 1] = 10000;
    heights[columns * n - 1] = 0;
    const cooked = cookTerrain({
      columns,
      rows: n,
      spacing: 1,
      subsectionVertices: n,
      heights,
      weights: new Float32Array(columns * n).fill(1),
      layers: [{ material: 'material', blend: 'weight' }],
    }).unwrap();
    const section = defined(cooked.sections[0]);
    const bounds = new Float32Array(terrainHeightBounds(section.minHeight, section.maxHeight));
    const fixture = runtimeTerrainFixture({
      columns,
      rows: n,
      spacing: 1,
      subsectionVertices: n,
      heights,
    });
    const source = {
      ...fixture.source,
      terrain: { ...defined(fixture.source.terrain), forcedLod: 0 },
    };
    const projected = projectTerrainView(
      {
        renderables: [source],
        dispatch: [],
        cameras: [{}],
      } as unknown as ExtractedFrame,
      new Map(),
      source.materials.reduce(
        (frame, material) => frame.with(material),
        new MaterialFrame(undefined),
      ),
      [fixture.world].map(worldRenderResources),
      ...terrainViewPreparation(fixture.assets),
    ).frame;
    const aabb = defined(defined(projected.renderables.at(0)).localAabb);
    expect(aabb[1]).toBe(bounds[0]);
    expect(aabb[4]).toBe(bounds[1]);
    const maxLod = Math.log2(n) - 1;
    for (const lod of [0, Math.min(0.5, maxLod), maxLod]) {
      const surface = {
        vertices: n,
        width: n - 1,
        lod,
        neighbors: [maxLod, lod, maxLod, lod],
        textureWidth: cooked.height.shape.extent.width,
        textureHeight: cooked.height.shape.extent.height,
        sectionIndex: 0,
        heights: cooked.height.data,
      };
      for (let z = 0; z < n / 2 ** Math.floor(lod); z++)
        for (let x = 0; x < n / 2 ** Math.floor(lod); x++) {
          const h = terrainSurfaceVertex(surface, x, z)[1];
          expect(h).toBe(section.maxHeight);
          expect(h).toBeGreaterThanOrEqual(defined(bounds[0]));
          expect(h).toBeLessThanOrEqual(defined(bounds[1]));
        }
    }
  }
});

it('derives each view and boundary LOD from one terrain entity without adopting unsubmitted candidates', () => {
  const fixture = runtimeTerrainFixture({
    columns: 15,
    rows: 8,
    subsectionVertices: 8,
    spacing: 1,
    heights: new Float32Array(120),
  });
  const source = fixture.source;
  const camera = (z: number) =>
    ({
      position: new Float32Array([3.5, 2, z]),
      near: 0.1,
      fov: Math.PI / 3,
      projection: 'perspective',
    }) as CameraSnapshot;
  const frame = (z: number) =>
    ({ renderables: [source], dispatch: [], cameras: [camera(z)] }) as unknown as ExtractedFrame;
  const accepted = new Map<string, RenderableSnapshot>();
  const materials = source.materials.reduce(
    (frame, material) => frame.with(material),
    new MaterialFrame(undefined),
  );
  const projected = projectTerrainView(
    frame(12),
    accepted,
    materials,
    [fixture.world].map(worldRenderResources),
    ...terrainViewPreparation(fixture.assets),
  );
  const near = projected.frame,
    far = projectTerrainView(
      frame(100),
      accepted,
      materials,
      [fixture.world].map(worldRenderResources),
      ...terrainViewPreparation(fixture.assets),
    ).frame;
  for (const section of near.renderables) {
    const acceptedMaterial = defined(projected.materials.get(section.material));
    expect(materials.get(section.material)).toBeUndefined();
    expect(acceptedMaterial.snapshot.paramSnapshot?.terrainNeighbors).toEqual(
      section.terrainSection?.neighbors,
    );
    const terrainLod = acceptedMaterial.snapshot.paramSnapshot?.terrainLod;
    expect(Array.isArray(terrainLod) ? terrainLod[1] : undefined).toBe(section.terrainSection?.lod);
    expect(acceptedMaterial.snapshot.paramSnapshot?.terrainShadowFamily).toBe(1);
  }
  expect(near.renderables.map((draw) => draw.entityKey)).toEqual([fixture.entity, fixture.entity]);
  expect(defined(defined(far.renderables.at(0)).terrainSection).lod).toBeGreaterThan(
    defined(defined(near.renderables.at(0)).terrainSection).lod,
  );
  expect(defined(defined(near.renderables.at(0)).terrainSection).neighbors[1]).toBe(
    defined(defined(near.renderables.at(1)).terrainSection).lod,
  );
  expect(defined(defined(near.renderables.at(1)).terrainSection).neighbors[0]).toBe(
    defined(defined(near.renderables.at(0)).terrainSection).lod,
  );
  expect(defined(near.renderables.at(0)).temporal?.reactive).toBe(true);
  expect(accepted.size).toBe(0);
});

function defined<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('expected defined test value');
  return value;
}

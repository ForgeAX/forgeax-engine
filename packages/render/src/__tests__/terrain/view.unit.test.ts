import { terrainHeightBounds, terrainLod, terrainSurfaceVertex } from '@forgeax/engine-terrain';
import { cookTerrain } from '@forgeax/engine-terrain/cook';
import { expect, it } from 'vitest';
import { captureMaterialSnapshot, MaterialResource } from '../../material-resource';
import { worldRenderResources } from '../../publication/resource-scope';
import type { CameraSnapshot } from '../../render-contract.js';
import {
  appendMaterialDispatchEntries,
  type DispatchEntry,
  type ExtractedFrame,
  type RenderableSnapshot,
} from '../../render-system-extract.js';
import { MaterialFrame, materialPasses } from '../../scene/material-dispatch';
import type { StandardSceneSurfaceAdmission } from '../../temporal/scene-data';
import {
  createStandardSceneSurfaceAdmission,
  ProducedStandardSceneDataAdmissionInput,
  standardSceneDataContributorForDispatch,
  standardSceneSurfaceContributorBaseline,
} from '../../temporal/standard-scene-data-admission';
import type { TerrainLayers } from '../../terrain/layers';
import { terrainDrawSection } from '../../terrain/source';
import { captureSubmittedTerrain } from '../../terrain/submitted';
import { projectTerrainView, terrainSectionKey } from '../../terrain/view.js';
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
      worldRenderResources(fixture.world),
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
    worldRenderResources(fixture.world),
    ...terrainViewPreparation(fixture.assets),
  );
  const near = projected.frame,
    far = projectTerrainView(
      frame(100),
      accepted,
      materials,
      worldRenderResources(fixture.world),
      ...terrainViewPreparation(fixture.assets),
    ).frame;
  const maxLod = defined(near.renderables.at(0)?.terrainSection).source.grids.length - 1;
  const spans = [15, 63];
  for (const span of spans) {
    const ortho = {
      ...camera(100),
      projection: 'orthographic' as const,
      orthoTop: span / 2,
      orthoBottom: -span / 2,
    };
    const result = projectTerrainView(
      { ...frame(100), cameras: [ortho] },
      accepted,
      materials,
      worldRenderResources(fixture.world),
      ...terrainViewPreparation(fixture.assets),
    );
    const expected = Math.fround(
      terrainLod(7 / span, defined(source.terrain).lod0Diameter, maxLod),
    );
    for (const row of result.frame.renderables) {
      expect(row.terrainSection?.lod).toBe(expected);
      expect(row.terrainSection?.neighbors).toEqual([expected, expected, expected, expected]);
    }
  }
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

it('reuses only the accepted owned Terrain material for matching parameters and layer frames', () => {
  const fixture = runtimeTerrainFixture({
    columns: 15,
    rows: 8,
    subsectionVertices: 8,
    spacing: 1,
    heights: new Float32Array(120),
  });
  const source = {
    ...fixture.source,
    terrain: { ...defined(fixture.source.terrain), forcedLod: -1 },
  };
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
  const sourceMaterials = source.materials.reduce(
    (current, material) => current.with(material),
    new MaterialFrame(undefined),
  );
  const [sources, resolve] = terrainViewPreparation(fixture.assets);
  const resources = new Map<number, MaterialResource>();
  let resolveCalls = 0;
  const resolveOwned = (world: ReturnType<typeof worldRenderResources>, handle: number) => {
    resolveCalls += 1;
    let material = resources.get(handle);
    if (material === undefined) {
      material = MaterialResource.from(captureMaterialSnapshot(resolve(world, handle).snapshot));
      resources.set(handle, material);
    }
    return material;
  };
  const layerBindings = new WeakMap<object, object>();
  let layerFrame: object = {};
  const layers = {
    capture: () => layerFrame,
    bind: (snapshot: object, frame: object) => layerBindings.set(snapshot, frame),
    isBound: (snapshot: object, frame: object) => layerBindings.get(snapshot) === frame,
  } as unknown as TerrainLayers;
  const sourceScope = worldRenderResources(fixture.world);
  const project = (z: number) =>
    projectTerrainView(
      frame(z),
      accepted,
      sourceMaterials,
      sourceScope,
      sources,
      resolveOwned,
      layers,
    );
  const accept = (projected: ExtractedFrame) => {
    for (const row of projected.renderables) {
      const section = row.terrainSection;
      if (section !== undefined) accepted.set(terrainSectionKey(source, section.index), row);
    }
  };

  const nearProjection = project(12);
  const near = nearProjection.frame;
  accept(near);
  const nearBySection = new Map(
    near.renderables.flatMap((row) =>
      row.terrainSection === undefined ? [] : [[row.terrainSection.index, row] as const],
    ),
  );
  expect(nearBySection.size).toBe(2);
  const material = defined(nearBySection.get(0)).material;
  const acceptedSection = defined(nearBySection.get(0)?.terrainSection);
  const materialSnapshot = material.snapshot;
  const acceptedMaterial = nearProjection.materials.get(material);
  expect(material.ownsValues(materialSnapshot)).toBe(true);
  expect(Object.isFrozen(materialSnapshot)).toBe(true);
  expect(Object.isFrozen(materialSnapshot.paramSnapshot)).toBe(true);
  expect(Object.isFrozen(materialSnapshot.paramSnapshot?.terrainLod)).toBe(true);
  expect(layerBindings.get(materialSnapshot)).toBe(layerFrame);

  const callsBeforeStableHit = resolveCalls;
  const same = project(12);
  expect(resolveCalls - callsBeforeStableHit).toBe(2);
  for (const row of same.frame.renderables) {
    expect(row.material).toBe(nearBySection.get(defined(row.terrainSection).index)?.material);
    expect(row.terrainSection).toBe(
      nearBySection.get(defined(row.terrainSection).index)?.terrainSection,
    );
  }
  expect(Object.isFrozen(acceptedSection)).toBe(true);
  expect(Object.isFrozen(acceptedSection.neighbors)).toBe(true);
  expect(same.materials.get(material)).toBe(acceptedMaterial);

  // An unsubmitted far-camera candidate changes LOD but cannot replace the
  // per-view owner. Returning to the accepted camera reuses its exact product.
  const far = project(100).frame;
  const farSection = defined(far.renderables.find((row) => row.terrainSection?.index === 0));
  expect(farSection.terrainSection?.lod).not.toBe(nearBySection.get(0)?.terrainSection?.lod);
  expect(farSection.material).not.toBe(material);
  const nearPasses = materialPasses(materialSnapshot);
  expect(materialPasses(farSection.material.snapshot)).toBe(nearPasses);
  expect(materialPasses(defined(resources.values().next().value).snapshot)).toBe(nearPasses);
  const distinctBindings = new MaterialFrame(undefined).with(material).with(farSection.material);
  expect(distinctBindings.get(material)?.passes[0]).not.toBe(
    distinctBindings.get(farSection.material)?.passes[0],
  );
  expect(near.dispatch.length).toBe(6);
  for (let i = 0; i < near.dispatch.length; i++) {
    const expected = defined(near.dispatch.at(i));
    expect(far.dispatch.at(i)).toBe(expected);
    expect(Object.isFrozen(expected)).toBe(true);
  }
  const returned = project(12).frame;
  expect(returned.renderables.find((row) => row.terrainSection?.index === 0)?.material).toBe(
    material,
  );

  const baseMaterial = defined(resources.values().next().value);
  baseMaterial.adopt(captureMaterialSnapshot({ ...baseMaterial.snapshot, roughness: 0.75 }));
  const changedSource = project(12);
  const changedSourceMaterial = defined(
    changedSource.frame.renderables.find((row) => row.terrainSection?.index === 0),
  ).material;
  expect(changedSourceMaterial).not.toBe(material);
  // Replacing one live material leaves its neighbor's submitted section intact.
  expect(changedSource.frame.renderables.at(1)?.terrainSection).toBe(
    nearBySection.get(1)?.terrainSection,
  );
  expect(material.snapshot).toBe(materialSnapshot);
  accept(changedSource.frame);
  expect(
    project(12).frame.renderables.find((row) => row.terrainSection?.index === 0)?.material,
  ).toBe(changedSourceMaterial);

  const previousLayerFrame = layerFrame;
  layerFrame = {};
  const changedLayers = project(12).frame;
  const changedLayerMaterial = defined(
    changedLayers.renderables.find((row) => row.terrainSection?.index === 0),
  ).material;
  expect(changedLayerMaterial).not.toBe(changedSourceMaterial);
  expect(layerBindings.get(changedSourceMaterial.snapshot)).toBe(previousLayerFrame);
  expect(layerBindings.get(changedLayerMaterial.snapshot)).toBe(layerFrame);
  expect(material.snapshot).toBe(materialSnapshot);
  expect(material.snapshot.paramSnapshot?.terrainLod).toEqual([0, 0, 2, 1]);
});

it('relocates accepted Terrain dispatch and preserves submitted poses through in-place edits', () => {
  const fixture = runtimeTerrainFixture({
    columns: 15,
    rows: 8,
    subsectionVertices: 8,
    spacing: 1,
    heights: new Float32Array(120),
  });
  const matrix = new Float32Array(fixture.source.transform.world);
  let terrainSource: RenderableSnapshot = {
    ...fixture.source,
    transform: { ...fixture.source.transform, world: matrix },
  };
  const other = { ...fixture.source, terrain: undefined };
  const input = (withOther: boolean): ExtractedFrame =>
    ({
      renderables: withOther ? [other, terrainSource] : [terrainSource],
      dispatch: [
        {
          entityIndex: other.entityKey,
          materialHandle: 0,
          renderableIndex: 0,
          passIndex: 0,
          queue: 2000,
          layer: 0,
          tags: {},
          renderState: undefined,
          defines: undefined,
          vertexEntry: undefined,
          fragmentEntry: undefined,
          materialShaderId: undefined,
        } as DispatchEntry,
      ],
      cameras: [{ position: [3.5, 2, 12], near: 0.1, fov: Math.PI / 3, projection: 'perspective' }],
    }) as unknown as ExtractedFrame;
  const accepted = new Map<string, RenderableSnapshot>();
  const materials = fixture.source.materials.reduce(
    (current, material) => current.with(material),
    new MaterialFrame(undefined),
  );
  const [sources, resolve] = terrainViewPreparation(fixture.assets);
  const ownedMaterials = new Map<number, MaterialResource>();
  const resolveOwned = (world: ReturnType<typeof worldRenderResources>, handle: number) => {
    let material = ownedMaterials.get(handle);
    if (material === undefined) {
      material = MaterialResource.from(captureMaterialSnapshot(resolve(world, handle).snapshot));
      ownedMaterials.set(handle, material);
    }
    return material;
  };
  const project = (withOther: boolean) =>
    projectTerrainView(
      input(withOther),
      accepted,
      materials,
      worldRenderResources(fixture.world),
      sources,
      resolveOwned,
    );
  const accept = (frame: ExtractedFrame) => {
    for (const row of frame.renderables)
      if (row.terrainSection !== undefined)
        accepted.set(terrainSectionKey(terrainSource, row.terrainSection.index), row);
  };
  const first = project(false).frame;
  accept(first);
  const firstReceipt = captureSubmittedTerrain(
    first.renderables,
    worldRenderResources(fixture.world),
  );
  const firstSection = defined(first.renderables.at(0)?.terrainSection);
  const geometry = terrainDrawSection(firstSection.source, firstSection.index);
  const firstBounds = defined(first.renderables.at(0)?.localAabb);
  expect(Array.from(firstBounds)).toEqual(geometry.localAabb);
  firstBounds[4] = 1000;
  const withOther = project(true).frame;
  expect(withOther.renderables.at(1)?.localAabb?.[4]).toBe(geometry.localAabb[4]);
  const terrainRows = withOther.renderables.flatMap((row, index) =>
    row.terrainSection === undefined ? [] : [index],
  );
  expect(terrainRows).toEqual([1, 2]);
  expect(withOther.dispatch.map((entry) => entry.renderableIndex)).toEqual([0, 1, 1, 1, 2, 2, 2]);
  expect(first.dispatch.map((entry) => entry.renderableIndex)).toEqual([0, 0, 0, 1, 1, 1]);
  accept(withOther);
  const stillShifted = project(true).frame;
  for (let i = 1; i < withOther.dispatch.length; i++)
    expect(stillShifted.dispatch.at(i)).toBe(defined(withOther.dispatch.at(i)));

  matrix[12] = 3;
  const moved = project(false).frame;
  const movedReceipt = captureSubmittedTerrain(
    moved.renderables,
    worldRenderResources(fixture.world),
  );
  expect(firstReceipt[0]?.translation[0]).toBe(0);
  expect(movedReceipt[0]?.translation[0]).toBe(3);
  accept(moved);
  const visible = terrainSource;
  terrainSource = { ...visible, authorVisible: false };
  const hidden = project(false).frame;
  expect(hidden.dispatch).toHaveLength(0);
  accept(hidden);
  terrainSource = {
    ...visible,
    shadowCaster: false,
    terrain: { ...defined(visible.terrain), layer: 9 },
  };
  const lit = project(false).frame;
  expect(lit.dispatch).toHaveLength(4);
  expect(
    lit.dispatch.every((entry) => entry.layer === 9 && entry.tags.LightMode !== 'ShadowCaster'),
  ).toBe(true);
  expect(
    lit.dispatch.filter((entry) => entry.renderableIndex === 0).map((entry) => entry.passIndex),
  ).toEqual([0, 1]);
  accept(lit);
  terrainSource = visible;
  const casting = project(false).frame;
  expect(casting.dispatch.filter((entry) => entry.tags.LightMode === 'ShadowCaster')).toHaveLength(
    2,
  );
  expect(casting.dispatch.every((entry) => entry.layer === defined(visible.terrain).layer)).toBe(
    true,
  );
});

it('keeps borrowed Terrain material parameters live instead of reusing accepted products', () => {
  const fixture = runtimeTerrainFixture({
    columns: 15,
    rows: 8,
    subsectionVertices: 8,
    spacing: 1,
    heights: new Float32Array(120),
  });
  const source = {
    ...fixture.source,
    terrain: { ...defined(fixture.source.terrain), forcedLod: 0 },
  };
  const frame = {
    renderables: [source],
    dispatch: [],
    cameras: [{}],
  } as unknown as ExtractedFrame;
  const accepted = new Map<string, RenderableSnapshot>();
  const sourceMaterials = source.materials.reduce(
    (current, material) => current.with(material),
    new MaterialFrame(undefined),
  );
  const [sources, resolve] = terrainViewPreparation(fixture.assets);
  const world = worldRenderResources(fixture.world);
  const sectionMaterial = terrainDrawSection(
    sources.resolve(world, defined(source.terrain).handle),
    0,
  ).data.material;
  const ownedMaterials = new Map<number, MaterialResource>();
  const borrowedMaterials = new Map<number, MaterialResource>();
  const borrowedParameters = { authoredScalar: 0.25 };
  const ownedFor = (handle: number) => {
    let material = ownedMaterials.get(handle);
    if (material === undefined) {
      material = MaterialResource.from(captureMaterialSnapshot(resolve(world, handle).snapshot));
      ownedMaterials.set(handle, material);
    }
    return material;
  };
  const borrowedFor = (handle: number) => {
    let material = borrowedMaterials.get(handle);
    if (material === undefined) {
      material = new MaterialResource({
        ...ownedFor(handle).snapshot,
        paramSnapshot: borrowedParameters,
      });
      borrowedMaterials.set(handle, material);
    }
    return material;
  };
  const firstBorrowed = borrowedFor(Number(sectionMaterial));
  expect(firstBorrowed.ownsValues(firstBorrowed.snapshot)).toBe(false);
  let resolveCalls = 0;
  let useBorrowed = false;
  let borrowedSection: number | undefined;
  const project = () =>
    projectTerrainView(frame, accepted, sourceMaterials, world, sources, (_world, handle) => {
      resolveCalls += 1;
      return useBorrowed || handle === borrowedSection ? borrowedFor(handle) : ownedFor(handle);
    }).frame;
  const accept = (projected: ExtractedFrame) => {
    accepted.clear();
    for (const row of projected.renderables)
      if (row.terrainSection !== undefined)
        accepted.set(terrainSectionKey(source, row.terrainSection.index), row);
  };

  const first = project();
  accept(first);
  expect(accepted.size).toBe(2);
  expect(defined(accepted.values().next().value?.terrainSection).materialReuse).toBeDefined();
  const firstRow = defined(first.renderables.at(0));
  const firstMaterial = firstRow.material;
  borrowedSection = Number(
    terrainDrawSection(sources.resolve(world, defined(source.terrain).handle), 1).data.material,
  );
  const mixed = project();
  expect(mixed.renderables.at(0)?.terrainSection).toBe(firstRow.terrainSection);
  accept(mixed);
  const mixedAgain = project();
  for (let i = 0; i < mixed.dispatch.length; i++) {
    const entry = defined(mixed.dispatch.at(i));
    if (entry.renderableIndex === 0) expect(mixedAgain.dispatch.at(i)).toBe(entry);
    else expect(mixedAgain.dispatch.at(i)).not.toBe(entry);
  }
  useBorrowed = true;
  borrowedParameters.authoredScalar = 0.75;

  const callsBeforeBorrowedFrame = resolveCalls;
  const second = project();
  expect(resolveCalls - callsBeforeBorrowedFrame).toBe(2);
  expect(accepted.values().next().value?.material).toBe(firstMaterial);
  expect(second.renderables.every((row) => row.terrainSection?.materialReuse === undefined)).toBe(
    true,
  );
  const secondRow = defined(second.renderables.at(0));
  expect(secondRow.material).not.toBe(firstMaterial);
  expect(
    second.renderables.every((row) => row.material.snapshot.paramSnapshot?.authoredScalar === 0.75),
  ).toBe(true);
  accept(second);

  const callsBeforeNextBorrowedFrame = resolveCalls;
  const third = project();
  expect(resolveCalls - callsBeforeNextBorrowedFrame).toBe(2);
  expect(third.renderables.every((row) => row.terrainSection?.materialReuse === undefined)).toBe(
    true,
  );
});

it('does not reuse a fixed-value Terrain source without captured program authority', () => {
  const fixture = runtimeTerrainFixture({
    columns: 8,
    rows: 8,
    subsectionVertices: 8,
    spacing: 1,
    heights: new Float32Array(64),
  });
  const source = {
    ...fixture.source,
    terrain: { ...defined(fixture.source.terrain), forcedLod: 0 },
  };
  const frame = {
    renderables: [source],
    dispatch: [],
    cameras: [{}],
  } as unknown as ExtractedFrame;
  const accepted = new Map<string, RenderableSnapshot>();
  const sourceMaterials = source.materials.reduce(
    (current, material) => current.with(material),
    new MaterialFrame(undefined),
  );
  const [sources, resolve] = terrainViewPreparation(fixture.assets);
  const world = worldRenderResources(fixture.world);
  const sectionMaterial = terrainDrawSection(
    sources.resolve(world, defined(source.terrain).handle),
    0,
  ).data.material;
  const base = MaterialResource.from(
    captureMaterialSnapshot(resolve(world, Number(sectionMaterial)).snapshot),
  );
  const mutablePasses = base.snapshot.passes.map((pass) => ({
    ...pass,
    program: { ...pass.program },
  }));
  base.adoptProgramSnapshot({ ...base.snapshot, passes: mutablePasses });
  expect(base.ownsValues(base.snapshot)).toBe(true);
  const project = () =>
    projectTerrainView(frame, accepted, sourceMaterials, world, sources, () => base).frame;

  const first = defined(project().renderables.at(0));
  accepted.set(terrainSectionKey(source, defined(first.terrainSection).index), first);
  const firstMaterial = first.material;
  expect(firstMaterial.ownsValues(firstMaterial.snapshot)).toBe(false);
  const liveModule = mutablePasses[0]?.program as { module: string } | undefined;
  if (liveModule === undefined) throw new Error('expected a live Terrain material program');
  liveModule.module = 'terrain-test::updated-program';

  const second = defined(project().renderables.at(0));
  expect(second.material).not.toBe(firstMaterial);
  expect(second.material.snapshot.passes[0]?.program.module).toBe('terrain-test::updated-program');
  expect(firstMaterial.snapshot.passes[0]?.program.module).toBe('terrain-test::updated-program');
  expect(accepted.values().next().value?.material).toBe(firstMaterial);
});

function defined<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('expected defined test value');
  return value;
}

it('retains captured program authority through actual Terrain parameter projections', () => {
  const fixture = runtimeTerrainFixture({
    columns: 15,
    rows: 8,
    subsectionVertices: 8,
    spacing: 1,
    heights: new Float32Array(120),
  });
  const source = {
    ...fixture.source,
    terrain: { ...defined(fixture.source.terrain), forcedLod: 0 },
  };
  const frame = {
    renderables: [source],
    dispatch: [],
    cameras: [{}],
  } as unknown as ExtractedFrame;
  const materials = new MaterialFrame(undefined);
  const [sources, resolve] = terrainViewPreparation(fixture.assets);
  const resources = new Map<number, MaterialResource>();
  const sourceScope = worldRenderResources(fixture.world);
  const project = () =>
    projectTerrainView(frame, new Map(), materials, sourceScope, sources, (world, handle) => {
      let resource = resources.get(handle);
      if (resource === undefined) {
        const snapshot = resolve(world, handle).snapshot;
        resource = new MaterialResource(
          captureMaterialSnapshot({
            ...snapshot,
          }),
        );
        resources.set(handle, resource);
      }
      return resource;
    }).frame;
  const admissionInput = (projected: ExtractedFrame, previous?: StandardSceneSurfaceAdmission) => {
    const input = new ProducedStandardSceneDataAdmissionInput();
    input.capture({
      viewIdentity: 'view/terrain',
      generation: 0,
      deviceGeneration: 1,
      standardPipeline: true,
      cameraAvailable: true,
      lane: 'clustered' as const,
      renderPath: 'forward' as const,
    });
    projected.dispatch.forEach((dispatch) => {
      const row = projected.renderables.at(dispatch.renderableIndex);
      const contributor = standardSceneDataContributorForDispatch(
        row,
        dispatch,
        'forward',
        standardSceneSurfaceContributorBaseline(previous)?.[input.contributors.length],
      );
      if (contributor !== undefined) input.contributors.push(contributor);
    });
    return input;
  };
  const first = project();
  const firstInput = admissionInput(first);
  expect(firstInput.contributors.length).toBeGreaterThan(0);
  const programs = first.renderables.map((row) => {
    const pass = defined(row.material.snapshot.passes[0]);
    const observation = row.material.programObservation(pass);
    expect(observation.identity).toBeDefined();
    return observation;
  });
  const firstAdmission = createStandardSceneSurfaceAdmission(firstInput);
  const second = project();
  const secondInput = admissionInput(second, firstAdmission);
  expect(createStandardSceneSurfaceAdmission(secondInput, firstAdmission)).toBe(firstAdmission);
  for (const [index, row] of second.renderables.entries())
    expect(row.material.programObservation(defined(row.material.snapshot.passes[0]))).toBe(
      programs[index],
    );
  for (const lod of [1, 0, 2, 1]) {
    source.terrain.forcedLod = lod;
    const moved = project();
    expect(
      createStandardSceneSurfaceAdmission(admissionInput(moved, firstAdmission), firstAdmission),
    ).toBe(firstAdmission);
    for (const row of moved.renderables) {
      expect(row.material.snapshot.paramSnapshot?.terrainLod).toEqual([lod, lod, 2, 1]);
      expect(row.material.snapshot.paramSnapshot?.terrainNeighbors).toEqual([lod, lod, lod, lod]);
    }
  }
  for (const row of first.renderables) {
    const pass = defined(row.material.snapshot.passes[0]);
    const program = row.material.programObservation(pass);
    expect(new MaterialResource(row.material.snapshot).programObservation(pass)).toBe(program);
    expect(row.material.snapshot.paramSnapshot?.terrainLod).toEqual([0, 0, 2, 1]);
    expect(row.material.snapshot.paramSnapshot?.terrainNeighbors).toEqual([0, 0, 0, 0]);
  }
  for (const resource of resources.values())
    resource.adopt(captureMaterialSnapshot({ ...resource.snapshot, materialProgramInputs: {} }));
  const changed = createStandardSceneSurfaceAdmission(admissionInput(project()), firstAdmission);
  expect(changed).not.toBe(firstAdmission);
  expect(createStandardSceneSurfaceAdmission(firstInput)).toEqual(firstAdmission);
});

it('projects mixed terrain and multi-pass members with one source dispatch traversal', () => {
  const fixture = runtimeTerrainFixture({
    columns: 15,
    rows: 8,
    subsectionVertices: 8,
    spacing: 1,
    heights: new Float32Array(120),
  });
  const terrain = {
    ...fixture.source,
    terrain: { ...defined(fixture.source.terrain), forcedLod: 0 },
  };
  const { terrain: _terrain, ...ordinarySource } = fixture.source;
  const member = (offset: number, authorVisible = true): RenderableSnapshot => ({
    ...ordinarySource,
    entityKey: (fixture.source.entityKey + offset) as typeof fixture.source.entityKey,
    authorVisible,
  });
  const renderables = [member(1), terrain, member(2), member(3, false)];
  const dispatch: DispatchEntry[] = [];
  const add = (renderableIndex: number, passIndex: number, order: string) => {
    const source = defined(renderables[renderableIndex]);
    appendMaterialDispatchEntries(
      dispatch,
      [{ name: order, program: { module: 'test' }, renderState: { queue: 2000 } }],
      source.entityKey as typeof fixture.entity,
      1,
      renderableIndex,
      source.layer ?? 0,
      passIndex,
    );
  };
  add(2, 3, 'last-second');
  add(0, 7, 'first-second');
  add(3, 2, 'hidden');
  add(0, 1, 'first-first');
  add(2, 5, 'last-first');
  const originals = dispatch.slice();
  let traversals = 0;
  Object.defineProperty(dispatch, Symbol.iterator, {
    value: function* () {
      traversals++;
      yield* originals;
    },
  });
  const projected = projectTerrainView(
    { renderables, dispatch, cameras: [{}] } as unknown as ExtractedFrame,
    new Map(),
    fixture.source.materials.reduce(
      (frame, material) => frame.with(material),
      new MaterialFrame(undefined),
    ),
    worldRenderResources(fixture.world),
    ...terrainViewPreparation(fixture.assets),
  ).frame;
  expect(projected.renderables.length).toBe(5);
  expect(projected.dispatch.map((entry) => [entry.renderableIndex, entry.passIndex])).toEqual([
    [0, 7],
    [0, 1],
    [1, 0],
    [1, 1],
    [1, 2],
    [2, 0],
    [2, 1],
    [2, 2],
    [3, 3],
    [3, 5],
    [4, 2],
  ]);
  expect(projected.renderables.at(4)?.authorVisible).toBe(false);
  expect(originals.map((entry) => entry.renderableIndex)).toEqual([2, 0, 3, 0, 2]);
  expect(traversals).toBe(1);
});

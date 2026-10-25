import { mat4, vec3 } from '@forgeax/engine-math';
import { describe, expect, it, vi } from 'vitest';
import type {
  CsmCameraData,
  DirectionalCsmConfig,
  DirectionalLightSnapshot,
  LightRoster,
  PointLightSnapshot,
  PointShadowSnapshot,
  SpotLightSnapshot,
} from '../../render-system-extract';
import * as extract from '../../render-system-extract';
import { RenderLight, renderLightsOf, ShadowView } from '../render-lights';
import { createRenderWorld } from '../render-world';

vi.mock('../../render-system-extract', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../render-system-extract')>();
  return { ...original, computeDirectionalCsm: vi.fn(original.computeDirectionalCsm) };
});

function point(entity: number, x = 0): PointLightSnapshot {
  return {
    kind: 'point',
    entity,
    worldId: 0,
    position: new Float32Array([x, 1, 0]),
    color: new Float32Array([1, 1, 1]),
    intensity: 1,
    invRangeSquared: 0.01,
    shadowNear: 0.1,
    shadowFar: 10,
  } as unknown as PointLightSnapshot;
}

function pointShadow(entity: number, x = 0): PointShadowSnapshot {
  const shadowMatrices = new Float32Array(96);
  for (let face = 0; face < 6; face += 1) {
    shadowMatrices[face * 16] = 1;
    shadowMatrices[face * 16 + 5] = 1;
    shadowMatrices[face * 16 + 10] = 1;
    shadowMatrices[face * 16 + 15] = 1;
    shadowMatrices[face * 16 + 12] = x + face;
  }
  return {
    entity,
    worldId: 0,
    position: new Float32Array([x, 1, 0]),
    mapSize: 512,
    nearPlane: 0.1,
    farPlane: 10,
    depthBias: 0,
    normalBias: 0,
    shadowAtlasLayer: -1,
    shadowMatrices,
  } as unknown as PointShadowSnapshot;
}

function spot(entity: number, castShadow = true): SpotLightSnapshot {
  return {
    kind: 'spot',
    entity,
    worldId: 0,
    position: new Float32Array([0, 2, entity]),
    direction: new Float32Array([0, -1, 0]),
    color: new Float32Array([1, 1, 1]),
    intensity: 1,
    invRangeSquared: 0.01,
    cosInner: 0.9,
    cosOuter: 0.8,
    castShadow,
    lightViewProj: castShadow
      ? new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, entity, 0, 0, 1])
      : undefined,
    mapSize: 1024,
    nearPlane: 0.1,
    farPlane: 10,
    shadowAtlasTile: -1,
  } as unknown as SpotLightSnapshot;
}

function lights(
  points: readonly number[],
  spots: readonly number[] = [],
  moved: Readonly<Record<number, number>> = {},
): LightRoster {
  return {
    directional: undefined,
    directionalCount: 0,
    point: points.map((entity) => point(entity, moved[entity] ?? entity)),
    pointShadow: points.map((entity) => pointShadow(entity, moved[entity] ?? entity)),
    spot: spots.map((entity) => spot(entity)),
    rect: [],
    depthBias: undefined,
    normalBias: undefined,
    directionalShadowError: undefined,
    directionalCsmConfig: undefined,
    directionalCsmDirection: undefined,
  };
}

function fixture() {
  const world = createRenderWorld();
  const owner = renderLightsOf(world);
  const spies = {
    spawn: vi.spyOn(world, 'spawn'),
    despawn: vi.spyOn(world, 'despawn'),
    set: vi.spyOn(world, 'set'),
    alloc: vi.spyOn(world, 'allocUniqueRef'),
  };
  const reset = () => {
    for (const spy of Object.values(spies)) spy.mockClear();
  };
  const layers = (roster: LightRoster) => roster.pointShadow.map((s) => s.shadowAtlasLayer);
  return { world, owner, spies, reset, layers };
}

describe('RenderLights', () => {
  it('spawns one entity per light and assigns layers in source order', () => {
    const { world, owner, layers } = fixture();
    const roster = owner.sync(lights([10, 11], [20, 21]));
    expect(layers(roster)).toEqual([0, 1]);
    expect(roster.point.map((light) => light.shadowAtlasLayer)).toEqual([0, 1]);
    expect(roster.spot.map((light) => light.shadowAtlasTile)).toEqual([0, 1]);
    const lightRows = [...world.query({ read: [RenderLight] }).unwrap()].length;
    expect(lightRows).toBe(4);
    expect([...world.query({ read: [ShadowView] }).unwrap()].length).toBe(6 * 2 + 2);
    expect(owner.shadowViews.map((view) => view.identity)).toEqual([
      ...[0, 1, 2, 3, 4, 5].map((face) => ({ kind: 'point', index: 0, face })),
      ...[0, 1, 2, 3, 4, 5].map((face) => ({ kind: 'point', index: 1, face })),
      { kind: 'spot', index: 0 },
      { kind: 'spot', index: 1 },
    ]);
  });

  it('writes and allocates nothing on a steady frame', () => {
    const { owner, spies, reset } = fixture();
    const first = owner.sync(lights([10, 11], [20]));
    const views = owner.shadowViews;
    reset();
    const second = owner.sync(lights([10, 11], [20]));
    expect(second).toBe(first);
    expect(owner.shadowViews).toBe(views);
    expect(spies.spawn).not.toHaveBeenCalled();
    expect(spies.despawn).not.toHaveBeenCalled();
    expect(spies.set).not.toHaveBeenCalled();
    expect(spies.alloc).not.toHaveBeenCalled();
  });

  it('keeps every other light shadow identity when a light arrives or leaves', () => {
    const { world, owner, spies, reset, layers } = fixture();
    owner.sync(lights([10, 11, 12], [20, 21]));
    const kept = owner.shadowViews.filter(
      (view) => !(view.identity.kind === 'point' && view.identity.index === 1),
    );
    reset();
    // Light 11 leaves: lights 10 and 12 and every spot keep their layers and view objects.
    const without = owner.sync(lights([10, 12], [20, 21]));
    expect(layers(without)).toEqual([0, 2]);
    // The departed light's six face views despawned with it.
    expect([...world.query({ read: [ShadowView] }).unwrap()].length).toBe(6 * 2 + 2);
    for (const view of kept) expect(owner.shadowViews).toContain(view);
    expect(spies.spawn).not.toHaveBeenCalled();
    // A new light takes the freed layer; nobody else moves.
    reset();
    const arrived = owner.sync(lights([13, 10, 12], [20, 21]));
    expect(layers(arrived)).toEqual([1, 0, 2]);
    for (const view of kept) expect(owner.shadowViews).toContain(view);
    // One light entity plus its six face views.
    expect(spies.spawn).toHaveBeenCalledTimes(7);
  });

  it('rewrites only the moved light and its views', () => {
    const { owner, spies, reset } = fixture();
    owner.sync(lights([10, 11]));
    const before = owner.shadowViews;
    reset();
    owner.sync(lights([10, 11], [], { 11: 5 }));
    const after = owner.shadowViews;
    expect(after.slice(0, 6)).toEqual(before.slice(0, 6));
    for (let face = 0; face < 6; face += 1) expect(after[face]).toBe(before[face]);
    for (let face = 6; face < 12; face += 1) expect(after[face]).not.toBe(before[face]);
    expect(spies.spawn).not.toHaveBeenCalled();
    expect(spies.despawn).not.toHaveBeenCalled();
  });

  it('leaves lights beyond atlas capacity unshadowed until a layer frees', () => {
    const { owner, layers } = fixture();
    expect(layers(owner.sync(lights([1, 2, 3, 4, 5])))).toEqual([0, 1, 2, 3, -1]);
    expect(layers(owner.sync(lights([1, 3, 4, 5])))).toEqual([0, 2, 3, 1]);
    const roster = owner.sync(lights([], [1, 2, 3, 4, 5]));
    expect(roster.spot.map((light) => light.shadowAtlasTile)).toEqual([0, 1, 2, 3, -1]);
  });

  it('gives no tile to a spot that does not cast', () => {
    const { owner } = fixture();
    const source = lights([]);
    const roster = owner.sync({ ...source, spot: [spot(1, false), spot(2)] });
    expect(roster.spot.map((light) => light.shadowAtlasTile)).toEqual([-1, 0]);
    expect(owner.shadowViews.map((view) => view.identity)).toEqual([{ kind: 'spot', index: 0 }]);
  });
});

const csmConfig: DirectionalCsmConfig = {
  cascadeCount: 3,
  splitLambda: 0.75,
  cascadeBlend: 0.2,
  mapSize: 1024,
  shadowDistance: 100,
  shadowFilter: 3,
  shadowAngularRadius: 0.00465,
  maxPenumbraTexels: 32,
};

function sunLights(direction = vec3.create(0.18, -0.6, 1)): LightRoster {
  return {
    ...lights([10]),
    directional: {
      kind: 'directional',
      entity: 1,
      direction,
      color: vec3.create(1, 1, 1),
      intensity: 1,
      contactShadowLength: 0,
    } as unknown as DirectionalLightSnapshot,
    directionalCount: 1,
    directionalCsmConfig: csmConfig,
    directionalCsmDirection: direction,
  };
}

function viewCamera(x = 0): CsmCameraData {
  const world = mat4.identity(mat4.create());
  world[12] = x;
  return {
    world,
    fov: (70 * Math.PI) / 180,
    aspect: 16 / 9,
    near: 0.1,
    far: 100,
    projection: 'perspective',
    orthoLeft: -1,
    orthoRight: 1,
    orthoBottom: -1,
    orthoTop: 1,
  };
}

describe('RenderLights cascades', () => {
  const fits = vi.mocked(extract.computeDirectionalCsm);

  it('fits a view once and refits only when its camera or light changes', () => {
    const { world, owner, spies, reset } = fixture();
    const view = {};
    const roster = owner.sync(sunLights());
    fits.mockClear();
    const first = owner.viewLights(view, roster, { camera: viewCamera() });
    expect(fits).toHaveBeenCalledTimes(1);
    expect(first.cascades?.cascadeCount).toBe(3);
    // The view's cascades lead its shadow views, ahead of the point faces.
    expect(first.shadowViews.slice(0, 4).map((shadow) => shadow.identity)).toEqual(
      [0, 1, 2, 3].map((index) => ({ kind: 'directional', index })),
    );
    expect(first.shadowViews.slice(4)).toEqual(owner.shadowViews);
    // One cascade view entity per (light, view, cascade), beside six point faces.
    expect([...world.query({ read: [ShadowView] }).unwrap()].length).toBe(6 + 4);

    // Steady frames: same camera values in a new snapshot, same roster.
    reset();
    for (let frame = 0; frame < 3; frame += 1) {
      const steady = owner.viewLights(view, owner.sync(sunLights(roster.directionalCsmDirection)), {
        camera: viewCamera(),
      });
      expect(steady).toBe(first);
    }
    expect(fits).toHaveBeenCalledTimes(1);
    expect(spies.spawn).not.toHaveBeenCalled();
    expect(spies.set).not.toHaveBeenCalled();
    expect(spies.alloc).not.toHaveBeenCalled();

    // A moved camera refits.
    owner.viewLights(view, roster, { camera: viewCamera(30) });
    expect(fits).toHaveBeenCalledTimes(2);
    // A turned light refits.
    const turned = owner.sync(sunLights(vec3.create(-0.5, -0.6, 0.2)));
    expect(turned).not.toBe(roster);
    const relit = owner.viewLights(view, turned, { camera: viewCamera(30) });
    expect(fits).toHaveBeenCalledTimes(3);
    expect(relit.cascades?.lightViewProj).not.toBe(first.cascades?.lightViewProj);
  });

  it('keeps a refit that retains every submitted cascade', () => {
    const { owner } = fixture();
    const view = {};
    const roster = owner.sync(sunLights());
    const first = owner.viewLights(view, roster, { camera: viewCamera() });
    const retained = first.cascades?.lightViewProj;
    // The submitted projection arrives: the refit keeps each covering matrix.
    const second = owner.viewLights(view, roster, { camera: viewCamera(), retained });
    expect(second).toBe(first);
    fits.mockClear();
    owner.viewLights(view, roster, { camera: viewCamera(), retained });
    expect(fits).not.toHaveBeenCalled();
  });

  it('gives each view its own cascade views and retires them with the view or light', () => {
    const { world, owner } = fixture();
    const near = {};
    const far = {};
    const roster = owner.sync(sunLights());
    const a = owner.viewLights(near, roster, { camera: viewCamera() });
    const b = owner.viewLights(far, roster, { camera: viewCamera(500) });
    expect(a.cascades?.lightViewProj).not.toEqual(b.cascades?.lightViewProj);
    const count = () => [...world.query({ read: [ShadowView] }).unwrap()].length;
    expect(count()).toBe(6 + 4 + 4);
    owner.releaseView(far);
    expect(count()).toBe(6 + 4);
    // The directional light leaves: its cascade views despawn with it.
    owner.sync(lights([10]));
    expect(count()).toBe(6);
    owner.releaseView(near);
    expect(count()).toBe(6);
  });

  it('keeps cascade metadata without a camera so the view still sizes its shadow', () => {
    const { owner } = fixture();
    const roster = owner.sync(sunLights());
    const lit = owner.viewLights({}, roster, { camera: undefined });
    expect(lit.cascades?.lightViewProj).toBeUndefined();
    expect(lit.cascades?.cascadeCount).toBe(3);
    expect(lit.cascades?.shadowMapSize).toBe(1024);
    expect(lit.shadowViews).toBe(owner.shadowViews);
  });
});

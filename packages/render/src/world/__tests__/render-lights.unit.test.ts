import type { EntityHandle } from '@forgeax/engine-ecs';
import { mat4, vec3 } from '@forgeax/engine-math';
import { describe, expect, it, vi } from 'vitest';
import type { CaptureFace } from '../../capture/faces';
import type { ReflectionProbeRecordState } from '../../record/render-context';
import type { ReflectionProbeGraphWork } from '../../record/typed-frame-graph';
import type { CameraSnapshot } from '../../render-contract';
import type {
  CsmCameraData,
  DirectionalCsmConfig,
  DirectionalLightSnapshot,
  ExtractedFrame,
  LightRoster,
  PointLightSnapshot,
  PointShadowSnapshot,
  SpotLightSnapshot,
} from '../../render-system-extract';
import * as extract from '../../render-system-extract';
import type { RenderTarget } from '../../targets/contracts';
import { RENDER_CAPTURE_SCHEDULE_SYSTEM, ViewCaptureWork } from '../capture-systems';
import {
  RENDER_CASCADE_FIT_SYSTEM,
  RENDER_CASCADE_HISTORY_SYSTEM,
  RENDER_LIGHTS_SYSTEM,
  RENDER_SHADOW_VIEWS_SYSTEM,
  registerLightSystems,
} from '../light-systems';
import {
  RENDER_CAPTURE_FIT_SYSTEM,
  registerReflectionProbeSystems,
  viewCaptureFitsOf,
  viewReflectionProbesOf,
} from '../reflection-systems';
import {
  type CascadeHistory,
  CascadeViewOf,
  RenderLight,
  renderLightsOf,
  ShadowView,
  ViewCascadeHistory,
  viewLightsOf,
} from '../render-lights';
import {
  RenderViewInput,
  type RenderViewSource,
  RenderViews,
  recordViewSubmission,
  ViewRecorder,
} from '../render-views';
import {
  beginRenderFrame,
  createRenderWorld,
  endRenderFrame,
  RenderCommit,
  RenderExtract,
  RenderPrepare,
  renderSubmission,
} from '../render-world';
import { RENDER_SCENE_SYSTEM, RenderLightInput, RenderProbeInput } from '../scene-systems';
import { stageViewFrame, ViewFrame } from '../view-frame-systems';
import { registerViewFrameStub, withInertTemporal } from './temporal-owner-fixture';

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

/** A Render World running the light systems; `frame` runs one frame on a roster. */
function lightWorld() {
  const world = createRenderWorld();
  const input: { roster: LightRoster | undefined } = { roster: undefined };
  world.insertResource(RenderLightInput, input);
  registerLightSystems(world);
  const owner = renderLightsOf(world);
  let frames = 0;
  const frame = (roster: LightRoster): LightRoster => {
    input.roster = roster;
    beginRenderFrame(world, ++frames);
    endRenderFrame(world);
    return owner.roster;
  };
  return { world, owner, frame };
}

function fixture() {
  const { world, owner, frame } = lightWorld();
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
  return { world, owner, frame, spies, reset, layers };
}

describe('RenderLights', () => {
  it('spawns one entity per light and assigns layers in source order', () => {
    const { world, owner, layers, frame } = fixture();
    const roster = frame(lights([10, 11], [20, 21]));
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
    const { owner, spies, reset, frame } = fixture();
    const first = frame(lights([10, 11], [20]));
    const views = owner.shadowViews;
    reset();
    const second = frame(lights([10, 11], [20]));
    expect(second).toBe(first);
    expect(owner.shadowViews).toBe(views);
    expect(spies.spawn).not.toHaveBeenCalled();
    expect(spies.despawn).not.toHaveBeenCalled();
    expect(spies.set).not.toHaveBeenCalled();
    expect(spies.alloc).not.toHaveBeenCalled();
  });

  it('keeps every other light shadow identity when a light arrives or leaves', () => {
    const { world, owner, spies, reset, layers, frame } = fixture();
    frame(lights([10, 11, 12], [20, 21]));
    const kept = owner.shadowViews.filter(
      (view) => !(view.identity.kind === 'point' && view.identity.index === 1),
    );
    reset();
    // Light 11 leaves: lights 10 and 12 and every spot keep their layers and view objects.
    const without = frame(lights([10, 12], [20, 21]));
    expect(layers(without)).toEqual([0, 2]);
    // The departed light's six face views despawned with it.
    expect([...world.query({ read: [ShadowView] }).unwrap()].length).toBe(6 * 2 + 2);
    for (const view of kept) expect(owner.shadowViews).toContain(view);
    expect(spies.spawn).not.toHaveBeenCalled();
    // A new light takes the freed layer; nobody else moves.
    reset();
    const arrived = frame(lights([13, 10, 12], [20, 21]));
    expect(layers(arrived)).toEqual([1, 0, 2]);
    for (const view of kept) expect(owner.shadowViews).toContain(view);
    // One light entity plus its six face views.
    expect(spies.spawn).toHaveBeenCalledTimes(7);
  });

  it('rewrites only the moved light and its views', () => {
    const { owner, spies, reset, frame } = fixture();
    frame(lights([10, 11]));
    const before = owner.shadowViews;
    reset();
    frame(lights([10, 11], [], { 11: 5 }));
    const after = owner.shadowViews;
    expect(after.slice(0, 6)).toEqual(before.slice(0, 6));
    for (let face = 0; face < 6; face += 1) expect(after[face]).toBe(before[face]);
    for (let face = 6; face < 12; face += 1) expect(after[face]).not.toBe(before[face]);
    expect(spies.spawn).not.toHaveBeenCalled();
    expect(spies.despawn).not.toHaveBeenCalled();
  });

  it('leaves lights beyond atlas capacity unshadowed until a layer frees', () => {
    const { layers, frame } = fixture();
    expect(layers(frame(lights([1, 2, 3, 4, 5])))).toEqual([0, 1, 2, 3, -1]);
    expect(layers(frame(lights([1, 3, 4, 5])))).toEqual([0, 2, 3, 1]);
    const roster = frame(lights([], [1, 2, 3, 4, 5]));
    expect(roster.spot.map((light) => light.shadowAtlasTile)).toEqual([0, 1, 2, 3, -1]);
  });

  it('gives no tile to a spot that does not cast', () => {
    const { owner, frame } = fixture();
    const source = lights([]);
    const roster = frame({ ...source, spot: [spot(1, false), spot(2)] });
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

describe('RenderLights shadow view fit', () => {
  it('keeps logical shadow identities when an existing light moves', () => {
    const { owner, frame } = fixture();
    frame(lights([10, 11], [20]));
    const previous = owner.shadowViews.map((view) => view.identity);
    frame(lights([10, 11], [20], { 10: 3 }));
    expect(owner.shadowViews.map((view) => view.identity)).toEqual(previous);
    owner.shadowViews.forEach((view, index) => {
      expect(view.identity).toBe(previous[index]);
    });
  });

  it('refits only the changed light when the light owner adopts a new source', () => {
    const { world, frame } = fixture();
    frame(lights([10, 11], [20]));
    const set = vi.spyOn(world, 'set');
    frame(lights([10, 11], [20], { 10: 3 }));
    const viewWrites = set.mock.calls.filter(([, component]) => component === ShadowView);
    expect(viewWrites).toHaveLength(6);
  });
});

describe('light systems', () => {
  it('order render-lights after render-scene and fit shadow views from changed rows in RenderPrepare', () => {
    const world = createRenderWorld();
    world
      .addSystem(RenderExtract, { name: RENDER_SCENE_SYSTEM, queries: [], fn: () => {} })
      .unwrap();
    world.insertResource(RenderLightInput, { roster: undefined });
    registerLightSystems(world);
    const data = world.scheduleData();
    const extract = data.find((schedule) => schedule.name === 'RenderExtract');
    const prepare = data.find((schedule) => schedule.name === 'RenderPrepare');
    expect(extract?.dependencies).toContainEqual([RENDER_SCENE_SYSTEM, RENDER_LIGHTS_SYSTEM]);
    expect(prepare?.systems.map((system) => system.name)).toContain(RENDER_SHADOW_VIEWS_SYSTEM);
    const fit = prepare?.systems.find((system) => system.name === RENDER_SHADOW_VIEWS_SYSTEM);
    expect(fit?.queries.flatMap((query) => query.changed)).toEqual([
      'RenderLight',
      'RenderPointShadow',
    ]);
    // Cascades fit per view entity after the light views, and history commits per view.
    expect(prepare?.dependencies).toContainEqual([
      RENDER_SHADOW_VIEWS_SYSTEM,
      RENDER_CASCADE_FIT_SYSTEM,
    ]);
    const cascades = prepare?.systems.find((system) => system.name === RENDER_CASCADE_FIT_SYSTEM);
    expect(cascades?.queries[0]?.read).toEqual(['RenderView', 'ViewCamera']);
    const commit = data.find((schedule) => schedule.name === 'RenderCommit');
    const history = commit?.systems.find((system) => system.name === RENDER_CASCADE_HISTORY_SYSTEM);
    expect(history?.queries[0]?.read).toContain('ViewSubmission');
  });

  it('spawns no light without render-lights', () => {
    const { world, frame } = lightWorld();
    world.removeSystem(RenderExtract, RENDER_LIGHTS_SYSTEM).unwrap();
    frame(lights([10], [20]));
    expect([...world.query({ read: [RenderLight] }).unwrap()].length).toBe(0);
  });

  it('fits no point or spot shadow view without render-shadow-views', () => {
    const { world, owner, frame } = lightWorld();
    world.removeSystem(RenderPrepare, RENDER_SHADOW_VIEWS_SYSTEM).unwrap();
    frame(lights([10], [20]));
    expect([...world.query({ read: [RenderLight] }).unwrap()].length).toBe(2);
    expect(owner.shadowViews).toEqual([]);
  });
});

/** A primary or composed view camera declared to `render-views` from a CSM camera. */
function viewSnapshot(entityKey: number, x: number, composed: boolean): CameraSnapshot {
  return {
    ...viewCamera(x),
    entityKey,
    historyVersion: 1,
    autoAspect: false,
    ...(composed
      ? {
          view: {
            viewport: new Float32Array([0, 0, 1, 1]),
            order: entityKey,
            resolutionScale: 1,
            maxRenderShortSide: 0,
            updateInterval: 1,
            enabled: true,
          },
        }
      : {}),
  } as unknown as CameraSnapshot;
}

/**
 * A Render World running the view and light systems: `frame(roster, cameras)`
 * declares the primary display (no composed camera) or the composed views,
 * then `submit(entity, accepted, scene)` records a view's attempt before commit.
 */
function viewWorld() {
  const world = createRenderWorld();
  const input: { roster: LightRoster | undefined } = { roster: undefined };
  world.insertResource(RenderLightInput, input);
  const views = new RenderViews(world);
  registerLightSystems(world);
  const owner = renderLightsOf(world);
  let frames = 0;
  const frame = (
    roster: LightRoster,
    cameras: readonly CameraSnapshot[],
    submit: (frame: number) => void = () => {},
  ): void => {
    input.roster = roster;
    const composed = cameras.some((camera) => camera.view !== undefined);
    // The frame source's Worlds stage a view's resource scopes.
    const source = {
      worlds: [],
      cameras: composed ? cameras : [],
      captures: [],
      primary: !composed,
      primaryCamera: composed ? undefined : cameras[0],
      canvas: { width: 64, height: 64 },
      attachment: () => 'world-a',
      targetExtent: () => undefined,
    } as RenderViewSource;
    world.insertResource(RenderViewInput, source);
    beginRenderFrame(world, ++frames);
    submit(frames);
    endRenderFrame(world);
  };
  const submit = (entity: EntityHandle, attempt: number, accepted = true, scene = accepted) =>
    recordViewSubmission(world, entity, { accepted, attempt, scene, temporal: false });
  const lightsOf = (entity: EntityHandle | undefined) => viewLightsOf(world, entity);
  const history = (entity: EntityHandle) =>
    world
      .resolveUniqueRef<CascadeHistory>(world.get(entity, ViewCascadeHistory).unwrap().history)
      .unwrap().lightViewProj;
  return { world, views, owner, frame, submit, lightsOf, history };
}

describe('render-cascade-fit', () => {
  const fits = vi.mocked(extract.computeDirectionalCsm);

  it('fits the primary view once and refits only when its camera or light changes', () => {
    const { world, views, owner, frame, lightsOf } = viewWorld();
    const roster = sunLights();
    fits.mockClear();
    frame(roster, [viewSnapshot(5, 0, false)]);
    const primary = views.primary as EntityHandle;
    const first = lightsOf(primary);
    expect(fits).toHaveBeenCalledTimes(1);
    expect(first?.cascades?.cascadeCount).toBe(3);
    // The view's cascades lead its shadow views, ahead of the point faces.
    expect(first?.shadowViews.slice(0, 4).map((shadow) => shadow.identity)).toEqual(
      [0, 1, 2, 3].map((index) => ({ kind: 'directional', index })),
    );
    expect(first?.shadowViews.slice(4)).toEqual(owner.shadowViews);
    // One cascade view entity per (light, view, cascade), following its view entity.
    const cascadeViews = () => [...world.query({ read: [ShadowView, CascadeViewOf] }).unwrap()];
    expect(cascadeViews().map((row) => row.get(CascadeViewOf).view)).toEqual(
      Array(4).fill(primary),
    );
    expect([...world.query({ read: [ShadowView] }).unwrap()].length).toBe(6 + 4);

    // Steady frames: same camera values in a new snapshot, same light values.
    const spawn = vi.spyOn(world, 'spawn');
    const alloc = vi.spyOn(world, 'allocUniqueRef');
    for (let step = 0; step < 3; step += 1) {
      frame(sunLights(roster.directionalCsmDirection), [viewSnapshot(5, 0, false)]);
      expect(lightsOf(primary)).toBe(first);
    }
    expect(fits).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(alloc.mock.calls.filter(([target]) => target === 'ShadowViewProjection')).toEqual([]);

    // A moved camera refits.
    frame(roster, [viewSnapshot(5, 30, false)]);
    expect(fits).toHaveBeenCalledTimes(2);
    // A turned light refits.
    frame(sunLights(vec3.create(-0.5, -0.6, 0.2)), [viewSnapshot(5, 30, false)]);
    expect(fits).toHaveBeenCalledTimes(3);
    expect(lightsOf(primary)?.cascades?.lightViewProj).not.toBe(first?.cascades?.lightViewProj);
  });

  it('gives each composed view its own cascades, retired with the view or light', () => {
    const { world, views, frame, lightsOf } = viewWorld();
    const roster = sunLights();
    frame(roster, [viewSnapshot(1, 0, true), viewSnapshot(2, 500, true)]);
    const [near, far] = views.ordered as [EntityHandle, EntityHandle];
    expect(lightsOf(near)?.cascades?.lightViewProj).not.toEqual(
      lightsOf(far)?.cascades?.lightViewProj,
    );
    // The shared capture view records only captures: it fits fresh cascades of its own.
    expect(views.primary).toBeDefined();
    expect(lightsOf(views.primary)?.cascades?.cascadeCount).toBe(3);
    const count = () => [...world.query({ read: [ShadowView] }).unwrap()].length;
    expect(count()).toBe(6 + 4 + 4 + 4);
    // The far view's camera leaves: its entity and cascade views despawn.
    frame(roster, [viewSnapshot(1, 0, true)]);
    expect(count()).toBe(6 + 4 + 4);
    // The directional light leaves: its cascade views despawn with it.
    frame(lights([10]), [viewSnapshot(1, 0, true)]);
    expect(count()).toBe(6);
  });

  it('spawns a fitted view cascades when its directional light arrives without poisoning the World', () => {
    const { world, views, frame, lightsOf } = viewWorld();
    // Two composed views (plus the shared capture view) fit with no directional light first.
    const cameras = [viewSnapshot(1, 0, true), viewSnapshot(2, 500, true)];
    frame(lights([10]), cameras);
    expect([...world.query({ read: [CascadeViewOf] }).unwrap()]).toEqual([]);
    // The sun arrives: refitting already-fitted views spawns their cascade views.
    frame(sunLights(), cameras);
    const [near, far] = views.ordered as [EntityHandle, EntityHandle];
    expect(lightsOf(near)?.cascades?.cascadeCount).toBe(3);
    expect(lightsOf(far)?.cascades?.cascadeCount).toBe(3);
    expect([...world.query({ read: [CascadeViewOf] }).unwrap()].length).toBe(4 * 3);
  });

  it('keeps cascade metadata without a camera so the view still sizes its shadow', () => {
    const { owner, views, frame, lightsOf } = viewWorld();
    frame(sunLights(), []);
    const lit = lightsOf(views.primary);
    expect(lit?.cascades?.lightViewProj).toBeUndefined();
    expect(lit?.cascades?.cascadeCount).toBe(3);
    expect(lit?.cascades?.shadowMapSize).toBe(1024);
    expect(lit?.shadowViews).toBe(owner.shadowViews);
  });

  it('fits no view cascades without render-cascade-fit', () => {
    const { world, views, frame, lightsOf } = viewWorld();
    world.removeSystem(RenderPrepare, RENDER_CASCADE_FIT_SYSTEM).unwrap();
    frame(sunLights(), [viewSnapshot(5, 0, false)]);
    expect(lightsOf(views.primary)).toBeUndefined();
    expect([...world.query({ read: [CascadeViewOf] }).unwrap()]).toEqual([]);
  });
});

describe('render-cascade-fit shared capture view', () => {
  it('fits against fresh cascades and never retains submitted history', () => {
    const { views, frame, lightsOf, submit, history } = viewWorld();
    const roster = sunLights();
    let primary: EntityHandle | undefined;
    frame(roster, [viewSnapshot(1, 0, true)], (attempt) => {
      primary = views.primary;
      submit(primary as EntityHandle, attempt);
    });
    const entity = primary as EntityHandle;
    const first = lightsOf(entity);
    expect(first?.cascades?.cascadeCount).toBe(3);
    // Accepted scene submissions never advance the shared capture view's history.
    frame(roster, [viewSnapshot(1, 0, true)], (attempt) => submit(entity, attempt));
    expect(history(entity)).toBeUndefined();
    expect(lightsOf(entity)).toBe(first);
  });
});

describe('render-cascade-history', () => {
  it('retains only the cascades of an accepted scene submission of the frame', () => {
    const { views, frame, submit, lightsOf, history } = viewWorld();
    const roster = sunLights();
    const display = [viewSnapshot(5, 0, false)];
    frame(roster, display);
    const primary = views.primary as EntityHandle;
    expect(history(primary)).toBeUndefined();
    // A rejected attempt, an accepted preparation barrier and a stale attempt keep it.
    frame(roster, display, (n) => submit(primary, n, false));
    frame(roster, display, (n) => submit(primary, n, true, false));
    frame(roster, display, (n) => submit(primary, n - 1));
    expect(history(primary)).toBeUndefined();
    // The accepted scene submission retains what it rasterized; the next fit keeps it.
    const submitted = lightsOf(primary)?.cascades?.lightViewProj;
    frame(roster, display, (n) => submit(primary, n));
    expect(history(primary)).toBe(submitted);
    frame(roster, display);
    expect(lightsOf(primary)?.cascades?.lightViewProj).toEqual(submitted);
  });

  it('never advances without render-cascade-history', () => {
    const { world, views, frame, submit, history } = viewWorld();
    world.removeSystem(RenderCommit, RENDER_CASCADE_HISTORY_SYSTEM).unwrap();
    const display = [viewSnapshot(5, 0, false)];
    frame(sunLights(), display);
    const primary = views.primary as EntityHandle;
    frame(sunLights(), display, (n) => submit(primary, n));
    expect(history(primary)).toBeUndefined();
  });

  it('keeps a held composed view history', () => {
    const { world, views, frame, submit, lightsOf, history } = viewWorld();
    const cameras = [viewSnapshot(1, 0, true)];
    frame(sunLights(), cameras);
    const view = views.ordered[0] as EntityHandle;
    const state: { rendered: boolean; lastFrame: number; renderedFrames: number } = {
      rendered: false,
      lastFrame: -1,
      renderedFrames: 0,
    };
    world
      .addComponent(view, {
        component: ViewRecorder,
        data: {
          state: world.allocUniqueRef('ViewRecorder', withInertTemporal(state)),
        },
      })
      .unwrap();
    frame(sunLights(), cameras, (n) => submit(view, n));
    expect(history(view)).toBeUndefined();
    state.rendered = true;
    frame(sunLights(), cameras, (n) => submit(view, n));
    expect(history(view)).toBe(lightsOf(view)?.cascades?.lightViewProj);
  });
});

describe('RenderLights hand-driven capture fit', () => {
  it('fits a capture key against fresh cascades and despawns them on release', () => {
    const { world, owner, frame } = fixture();
    const roster = frame(sunLights());
    const capture = {};
    const lit = owner.viewLights(capture, roster, { camera: viewCamera() });
    expect(lit.cascades?.cascadeCount).toBe(3);
    expect(owner.viewLights(capture, roster, { camera: viewCamera() })).toBe(lit);
    const count = () => [...world.query({ read: [ShadowView] }).unwrap()].length;
    expect(count()).toBe(6 + 4);
    owner.releaseView(capture);
    expect(count()).toBe(6);
  });
});

describe('render-capture-fit', () => {
  const fits = vi.mocked(extract.computeDirectionalCsm);

  function captureWorld() {
    const fixture = viewWorld();
    const { world, views, frame } = fixture;
    world.insertResource(RenderProbeInput, { facts: [] });
    registerReflectionProbeSystems(world);
    frame(sunLights(), [viewSnapshot(5, 0, false)]);
    const view = views.primary as EntityHandle;
    const faceCamera = viewSnapshot(9, 40, false);
    const work = {
      probeIndex: 0,
      captureGeneration: 1,
      rawCaptureFace: 2,
      faceCamera,
    } as unknown as ReflectionProbeGraphWork;
    const probes = {
      table: { rows: [{ index: 0 }] },
      graph: { work: [work] },
      completeSubmission: async () => {},
    } as unknown as ReflectionProbeRecordState;
    const recorder = {
      prepareViewFrame: () => ({
        ok: true as const,
        value: {
          renderables: [],
          cameras: [],
          environment: undefined,
        } as unknown as ExtractedFrame,
      }),
    };
    registerViewFrameStub(world, recorder.prepareViewFrame);
    // The view's probe owner prepares the face work `render-capture-fit` fits.
    const owner = {
      frameState: { frameNumber: 1 },
      scene: {
        projectReflectionProbes: () => undefined,
        reflectionProbeProjection: () => ({ selected: new Map() }),
        reflectionCaptureRevision: () => '',
      },
      reflectionProbes: { prepare: () => probes, inspect: () => ({}) },
    };
    world
      .addComponent(view, {
        component: ViewRecorder,
        data: {
          state: world.allocUniqueRef('ViewRecorder', withInertTemporal({}, owner)),
        },
      })
      .unwrap();
    world
      .addSystem(RenderExtract, {
        name: 'test-stage',
        queries: [],
        fn: (world) => stageViewFrame(world, view, { cameraOwner: 0, resourceOwner: 0 }),
      })
      .unwrap();
    return { ...fixture, view, work, faceCamera };
  }

  it('fits probe faces in RenderPrepare, retained across steady frames', () => {
    const { world, frame, view, work } = captureWorld();
    fits.mockClear();
    frame(sunLights(), [viewSnapshot(5, 0, false)]);
    expect(viewReflectionProbesOf(world, view)?.ok).toBe(true);
    const fitted = viewCaptureFitsOf(world, view)?.get(work);
    expect(fitted?.cascades?.cascadeCount).toBe(3);
    // One fit for the view, one against the probe face camera.
    expect(fits.mock.calls.some(([, , camera]) => camera?.world[12] === 40)).toBe(true);
    const count = fits.mock.calls.length;
    frame(sunLights(), [viewSnapshot(5, 0, false)]);
    expect(viewCaptureFitsOf(world, view)?.get(work)).toBe(fitted);
    expect(fits.mock.calls.length).toBe(count);
  });

  it('fits every CaptureFitKey kind of the scheduled faces and releases a vanished target', () => {
    const { world, frame, view } = captureWorld();
    const target = (): RenderTarget => ({}) as RenderTarget;
    const [cubeTarget, planarTarget, auxTarget, sceneTarget] = [
      target(),
      target(),
      target(),
      target(),
    ];
    const face = (key: CaptureFace['key'], x: number): CaptureFace => ({
      key,
      work: { target: key.target, layer: 0, faceCamera: viewSnapshot(9, x, false) } as never,
    });
    let faces: readonly CaptureFace[] = [
      face({ kind: 'cube', target: cubeTarget, layer: 0 }, 41),
      face({ kind: 'planar', target: planarTarget }, 42),
      face({ kind: 'auxiliary', target: auxTarget, layer: 0 }, 43),
      face({ kind: 'scene-input', featureIdentity: 'sdf', target: sceneTarget }, 44),
    ];
    // Stands in for `render-capture-schedule`: the faces are data the fit reads.
    world
      .addSystem(RenderPrepare, {
        name: RENDER_CAPTURE_SCHEDULE_SYSTEM,
        queries: [{ read: [ViewFrame], optional: [ViewCaptureWork] }],
        fn: (world, [rows]) => {
          const value = { cube: [], sceneInputs: [], auxiliaryCameras: [], faces };
          const outcome = { kind: 'prepared' as const, value };
          const collected = [...rows].map((row) => ({
            entity: row.entity,
            stored: row.get(ViewCaptureWork),
          }));
          for (const { entity, stored } of collected) {
            const state = { frame: renderSubmission(world).frame, outcome };
            if (stored === undefined)
              world
                .addComponent(entity, {
                  component: ViewCaptureWork,
                  data: { state: world.allocUniqueRef('ViewCaptureWork', state) },
                })
                .unwrap();
            else Object.assign(world.resolveUniqueRef<object>(stored.state).unwrap(), state);
          }
        },
      })
      .unwrap();
    const shadowViews = () => [...world.query({ read: [ShadowView] }).unwrap()].length;
    frame(sunLights(), [viewSnapshot(5, 0, false)]);
    const first = faces.map((item) => viewCaptureFitsOf(world, view)?.get(item.work));
    for (const fitted of first) expect(fitted?.cascades?.cascadeCount).toBe(3);
    const withFaces = shadowViews();
    frame(sunLights(), [viewSnapshot(5, 0, false)]);
    expect(faces.map((item) => viewCaptureFitsOf(world, view)?.get(item.work))).toEqual(first);
    faces = faces.slice(0, 2);
    frame(sunLights(), [viewSnapshot(5, 0, false)]);
    expect(viewCaptureFitsOf(world, view)?.get((faces[0] as CaptureFace).work)).toBe(first[0]);
    expect(viewCaptureFitsOf(world, view)?.size).toBe(3);
    expect(shadowViews()).toBeLessThan(withFaces);
  });

  it('orders after view-reflection-probes in RenderPrepare', () => {
    const { world } = captureWorld();
    const system = world
      .scheduleData()
      .flatMap((schedule) => schedule.systems.map((item) => ({ schedule: schedule.name, ...item })))
      .find((item) => item.name === RENDER_CAPTURE_FIT_SYSTEM);
    expect(system?.schedule).toBe('RenderPrepare');
    expect(system?.after).toEqual(['view-reflection-probes', 'render-capture-schedule']);
    expect(system?.queries[0]?.read).toEqual(['ViewFrame']);
    expect(system?.queries[0]?.optional).toEqual(['ViewCaptureFits']);
  });
});

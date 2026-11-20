import type { WaterSplashWakeEvent, WaterVisualContact } from '@forgeax/engine-water';
import { expect, it, vi } from 'vitest';
import { snapshot } from '../../__tests__/gpu-driven-production-fixture';
import { MaterialResource } from '../../material-resource';
import { FrameProjection } from '../../scene/frame-list';
import { RenderScene } from '../../scene/render-scene';
import { RowViews } from '../../scene/scene-slots';
import {
  captureWaterFluidFoamMaterials,
  prepareWaterFluidFoamFrame,
  type WaterFluidFoamInput,
  type WaterFluidFoamMaterial,
  waterFluidFoamContactStrength,
} from '../fluid-foam';

function requiredFixtureValue<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Required fixture value is missing');
  return value;
}

const material = (bodyGuid = 'ocean', center = 0): WaterFluidFoamMaterial => ({
  worldIdentity: 'world-a',
  bodyGuid,
  bodyGeneration: 1,
  materialHandle: 8,
  mapping: { kind: 'mapped', centerXZ: [center, 0], extentM: 100 },
});
const event = (step = 5): WaterSplashWakeEvent => ({
  sourcePhysicsStep: step,
  queryTimeSeconds: step / 60,
  fixedDeltaSeconds: 1 / 60,
  rootEntity: 2,
  rootGeneration: 3,
  pontoonId: 'bow',
  bodyGuid: 'ocean',
  bodyGeneration: 1,
  phase: 'wake',
  positionM: [4, -0.4, 7],
  forceN: [0, 30, 0],
  contact: {
    kind: 'water-plane-intersection',
    positionM: [4, 0, 7],
    radiusM: 0.8,
    relativeVelocityMps: [3, 1, 0],
  },
});
const input = (): WaterFluidFoamInput => ({
  timeSeconds: 1,
  materials: [material()],
  roots: [{ worldIdentity: 'world-a', rootEntity: 2, rootGeneration: 3 }],
  events: [{ worldIdentity: 'world-a', event: event() }],
});
const configuration = { resolution: 64, decayPerSecond: 0.5, strengthPerMps: 0.4 };

it('filters event age before pure preparation while keeping current events and submitted cursors', () => {
  const source = input();
  const expired = { ...event(5), queryTimeSeconds: 1 };
  const current = { ...event(6), queryTimeSeconds: 2 };
  const frame = requiredFixtureValue(
    prepareWaterFluidFoamFrame(
      {
        ...source,
        timeSeconds: 3,
        events: [
          { worldIdentity: 'world-a', event: expired },
          { worldIdentity: 'world-a', event: current },
        ],
      },
      { ...configuration, maximumEventAgeSeconds: 2 },
      0,
      10,
    ).unwrap(),
  );
  expect(frame.events.map((row) => row.event)).toEqual([current]);
  expect(Object.values(frame.cursors)).toEqual([6]);
});

it('keeps the speed envelope identical at 60/30/20 FPS and merged fixed catch-up', () => {
  const strength = waterFluidFoamContactStrength([0.8, 0.1, 0], configuration.strengthPerMps);
  const run = (fps: number, merged: boolean) => {
    let coverage = 0;
    for (let frame = 0; frame < fps; frame++) {
      coverage *= Math.exp(-configuration.decayPerSecond / fps);
      const contacts = merged ? 1 : 60 / fps;
      for (let index = 0; index < contacts; index++) coverage = Math.max(coverage, strength);
    }
    return coverage;
  };
  expect([run(60, false), run(30, false), run(20, false), run(20, true)]).toEqual([
    strength,
    strength,
    strength,
    strength,
  ]);
});

it('shares a mapping only between materials of the same Ocean owner', () => {
  const source = input();
  const accepted = prepareWaterFluidFoamFrame(
    { ...source, materials: [material(), { ...material(), materialHandle: 9 }] },
    configuration,
    0,
    10,
  ).unwrap();
  expect(accepted?.owners.map((owner) => owner.bodyGuid)).toEqual(['ocean']);
  const conflict = prepareWaterFluidFoamFrame(
    { ...source, materials: [material(), material('ocean', 0.000001)] },
    configuration,
    0,
    11,
    accepted,
  );
  expect(conflict).toMatchObject({ ok: false, error: { reason: 'mapping-conflict' } });
  expect(accepted?.sourceFrame).toBe(10);
});

it.each([
  'world',
  'body',
] as const)('rejects a second %s owner even with an identical mapping', (change) => {
  const foreign =
    change === 'world' ? { ...material(), worldIdentity: 'world-b' } : material('ocean-b');
  expect(
    prepareWaterFluidFoamFrame(
      { ...input(), materials: [material(), foreign] },
      configuration,
      0,
      10,
    ),
  ).toMatchObject({ ok: false, error: { reason: 'owner-conflict' } });
});

it('starts fresh when the renderer receiver session changes and its frame number restarts', () => {
  const source = { ...input(), receiverSession: 'receiver-a' };
  const first = requiredFixtureValue(
    prepareWaterFluidFoamFrame(source, configuration, 0, 10).unwrap(),
  );
  const replacement = requiredFixtureValue(
    prepareWaterFluidFoamFrame(
      { ...source, receiverSession: 'receiver-b' },
      configuration,
      0,
      1,
      first,
    ).unwrap(),
  );
  expect(replacement.initialize).toBe(true);
  expect(replacement.generation).toBe(first.generation + 1);
  expect(replacement.events).toHaveLength(1);
  expect(prepareWaterFluidFoamFrame(source, configuration, 0, 10, first)).toMatchObject({
    ok: false,
    error: { reason: 'stale-source-frame' },
  });
});

it('uses force-time contacts and commits event cursors only through submitted history', () => {
  const source = input();
  const first = requiredFixtureValue(
    prepareWaterFluidFoamFrame(source, configuration, 0, 10).unwrap(),
  );
  expect(first.events).toHaveLength(1);
  expect(first.events[0]?.event.contact).toEqual(event().contact);
  const duplicate = requiredFixtureValue(
    prepareWaterFluidFoamFrame(
      { ...source, events: [...source.events, ...source.events] },
      configuration,
      0,
      10,
    ).unwrap(),
  );
  expect(duplicate.events).toHaveLength(1);
  const retry = requiredFixtureValue(
    prepareWaterFluidFoamFrame(source, configuration, 0, 11).unwrap(),
  );
  expect(retry.events).toHaveLength(1);
  const submitted = requiredFixtureValue(
    prepareWaterFluidFoamFrame(source, configuration, 0, 11, first).unwrap(),
  );
  expect(submitted.events).toEqual([]);
  expect(submitted.deltaSeconds).toBe(0);
  const later = requiredFixtureValue(
    prepareWaterFluidFoamFrame(
      { ...source, timeSeconds: 1.5, events: [{ worldIdentity: 'world-a', event: event(6) }] },
      configuration,
      0,
      12,
      submitted,
    ).unwrap(),
  );
  expect(later.events).toHaveLength(1);
  expect(later.deltaSeconds).toBe(0.5);
});

it.each([
  'device',
  'body',
  'world',
] as const)('clears contact history after %s replacement', (change) => {
  const source = input();
  const first = requiredFixtureValue(
    prepareWaterFluidFoamFrame(source, configuration, 0, 10).unwrap(),
  );
  const next: WaterFluidFoamInput =
    change === 'body'
      ? { ...source, materials: [{ ...material(), bodyGeneration: 2 }] }
      : change === 'world'
        ? { ...source, materials: [{ ...material(), worldIdentity: 'world-b' }], roots: [] }
        : source;
  const reset = requiredFixtureValue(
    prepareWaterFluidFoamFrame(
      next,
      configuration,
      change === 'device' ? 1 : 0,
      11,
      first,
    ).unwrap(),
  );
  expect(reset.initialize).toBe(true);
  expect(reset.generation).toBe(first.generation + 1);
  expect(reset.events).toHaveLength(change === 'device' ? 1 : 0);
});

it('preserves Ocean history when roots change while rejecting old root generations', () => {
  const source = input();
  const first = requiredFixtureValue(
    prepareWaterFluidFoamFrame(source, configuration, 0, 10).unwrap(),
  );
  const added = requiredFixtureValue(
    prepareWaterFluidFoamFrame(
      {
        ...source,
        roots: [...source.roots, { worldIdentity: 'world-a', rootEntity: 9, rootGeneration: 1 }],
      },
      configuration,
      0,
      11,
      first,
    ).unwrap(),
  );
  expect(added.initialize).toBe(false);
  expect(added.generation).toBe(first.generation);
  const replaced = requiredFixtureValue(
    prepareWaterFluidFoamFrame(
      {
        ...source,
        roots: [{ worldIdentity: 'world-a', rootEntity: 2, rootGeneration: 4 }],
        events: [{ worldIdentity: 'world-a', event: event(6) }],
      },
      configuration,
      0,
      12,
      added,
    ).unwrap(),
  );
  expect(replaced.initialize).toBe(false);
  expect(replaced.events).toEqual([]);
  expect(replaced.cursors).toEqual({});
});

it('uses explicit hull contact probes instead of rendering force-pontoon outlines', () => {
  const source = input();
  const probe: WaterVisualContact = {
    kind: 'visual-probe',
    sourceIdentity: 'hull',
    sourcePhysicsStep: 5,
    queryTimeSeconds: 5 / 60,
    rootEntity: 2,
    rootGeneration: 3,
    probeId: 'edge',
    bodyGuid: 'ocean',
    bodyGeneration: 1,
    phase: 'contact',
    coverage: 0.8,
    contact: {
      kind: 'water-plane-intersection',
      positionM: [4, 0, 7],
      radiusM: 0.4,
      relativeVelocityMps: [0, 0.5, 0],
    },
  };
  const frame = requiredFixtureValue(
    prepareWaterFluidFoamFrame(
      {
        ...source,
        roots: [
          ...source.roots,
          { worldIdentity: 'world-a', rootEntity: 2, rootGeneration: 3, sourceIdentity: 'hull' },
        ],
        events: [...source.events, { worldIdentity: 'world-a', event: probe }],
      },
      configuration,
      0,
      10,
    ).unwrap(),
  );
  expect(frame.events.map((entry) => entry.event)).toEqual([probe]);
  expect(Object.keys(frame.cursors)).toHaveLength(2);
});

it('rejects stale source frames and does not stamp exit, dry or foreign-World events', () => {
  const source = input();
  const first = requiredFixtureValue(
    prepareWaterFluidFoamFrame(source, configuration, 0, 10).unwrap(),
  );
  expect(prepareWaterFluidFoamFrame(source, configuration, 0, 10, first)).toMatchObject({
    ok: false,
    error: { reason: 'stale-source-frame' },
  });
  const dry = { ...event(6), contact: { kind: 'none' as const, reason: 'submerged' as const } };
  const filtered = requiredFixtureValue(
    prepareWaterFluidFoamFrame(
      {
        ...source,
        events: [
          { worldIdentity: 'world-a', event: { ...dry, phase: 'exited' } },
          { worldIdentity: 'world-b', event: event(7) },
          { worldIdentity: 'world-a', event: dry },
        ],
      },
      configuration,
      0,
      11,
      first,
    ).unwrap(),
  );
  expect(filtered.events).toEqual([]);
});

it('skips dry retained Scene rows and dispatch, then admits and retires a Water owner', () => {
  const scene = new RenderScene();
  const ordinary = snapshot(1, 1);
  const foam = new MaterialResource({
    ...ordinary.material.snapshot,
    materialHandle: 8,
    staticSwitches: { waterOceanFoam: true },
    paramSnapshot: { simulationLocationM: [3, 0, 7], waveCaptureSizeM: 100 },
  });
  const dispatch = {
    [Symbol.iterator]: vi.fn(() => [{ renderableIndex: 0, materialHandle: 8 }].values()),
  };
  scene.apply([{ kind: 'update', entityKey: 1, snapshot: ordinary }]);
  const dry = scene.materialize();
  const read = vi.spyOn(RowViews.prototype, 'read');
  try {
    expect(captureWaterFluidFoamMaterials(dry, 'view', dispatch)).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    expect(dispatch[Symbol.iterator]).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }

  scene.apply([
    {
      kind: 'update',
      entityKey: 1,
      snapshot: {
        ...ordinary,
        material: foam,
        materials: [foam],
        waterOwner: {
          worldIdentity: 'world-a',
          guid: 'ocean',
          generation: 1,
          zoneGeneration: 1,
        },
      },
    },
  ]);
  const wet = scene.materialize();
  const mapped = {
    ...material('ocean', 3),
    mapping: { kind: 'mapped', centerXZ: [3, 7], extentM: 100 },
  };
  expect(captureWaterFluidFoamMaterials(wet, 'view', dispatch)).toEqual([mapped]);
  expect(captureWaterFluidFoamMaterials(wet, 'view', [])).toEqual([]);
  const borrowed = new FrameProjection(dry, () => requiredFixtureValue(wet.at(0)));
  expect(captureWaterFluidFoamMaterials(borrowed, 'view', dispatch)).toEqual([mapped]);
  scene.apply([{ kind: 'remove', entityKey: 1 }]);
  expect(captureWaterFluidFoamMaterials(scene.materialize(), 'view', dispatch)).toEqual([]);
  expect(captureWaterFluidFoamMaterials(dry, 'view', dispatch)).toEqual([]);
  expect(captureWaterFluidFoamMaterials(wet, 'view', dispatch)).toEqual([mapped]);
});

it('keeps the WaterMesh source route when the root has no ordinary Water owner', () => {
  const scene = new RenderScene();
  const ordinary = snapshot(1, 1);
  const dispatch = { [Symbol.iterator]: vi.fn(() => [].values()) };
  scene.apply([
    {
      kind: 'update',
      entityKey: 1,
      snapshot: {
        ...ordinary,
        waterMeshSource: {
          worldIdentity: 'world-a',
          guid: 'ocean',
          generation: 1,
          zoneGuid: 'zone',
          zoneGeneration: 1,
          targetFormat: 'rgba16float',
          materialStartIndex: 0,
          views: [],
        },
      },
    },
  ]);
  expect(captureWaterFluidFoamMaterials(scene.materialize(), 'view', dispatch)).toEqual([]);
  expect(dispatch[Symbol.iterator]).toHaveBeenCalledOnce();
});

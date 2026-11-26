import { createWorldContext, World } from '@forgeax/engine-ecs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ChildOf,
  Mobility,
  type MobilityDiagnostic,
  MobilityKindValue,
  mobilityKindFromU32,
  scenePlugin,
  subscribeMobilityDiagnostics,
  Transform,
} from '../index';
import { readInheritedMobility } from '../internal';

describe('Mobility', () => {
  let received: MobilityDiagnostic[];
  let unsubscribe: () => void;

  beforeEach(() => {
    received = [];
    unsubscribe = subscribeMobilityDiagnostics((_world, diagnostic) => received.push(diagnostic));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    unsubscribe();
    vi.restoreAllMocks();
  });

  async function sceneWorld(): Promise<World> {
    const world = new World();
    await createWorldContext(world, [scenePlugin()]);
    return world;
  }

  it('defaults to movable and exposes the closed kind labels through the schema', async () => {
    const world = await sceneWorld();
    const entity = world.spawn({ component: Mobility, data: {} }).unwrap();
    expect(mobilityKindFromU32(world.get(entity, Mobility).unwrap().kind)).toBe('movable');
    expect(Mobility.fields.kind.labels).toEqual({ static: 0, stationary: 1, movable: 2 });
  });

  it('reads the current hierarchy up to 64 ancestors and rejects a retired handle', () => {
    const world = new World();
    const root = world
      .spawn({ component: Mobility, data: { kind: MobilityKindValue.static } })
      .unwrap();
    const other = world
      .spawn({ component: Mobility, data: { kind: MobilityKindValue.stationary } })
      .unwrap();
    const branch = world.spawn({ component: ChildOf, data: { parent: root } }).unwrap();
    let leaf = branch;
    for (let depth = 1; depth < 64; depth++)
      leaf = world.spawn({ component: ChildOf, data: { parent: leaf } }).unwrap();
    const beyond = world.spawn({ component: ChildOf, data: { parent: leaf } }).unwrap();
    expect(readInheritedMobility(world, leaf)).toBe('static');
    expect(readInheritedMobility(world, beyond)).toBe('movable');
    world.set(branch, ChildOf, { parent: other }).unwrap();
    expect(readInheritedMobility(world, leaf)).toBe('stationary');
    world.despawn(beyond).unwrap();
    const replacement = world
      .spawn({ component: Mobility, data: { kind: MobilityKindValue.static } })
      .unwrap();
    expect(readInheritedMobility(world, replacement)).toBe('static');
    expect(readInheritedMobility(world, beyond)).toBe('movable');
  });

  it('sees the first declaration, its removal and a later declaration on another ancestor immediately', () => {
    const world = new World();
    const root = world.spawn().unwrap();
    const branch = world.spawn({ component: ChildOf, data: { parent: root } }).unwrap();
    const leaf = world.spawn({ component: ChildOf, data: { parent: branch } }).unwrap();
    expect(readInheritedMobility(world, leaf)).toBe('movable');
    world
      .addComponent(root, { component: Mobility, data: { kind: MobilityKindValue.static } })
      .unwrap();
    expect(readInheritedMobility(world, leaf)).toBe('static');
    world.removeComponent(root, Mobility).unwrap();
    expect(readInheritedMobility(world, leaf)).toBe('movable');
    world
      .addComponent(branch, { component: Mobility, data: { kind: MobilityKindValue.stationary } })
      .unwrap();
    expect(readInheritedMobility(world, leaf)).toBe('stationary');
    world
      .addComponent(root, { component: Mobility, data: { kind: MobilityKindValue.static } })
      .unwrap();
    expect(readInheritedMobility(world, leaf)).toBe('stationary');
    world.removeComponent(branch, Mobility).unwrap();
    expect(readInheritedMobility(world, leaf)).toBe('static');
  });

  it('accepts initial placement of a static entity without a diagnostic', async () => {
    const world = await sceneWorld();
    world
      .spawn(
        { component: Transform, data: { pos: [1, 2, 3] } },
        { component: Mobility, data: { kind: MobilityKindValue.static } },
      )
      .unwrap();
    world.update(1 / 60).unwrap();
    world.update(1 / 60).unwrap();
    expect(received).toEqual([]);
  });

  it('reports mobility-static-moved once per static entity whose Transform changes', async () => {
    const world = await sceneWorld();
    const moved = world
      .spawn(
        { component: Transform, data: {} },
        { component: Mobility, data: { kind: MobilityKindValue.static } },
      )
      .unwrap();
    const untouched = world
      .spawn(
        { component: Transform, data: {} },
        { component: Mobility, data: { kind: MobilityKindValue.static } },
      )
      .unwrap();
    world.update(1 / 60).unwrap();

    world.set(moved, Transform, { pos: [1, 0, 0] }).unwrap();
    world.update(1 / 60).unwrap();
    world.set(moved, Transform, { pos: [2, 0, 0] }).unwrap();
    world.update(1 / 60).unwrap();

    expect(received).toHaveLength(1);
    const [diagnostic] = received;
    expect(diagnostic).toMatchObject({
      code: 'mobility-static-moved',
      expected: expect.stringContaining("'static'"),
      hint: expect.stringContaining('movable'),
      detail: { entity: moved },
    });
    expect(diagnostic?.detail).not.toHaveProperty('sceneEntityRef');
    expect(received.some((d) => d.detail.entity === untouched)).toBe(false);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('keeps rendering input correct: the moved static entity still propagates', async () => {
    const world = await sceneWorld();
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: Mobility, data: { kind: MobilityKindValue.static } },
      )
      .unwrap();
    world.update(1 / 60).unwrap();
    world.set(entity, Transform, { pos: [5, 0, 0] }).unwrap();
    world.update(1 / 60).unwrap();
    const { GlobalTransform } = await import('../index');
    expect(world.get(entity, GlobalTransform).unwrap().world[12]).toBeCloseTo(5);
  });

  it('does not report movable, default, or undeclared entities that move', async () => {
    const world = await sceneWorld();
    const movable = world
      .spawn(
        { component: Transform, data: {} },
        { component: Mobility, data: { kind: MobilityKindValue.movable } },
      )
      .unwrap();
    const defaulted = world
      .spawn({ component: Transform, data: {} }, { component: Mobility, data: {} })
      .unwrap();
    const undeclared = world.spawn({ component: Transform, data: {} }).unwrap();
    world.update(1 / 60).unwrap();
    for (const entity of [movable, defaulted, undeclared]) {
      world.set(entity, Transform, { pos: [3, 0, 0] }).unwrap();
    }
    world.update(1 / 60).unwrap();
    expect(received).toEqual([]);
  });

  it('reports a static declaration added to an existing entity only after it moves', async () => {
    const world = await sceneWorld();
    const entity = world.spawn({ component: Transform, data: {} }).unwrap();
    world.update(1 / 60).unwrap();
    world.set(entity, Transform, { pos: [1, 0, 0] }).unwrap();
    world
      .addComponent(entity, { component: Mobility, data: { kind: MobilityKindValue.static } })
      .unwrap();
    world.update(1 / 60).unwrap();
    expect(received).toEqual([]);
    world.set(entity, Transform, { pos: [2, 0, 0] }).unwrap();
    world.update(1 / 60).unwrap();
    expect(received.map((d) => d.code)).toEqual(['mobility-static-moved']);
  });
});

import { World } from '@forgeax/engine-ecs';
import { Camera, MeshFilter, type Renderer, setActiveCamera } from '@forgeax/engine-render';
import { ChildOf, GlobalTransform, Name, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { createAppObservation } from '../observation';

describe('createAppObservation', () => {
  it('restores a game camera selected during observation, including immediately before release', () => {
    const world = new World();
    const spawn = () =>
      world.spawn({ component: Transform, data: {} }, { component: Camera, data: {} }).unwrap();
    const first = spawn();
    const second = spawn();
    setActiveCamera(world, first);
    const observation = createAppObservation(
      world,
      { bounds: () => undefined } as unknown as Renderer,
      { report: () => ({}) },
    );
    observation.camera.set({ position: [3, 4, 5] });
    setActiveCamera(world, second);
    observation.prepareFrame();
    observation.release();
    expect(observation.camera.get()).toMatchObject({ entity: second, control: 'game' });
    observation.camera.set({ position: [3, 4, 5] });
    setActiveCamera(world, first);
    observation.release();
    expect(observation.camera.get()).toMatchObject({ entity: first, control: 'game' });
  });
  it('uses the first authored camera when ActiveCamera is absent', () => {
    const world = new World();
    const camera = world
      .spawn({ component: Transform, data: { pos: [1, 2, 3] } }, { component: Camera, data: {} })
      .unwrap();

    const observation = createAppObservation(
      world,
      { bounds: () => undefined } as unknown as Renderer,
      { report: () => ({}) },
    );
    expect(observation.camera.get()).toMatchObject({ entity: camera });
  });

  it('controls the active camera without a raw handle and releases without editing it', () => {
    const world = new World();
    const camera = world
      .spawn({ component: Transform, data: { pos: [1, 2, 3] } }, { component: Camera, data: {} })
      .unwrap();
    const observation = createAppObservation(
      world,
      { bounds: () => undefined } as unknown as Renderer,
      { report: () => ({}) },
    );
    const controlled = observation.camera.set({ position: [8, 6, 8], target: [0, 0, 0] });
    expect(controlled).toMatchObject({ control: 'observer', transform: { pos: [8, 6, 8] } });
    expect(world.get(camera, Transform).unwrap().pos).toEqual(new Float32Array([1, 2, 3]));
    observation.release();
    expect(observation.camera.get()).toMatchObject({ entity: camera, control: 'game' });
    observation.camera.set({ position: [3, 4, 5] });
    observation.release();
    expect(observation.camera.get()).toMatchObject({ entity: camera, control: 'game' });
  });

  it('sets lens and exposure on the transient observer and restores authored camera state', () => {
    const world = new World();
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [1, 2, 3] } },
        { component: Camera, data: { fov: Math.PI / 3, aspect: 1.5, exposure: 1 } },
      )
      .unwrap();
    const observation = createAppObservation(
      world,
      { bounds: () => undefined } as unknown as Renderer,
      { report: () => ({}) },
    );
    const state = observation.camera.set({
      lens: { projection: 'orthographic', left: -4, right: 4, bottom: -3, top: 3 },
      exposure: { kind: 'manual', multiplier: 2 },
    }) as {
      control: string;
      lens: { projection: string; left: number };
      exposure: { kind: string; multiplier: number };
    };
    expect(state.control).toBe('observer');
    expect(state.lens).toMatchObject({ projection: 'orthographic', left: -4, right: 4 });
    expect(state.exposure).toEqual({ kind: 'manual', multiplier: 2 });
    expect(world.get(camera, Camera).unwrap().projection).toBe(0);
    expect(world.get(camera, Camera).unwrap().exposure).toBe(1);
    observation.release();
  });

  it('restores the camera active at acquisition, rather than at observation creation', () => {
    const world = new World();
    world.spawn({ component: Transform, data: {} }, { component: Camera, data: {} }).unwrap();
    const observation = createAppObservation(
      world,
      { bounds: () => undefined } as unknown as Renderer,
      { report: () => ({}) },
    );
    const latest = world
      .spawn({ component: Transform, data: {} }, { component: Camera, data: {} })
      .unwrap();
    setActiveCamera(world, latest);
    observation.camera.set({ position: [3, 4, 5] });
    observation.release();
    expect(observation.camera.get()).toMatchObject({ entity: latest });
  });

  it('focuses an exact name using its world position and rejects ambiguous names before mutation', async () => {
    const world = new World();
    const camera = world
      .spawn({ component: Transform, data: {} }, { component: Camera, data: {} })
      .unwrap();
    world
      .spawn(
        { component: Name, data: { value: 'Target' } },
        { component: Transform, data: { pos: [1, 2, 3] } },
        {
          component: GlobalTransform,
          data: { world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1] },
        },
      )
      .unwrap();
    const observation = createAppObservation(
      world,
      { bounds: () => undefined } as unknown as Renderer,
      { report: () => ({}) },
    );
    expect(await observation.focus({ name: 'Target', distance: 6 })).toMatchObject({
      transform: { pos: [10, 20, 36] },
    });
    observation.release();
    world
      .spawn({ component: Name, data: { value: 'Target' } }, { component: Transform, data: {} })
      .unwrap();
    await expect(observation.focus({ name: 'Target' })).rejects.toThrow(/ambiguous/);
    expect(observation.camera.get()).toMatchObject({ entity: camera, control: 'game' });
    await expect(observation.focus({ name: 'Missing' })).rejects.toThrow(/not-found/);
  });
});

it.each([
  0, 1,
])('frames projected subtree bounds in camera projection %s without editing the game camera', async (projection) => {
  const world = new World();
  const original = {
    fov: Math.PI / 3,
    aspect: 0.5,
    near: 0.1,
    far: 20,
    projection,
    left: -1,
    right: 1,
    bottom: -1,
    top: 1,
  };
  const camera = world
    .spawn({ component: Transform, data: {} }, { component: Camera, data: original })
    .unwrap();
  const parent = world
    .spawn({ component: Transform, data: {} }, { component: Name, data: { value: 'Palace' } })
    .unwrap();
  const child = world
    .spawn({ component: Transform, data: {} }, { component: ChildOf, data: { parent } })
    .unwrap();
  const min = [360, 12, 420] as const,
    max = [392, 28, 450] as const;
  const requested: number[] = [];
  const renderer = {
    bounds: async (w: World, entity: number) => {
      expect(w).toBe(world);
      requested.push(entity);
      return entity === child ? { min, max } : undefined;
    },
  } as unknown as Renderer;
  const observation = createAppObservation(world, renderer, { report: () => ({}) });
  const result = (await observation.focus({ name: 'Palace' })) as {
    entity: number;
    camera: typeof original;
    transform: { pos: [number, number, number] };
  };
  expect(requested).toContain(parent);
  expect(requested).toContain(child);
  expect(result.transform.pos[0]).toBeCloseTo(376);
  expect(result.transform.pos[1]).toBeCloseTo(20);
  const c = world.get(result.entity as never, Camera).unwrap(),
    p = result.transform.pos;
  for (const x of [min[0], max[0]])
    for (const y of [min[1], max[1]])
      for (const z of [min[2], max[2]]) {
        const depth = p[2] - z;
        expect(depth).toBeGreaterThan(c.near);
        expect(depth).toBeLessThan(c.far);
        if (projection === 0) {
          expect(Math.abs((x - p[0]) / (depth * Math.tan(c.fov / 2) * c.aspect))).toBeLessThan(1);
          expect(Math.abs((y - p[1]) / (depth * Math.tan(c.fov / 2)))).toBeLessThan(1);
        } else {
          expect(x - p[0]).toBeGreaterThan(c.left);
          expect(x - p[0]).toBeLessThan(c.right);
          expect(y - p[1]).toBeGreaterThan(c.bottom);
          expect(y - p[1]).toBeLessThan(c.top);
        }
      }
  observation.release();
  expect(world.get(camera, Camera).unwrap().far).toBe(20);
  expect(world.get(camera, Transform).unwrap().pos).toEqual(new Float32Array([0, 0, 0]));
});

it('rejects unknown mesh bounds before acquiring an observer camera', async () => {
  const world = new World();
  const camera = world
    .spawn({ component: Transform, data: {} }, { component: Camera, data: {} })
    .unwrap();
  world
    .spawn(
      { component: Transform, data: {} },
      { component: Name, data: { value: 'Pending' } },
      { component: MeshFilter, data: {} },
    )
    .unwrap();
  const observation = createAppObservation(
    world,
    { bounds: () => undefined } as unknown as Renderer,
    { report: () => ({}) },
  );
  await expect(observation.focus({ name: 'Pending' })).rejects.toThrow(/bounds-unavailable/);
  expect(observation.camera.get()).toMatchObject({ entity: camera, control: 'game' });
});

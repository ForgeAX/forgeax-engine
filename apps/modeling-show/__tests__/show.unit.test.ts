import { animationPlugin } from '@forgeax/engine/animation';
import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { createWorldContext, type EntityHandle, World } from '@forgeax/engine/ecs';
import { createPrimitiveMesh } from '@forgeax/engine/geometry';
import { Materials, MeshFilter, MeshRenderer, renderComponentsPlugin } from '@forgeax/engine/render';
import { defaultAssetDecoderContributions } from '@forgeax/engine/runtime';
import { Visibility, VisibilityStateValue } from '@forgeax/engine/render';
import { Name, scenePlugin, Transform } from '@forgeax/engine/scene';
import type { AssetHandle, MeshAsset } from '@forgeax/engine/types';
import { expect, it } from 'vitest';
import { createShow, orbitView, type ShowView, viewOf, viewPose } from '../assets/show/show.ts';

async function pairShow(subjectOptions: { readonly clean?: boolean } = {}) {
  const assets = new AssetRegistry();
  for (const { kind, decoder } of defaultAssetDecoderContributions) assets.installDecoder(kind as never, decoder);
  const world = new World({ assets });
  await createWorldContext(world, [renderComponentsPlugin(), scenePlugin(), animationPlugin()]);
  const mesh = assets.create(createPrimitiveMesh('cube').unwrap() as MeshAsset).unwrap();
  const slot = (assets.read(mesh).unwrap() as MeshAsset).materialSlots[0]?.slotName ?? 'Default';
  const cleanLook = assets.create(Materials.standard({ baseColor: [1, 0, 0, 1] })).unwrap() as AssetHandle<'material'>;
  const show = createShow(world, assets, {
    subjects: [
      {
        name: 'cube',
        meshes: [{ handle: mesh as AssetHandle<'mesh'>, name: 'cube' }],
        ...(subjectOptions.clean ? { clean: { [slot]: cleanLook } } : {}),
      },
    ],
    segments: [{ subject: 0, kind: 'turntable', seconds: 1 }],
  });
  const named = (name: string) => {
    for (const row of world.query({ read: [Name] }).unwrap()) if (row.get(Name).value === name) return row.entity;
    throw new Error(`${name} was not spawned`);
  };
  return { world, show, named, cleanLook };
}

it('round-trips a camera through its view and orbits within limits', () => {
  const view = viewOf([3, 2, 4], [0, 1, 0], [0, 0.5, 0]);
  const pose = viewPose(view, [0, 0.5, 0]);
  for (const [k, value] of [3, 2, 4].entries()) expect(pose.eye[k]).toBeCloseTo(value, 9);
  for (const [k, value] of [0, 1, 0].entries()) expect(pose.target[k]).toBeCloseTo(value, 9);
  const turned = orbitView(view, { dx: 100, dy: 1e6, pan: false, wheel: 2 }, [1, 6]);
  expect(turned.yaw).toBeCloseTo(view.yaw - 0.5, 9);
  expect(turned.pitch).toBe(1.5);
  expect(turned.distance).toBe(6);
  const panned = orbitView(view, { dx: 10, dy: 0, pan: true, wheel: 0 }, [1, 6]);
  expect(panned.yaw).toBe(view.yaw);
  expect(Math.hypot(...panned.pan.map((p, k) => p - (view.pan[k] as number)))).toBeGreaterThan(0);
});

it('a held view places the camera and the floor command hides the floor and discs', async () => {
  const { world, show, named } = await pairShow();
  show.command({ kind: 'pause' });
  world.update(0).unwrap();
  const rail = show.state();
  expect(rail.free).toBe(false);
  const held: ShowView = { yaw: Math.PI / 2, pitch: 0, distance: 5, pan: [0, 0, 0] };
  show.command({ kind: 'view', view: held });
  world.update(0).unwrap();
  const camera = named('show.camera');
  const eye = [...world.get(camera, Transform).unwrap().pos] as number[];
  expect(show.state()).toMatchObject({ free: true, view: held });
  expect(eye[0]).toBeCloseTo(5, 6);
  show.command({ kind: 'view' });
  world.update(0).unwrap();
  expect(show.state().free).toBe(false);
  show.command({ kind: 'floor', visible: false });
  world.update(0).unwrap();
  expect(show.state().floor).toBe(false);
  for (const name of ['show.floor', 'show.disc.cube']) {
    expect(world.get(named(name), Visibility).unwrap().state).toBe(VisibilityStateValue.hidden);
  }
  show.command({ kind: 'floor', visible: true });
  world.update(0).unwrap();
  expect(world.get(named('show.floor'), Visibility).unwrap().state).toBe(VisibilityStateValue.inherited);
  show.dispose();
});

it('the clean finish is the default and the weathered finish restores the Pack materials', async () => {
  const { world, show, cleanLook } = await pairShow({ clean: true });
  show.command({ kind: 'pause' });
  world.update(0).unwrap();
  let part = undefined as unknown as Parameters<typeof world.get>[0];
  for (const row of world.query({ read: [Name, MeshFilter] }).unwrap()) if (row.get(Name).value === 'cube') part = row.entity;
  expect(show.state().finish).toEqual({ mode: 'clean', available: true });
  expect([...world.get(part, MeshRenderer).unwrap().materials]).toEqual([cleanLook]);
  show.command({ kind: 'finish', mode: 'weathered' });
  world.update(0).unwrap();
  expect([...world.get(part, MeshRenderer).unwrap().materials]).not.toContain(cleanLook);
  show.command({ kind: 'finish', mode: 'clean' });
  world.update(0).unwrap();
  expect([...world.get(part, MeshRenderer).unwrap().materials]).toEqual([cleanLook]);
  show.dispose();
});

it('surface views replace or overlay each part and restore its own surface', async () => {
  const { world, show, named } = await pairShow();
  show.command({ kind: 'pause' });
  world.update(0).unwrap();
  let part = named('show.camera');
  for (const row of world.query({ read: [Name, MeshFilter] }).unwrap()) if (row.get(Name).value === 'cube') part = row.entity;
  const own = world.get(part, MeshFilter).unwrap().assetHandle;
  const ownMaterials = [...world.get(part, MeshRenderer).unwrap().materials];
  for (const mode of ['curvature', 'zebra'] as const) {
    show.command({ kind: 'analysis', mode });
    world.update(0).unwrap();
    expect(show.state().analysis).toEqual({ mode, done: 1, total: 1 });
    expect(world.get(part, MeshFilter).unwrap().assetHandle).not.toBe(own);
  }
  show.command({ kind: 'analysis', mode: 'edges' });
  world.update(0).unwrap();
  expect(world.get(part, MeshFilter).unwrap().assetHandle).toBe(own);
  expect(world.get(named('show.edges.cube'), Visibility).unwrap().state).toBe(VisibilityStateValue.inherited);
  show.command({ kind: 'analysis', mode: 'off' });
  world.update(0).unwrap();
  expect(world.get(part, MeshFilter).unwrap().assetHandle).toBe(own);
  expect([...world.get(part, MeshRenderer).unwrap().materials]).toEqual(ownMaterials);
  expect(world.get(named('show.edges.cube'), Visibility).unwrap().state).toBe(VisibilityStateValue.hidden);
  show.dispose();
});

it('explodes scene parts away from their authored positions', async () => {
  const assets = new AssetRegistry();
  for (const { kind, decoder } of defaultAssetDecoderContributions) assets.installDecoder(kind as never, decoder);
  const world = new World({ assets });
  await createWorldContext(world, [renderComponentsPlugin(), scenePlugin(), animationPlugin()]);
  const mesh = assets.create(createPrimitiveMesh('cube').unwrap() as MeshAsset).unwrap();
  const part = (x: number) => ({
    components: {
      Name: { value: `part${x}` },
      Transform: { pos: [x, 0.5, 0] },
      ChildOf: { parent: 'root' },
      MeshFilter: { assetHandle: mesh },
      MeshRenderer: { materials: [] },
    },
  });
  const scene = assets
    .create({
      kind: 'scene',
      entities: { root: { components: { Name: { value: 'root' }, Transform: {} } }, left: part(-2), right: part(2) },
    } as never)
    .unwrap() as unknown as AssetHandle<'scene'>;
  const show = createShow(world, assets, {
    subjects: [{ name: 'pair', scenes: [scene] }],
    segments: [{ subject: 0, kind: 'explode', seconds: 1 }],
  });
  let right: EntityHandle | undefined;
  for (const row of world.query({ read: [Name] }).unwrap()) if (row.get(Name).value === 'part2') right = row.entity;
  if (right === undefined) throw new Error('part2 was not spawned');
  const part2 = right;
  const pos = () => [...world.get(part2, Transform).unwrap().pos];
  show.command({ kind: 'pause' });
  show.command({ kind: 'seek', segment: 0, u: 0 });
  world.update(0).unwrap();
  expect(pos()).toEqual([2, 0.5, 0]);
  show.command({ kind: 'seek', segment: 0, u: 0.55 });
  world.update(0).unwrap();
  const [x, y, z] = pos() as [number, number, number];
  // Fully exploded: moved outward (+x for the right part) from its authored position.
  expect(x).toBeGreaterThan(2.1);
  expect(Math.hypot(x - 2, y - 0.5, z)).toBeGreaterThan(0.1);
  show.dispose();
});

async function pairScene() {
  const assets = new AssetRegistry();
  for (const { kind, decoder } of defaultAssetDecoderContributions) assets.installDecoder(kind as never, decoder);
  const world = new World({ assets });
  await createWorldContext(world, [renderComponentsPlugin(), scenePlugin(), animationPlugin()]);
  const mesh = assets.create(createPrimitiveMesh('cube').unwrap() as MeshAsset).unwrap();
  const part = (x: number) => ({
    components: {
      Name: { value: `part${x}` },
      Transform: { pos: [x, 0.5, 0] },
      ChildOf: { parent: 'root' },
      MeshFilter: { assetHandle: mesh },
      MeshRenderer: { materials: [] },
    },
  });
  const scene = assets
    .create({
      kind: 'scene',
      entities: { root: { components: { Name: { value: 'root' }, Transform: {} } }, left: part(-2), right: part(2) },
    } as never)
    .unwrap() as unknown as AssetHandle<'scene'>;
  const show = createShow(world, assets, {
    subjects: [{ name: 'pair', scenes: [scene] }],
    segments: [{ subject: 0, kind: 'turntable', seconds: 1 }],
  });
  const named = (name: string) => {
    for (const row of world.query({ read: [Name] }).unwrap()) if (row.get(Name).value === name) return row.entity;
    throw new Error(`${name} was not spawned`);
  };
  show.command({ kind: 'pause' });
  return { world, show, named };
}

it('reports each subject\'s parts and the common controls that apply to it', async () => {
  const single = await pairShow();
  expect(single.show.subjects().map((s) => ({ parts: s.parts, controls: s.controls.map((c) => c.kind) }))).toEqual([
    { parts: ['cube'], controls: ['camera', 'floor', 'shading'] },
  ]);
  single.show.dispose();
  const clean = await pairShow({ clean: true });
  expect(clean.show.subjects()[0]?.controls.map((c) => c.kind)).toContain('finish');
  clean.show.dispose();
  const pair = await pairScene();
  expect(pair.show.subjects()[0]).toMatchObject({ name: 'pair', parts: ['part-2', 'part2'] });
  expect(pair.show.subjects()[0]?.controls.map((c) => c.kind)).toEqual(['camera', 'floor', 'shading', 'parts']);
  pair.show.dispose();
});

it('hidden parts leave the stage and come back', async () => {
  const { world, show, named } = await pairScene();
  world.update(0).unwrap();
  const left = named('part-2');
  const right = named('part2');
  show.command({ kind: 'hide', subject: 0, parts: [0] });
  world.update(0).unwrap();
  expect(world.get(left, Visibility).unwrap().state).toBe(VisibilityStateValue.hidden);
  expect(world.get(right, Visibility).unwrap().state).toBe(VisibilityStateValue.inherited);
  expect(show.state().hidden).toEqual([0]);
  show.command({ kind: 'hide', subject: 0, parts: [] });
  world.update(0).unwrap();
  expect(world.get(left, Visibility).unwrap().state).toBe(VisibilityStateValue.inherited);
  show.dispose();
});

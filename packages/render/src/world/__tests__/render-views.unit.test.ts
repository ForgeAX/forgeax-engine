import { readComponentMutationEpoch } from '@forgeax/engine-ecs/projection';
import { describe, expect, it, vi } from 'vitest';
import type { CameraSnapshot } from '../../render-contract';
import type { RenderTarget } from '../../targets/contracts';
import {
  RenderView,
  RenderViews,
  ViewChannelsValue,
  ViewEyeValue,
  ViewRecorder,
} from '../render-views';
import { createRenderWorld } from '../render-world';

function camera(entityKey: number, view: Partial<NonNullable<CameraSnapshot['view']>> = {}) {
  return {
    entityKey,
    historyVersion: 1,
    view: {
      viewport: new Float32Array([0, 0, 1, 1]),
      order: 0,
      resolutionScale: 1,
      maxRenderShortSide: 0,
      updateInterval: 1,
      enabled: true,
      ...view,
    },
  } as unknown as CameraSnapshot;
}

function fixture() {
  const world = createRenderWorld();
  const views = new RenderViews(world);
  const sync = (cameras: readonly CameraSnapshot[], captures: readonly CameraSnapshot[] = []) =>
    views.sync({ cameras, captures, attachment: () => 'world-a' });
  const spies = {
    spawn: vi.spyOn(world, 'spawn'),
    despawn: vi.spyOn(world, 'despawn'),
    set: vi.spyOn(world, 'set'),
  };
  const reset = () => {
    for (const spy of Object.values(spies)) spy.mockClear();
  };
  return { world, views, sync, spies, reset };
}

describe('RenderViews', () => {
  it('applies a host budget to selected display snapshots without changing source cameras', () => {
    const { world, views } = fixture();
    const { view: _view, ...display } = camera(7);
    const cameras = Object.freeze([Object.freeze(display)]);
    const sync = (maxRenderShortSide?: number) =>
      views.sync({ cameras, captures: [], attachment: () => 'world-a', maxRenderShortSide });
    sync();
    expect(views.displayCount).toBe(0);
    sync(720);
    expect(views.displayCount).toBe(1);
    const entity = views.ordered[0];
    if (entity === undefined) throw Error('expected implicit display view');
    expect(world.get(entity, RenderView).unwrap()).toMatchObject({
      camera: 7,
      maxRenderShortSide: 720,
      resolutionScale: 1,
    });
    expect(display).not.toHaveProperty('view');
    sync(0);
    expect(views.displayCount).toBe(0);
  });

  it('keeps stricter authored budgets and target dimensions independent of the host budget', () => {
    const { world, views } = fixture();
    const target = { descriptor: { width: 2048, height: 1024 } } as unknown as RenderTarget;
    const cameras = [camera(1, { maxRenderShortSide: 480 }), camera(2), { ...camera(3), target }];
    views.sync({ cameras, captures: [], attachment: () => 'world-a', maxRenderShortSide: 720 });
    expect(
      views.ordered.map((entity) => world.get(entity, RenderView).unwrap().maxRenderShortSide),
    ).toEqual([480, 720, 0]);
    expect(cameras[1]?.view?.maxRenderShortSide).toBe(0);
  });

  it('carries a changed short-side cap into the existing Render World view', () => {
    const { world, views, sync, spies, reset } = fixture();
    sync([camera(1, { maxRenderShortSide: 720 })]);
    const entity = views.ordered[0];
    if (entity === undefined) throw Error('expected declared view');
    expect(world.get(entity, RenderView).unwrap().maxRenderShortSide).toBe(720);
    reset();
    sync([camera(1, { maxRenderShortSide: 720 })]);
    expect(spies.set).not.toHaveBeenCalled();
    sync([camera(1, { maxRenderShortSide: 1080 })]);
    expect(spies.set).toHaveBeenCalledTimes(1);
    expect(views.ordered[0]).toBe(entity);
    expect(world.get(entity, RenderView).unwrap().maxRenderShortSide).toBe(1080);
  });

  it('spawns one entity per CameraView and composes them by order', () => {
    const { world, views, sync } = fixture();
    sync([camera(7, { order: 2 }), camera(3, { order: 1 }), { entityKey: 9 } as CameraSnapshot]);
    expect(views.size).toBe(2);
    expect(views.enabledCount).toBe(2);
    expect(views.ordered.map((entity) => world.get(entity, RenderView).unwrap().camera)).toEqual([
      3, 7,
    ]);
  });

  it('writes nothing on a steady frame and keeps every view entity', () => {
    const { world, views, sync, spies, reset } = fixture();
    const cameras = [camera(1), camera(2, { order: 1 })];
    sync(cameras);
    const ordered = views.ordered;
    const entities = [...ordered];
    const structure = world.getStructureEpoch();
    const mutation = readComponentMutationEpoch(world, RenderView);
    reset();
    for (let frame = 0; frame < 8; frame++) sync([camera(1), camera(2, { order: 1 })]);
    expect(spies.spawn).not.toHaveBeenCalled();
    expect(spies.despawn).not.toHaveBeenCalled();
    expect(spies.set).not.toHaveBeenCalled();
    expect(world.getStructureEpoch()).toBe(structure);
    expect(readComponentMutationEpoch(world, RenderView)).toBe(mutation);
    expect(views.ordered).toBe(ordered);
    expect(views.ordered).toEqual(entities);
  });

  it('adds and removes a camera with O(1) structural work and leaves other views intact', () => {
    const { world, views, sync, spies, reset } = fixture();
    const many = Array.from({ length: 16 }, (_, index) => camera(index + 1, { order: index }));
    sync(many);
    const before = new Map(
      views.ordered.map((entity) => [world.get(entity, RenderView).unwrap().camera, entity]),
    );
    reset();
    sync([...many, camera(100, { order: 99 })]);
    expect(spies.spawn).toHaveBeenCalledTimes(1);
    expect(spies.despawn).not.toHaveBeenCalled();
    expect(spies.set).not.toHaveBeenCalled();
    for (const [key, entity] of before) {
      expect(views.ordered).toContain(entity);
      expect(world.get(entity, RenderView).unwrap().camera).toBe(key);
    }
    reset();
    sync(many.filter((_, index) => index !== 5));
    expect(spies.spawn).not.toHaveBeenCalled();
    expect(spies.despawn).toHaveBeenCalledTimes(2);
    expect(spies.set).not.toHaveBeenCalled();
    expect(views.size).toBe(15);
    expect(views.ordered).not.toContain(before.get(6));
    for (const [key, entity] of before) if (key !== 6) expect(views.ordered).toContain(entity);
  });

  it('rewrites only a changed view and retires its recorder when disabled', () => {
    const { world, views, sync, spies, reset } = fixture();
    sync([camera(1), camera(2, { order: 1 })]);
    const [first, second] = views.ordered;
    if (first === undefined || second === undefined) throw new Error('expected two views');
    const released = vi.fn();
    const state = world.allocUniqueRef('ViewRecorder', {}, released);
    world.addComponent(second, { component: ViewRecorder, data: { state } }).unwrap();
    reset();
    sync([camera(1), camera(2, { order: 1, enabled: false })]);
    expect(spies.set).toHaveBeenCalledTimes(1);
    expect(released).toHaveBeenCalledTimes(1);
    expect(world.hasComponent(second, ViewRecorder)).toBe(false);
    expect(views.enabledCount).toBe(1);
    expect(views.ordered).toEqual([first, second]);
  });

  it('derives two stereo eyes and their anaglyph channels', () => {
    const { world, views, sync } = fixture();
    const stereo = {
      ...camera(4, { viewport: new Float32Array([0, 0, 1, 0.5]) }),
      stereo: { eyeSeparation: 0.06, convergence: 10, layout: 'anaglyph', swapEyes: false },
    } as unknown as CameraSnapshot;
    sync([stereo]);
    const rows = views.ordered.map((entity) => world.get(entity, RenderView).unwrap());
    expect(rows.map((row) => [row.eye, row.channels])).toEqual([
      [ViewEyeValue.left, ViewChannelsValue.red],
      [ViewEyeValue.right, ViewChannelsValue.cyan],
    ]);
    expect(Array.from(rows[0]?.viewport ?? [])).toEqual([0, 0, 1, 0.5]);
  });

  it('holds a target reference only while a view names it', () => {
    const { world, views, sync } = fixture();
    const target = { kind: 'render-target' } as unknown as RenderTarget;
    sync([{ ...camera(5), target } as CameraSnapshot]);
    const [entity] = views.ordered;
    if (entity === undefined) throw new Error('expected one view');
    const handle = world.get(entity, RenderView).unwrap().target;
    expect(views.target({ target: handle })).toBe(target);
    sync([camera(5)]);
    expect(world.get(entity, RenderView).unwrap().target).toBe(0);
    expect(views.target({ target: handle })).toBeUndefined();
  });

  it('keeps its target reference when other facts of the view change', () => {
    const { world, views, sync } = fixture();
    const target = { kind: 'render-target' } as unknown as RenderTarget;
    const capture = { entityKey: 4, historyVersion: 1, target } as unknown as CameraSnapshot;
    sync([], [capture]);
    const [entity] = views.ordered;
    if (entity === undefined) throw new Error('expected one view');
    const handle = world.get(entity, RenderView).unwrap().target;
    sync([], [{ ...capture, historyVersion: 2 } as CameraSnapshot]);
    const row = world.get(entity, RenderView).unwrap();
    expect(row.viewGeneration).toBe(2);
    expect(row.target).toBe(handle);
    expect(views.target(row)).toBe(target);
    sync([], []);
    expect(views.target({ target: handle })).toBeUndefined();
  });

  it('rejects a CameraView without camera identity before writing', () => {
    const { views, spies, sync } = fixture();
    expect(() => sync([{ view: camera(1).view } as CameraSnapshot])).toThrow(/entityKey/);
    expect(spies.spawn).not.toHaveBeenCalled();
    expect(views.size).toBe(0);
  });

  it('declares an auxiliary target camera as a capture view recorded before displays', () => {
    const { world, views, sync, spies, reset } = fixture();
    const target = { kind: 'render-target' } as unknown as RenderTarget;
    const capture = { entityKey: 4, historyVersion: 1, target } as unknown as CameraSnapshot;
    sync([camera(7, { order: -5 })], [capture]);
    expect([views.displayCount, views.captureCount, views.enabledCount]).toEqual([1, 1, 1]);
    const rows = views.ordered.map((entity) => world.get(entity, RenderView).unwrap());
    expect(rows.map((row) => [row.capture, row.camera])).toEqual([
      [true, 4],
      [false, 7],
    ]);
    expect(views.target(rows[0] as { target: number })).toBe(target);
    reset();
    sync([camera(7, { order: -5 })], [capture]);
    expect(spies.spawn).not.toHaveBeenCalled();
    expect(spies.set).not.toHaveBeenCalled();
    sync([camera(7, { order: -5 })]);
    expect(spies.despawn).toHaveBeenCalledTimes(1);
    expect([views.displayCount, views.captureCount]).toEqual([1, 0]);
  });
});

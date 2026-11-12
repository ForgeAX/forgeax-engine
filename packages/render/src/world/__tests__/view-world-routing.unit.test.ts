import { World } from '@forgeax/engine-ecs';
import { expect, it } from 'vitest';
import type { ExtractedFrame } from '../../render-system-extract';
import { canonicalizeWorldComposition } from '../../render-system-projections';
import { RenderViewFrameSource, RenderViewInput } from '../render-views';
import { createRenderWorld } from '../render-world';
import {
  stagedViewInputs,
  stageViewFrame,
  viewFrameOf,
  viewFrameScopes,
} from '../view-frame-systems';
import {
  adoptViewWorldSource,
  attachViewWorldSource,
  ViewWorldRouting,
  ViewWorldSource,
} from '../view-world-routing';

it('retains canonical membership and roles while applying reordered and duplicate source membership', () => {
  const a = new World();
  const b = new World();
  const routing = new ViewWorldRouting();
  const owners = { cameraOwner: 0, resourceOwner: 1, cameraEntityKey: 5 };
  expect(routing.adopt([b, a], owners)).toBe(true);
  const prior = routing.project(undefined);
  expect(prior).toEqual(canonicalizeWorldComposition([b, a], owners, undefined));
  expect(routing.adopt([b, a], owners)).toBe(false);
  expect(routing.project(undefined)).toBe(prior);
  expect(routing.adopt([a, b], { cameraOwner: 1, resourceOwner: 0, cameraEntityKey: 5 })).toBe(
    false,
  );
  expect(routing.project(undefined)).toBe(prior);
  expect(routing.adopt([a, a, b], owners)).toBe(true);
  expect(routing.project(undefined)).toEqual(
    canonicalizeWorldComposition([a, a, b], owners, undefined),
  );
  expect(prior.worlds).toHaveLength(2);
  expect(routing.adopt([], { cameraOwner: 0, resourceOwner: 0 })).toBe(true);
  expect(Object.isFrozen(routing.project(undefined).worlds)).toBe(true);
  const empty = new ViewWorldRouting().project(undefined);
  expect(Object.isFrozen(empty)).toBe(true);
  expect(Object.isFrozen(empty.owners)).toBe(true);
});

it('publishes changed routing without releasing its managed handle or reporting stable frames changed', () => {
  const world = new World();
  const entity = world.spawn().unwrap();
  attachViewWorldSource(world, entity);
  const changed = world.query({ read: [ViewWorldSource], changed: [ViewWorldSource] }).unwrap();
  expect([...changed]).toHaveLength(1);
  const source = new World();
  const opts = { cameraOwner: 0, resourceOwner: 0 };
  const routing = adoptViewWorldSource(world, entity, [source], opts);
  expect([...changed]).toHaveLength(1);
  expect(adoptViewWorldSource(world, entity, [source], opts)).toBe(routing);
  expect([...changed]).toHaveLength(0);
  adoptViewWorldSource(world, entity, [source], { ...opts, cameraEntityKey: 12 });
  expect([...changed]).toHaveLength(1);
  expect(adoptViewWorldSource(world, entity, [source], opts)).toBe(routing);
  expect([...changed]).toHaveLength(1);
});

it('adopts inputs once per frame while keeping held prior frame projections detached', () => {
  const world = createRenderWorld();
  const source = new RenderViewFrameSource({ canvas: { width: 8, height: 8 } });
  world.insertResource(RenderViewInput, source);
  const entity = world.spawn().unwrap();
  const a = new World();
  const b = new World();
  const opts = { cameraOwner: 0, resourceOwner: 0 };
  source.stage([], [], [a], opts, undefined, undefined);
  stageViewFrame(world, entity, opts);
  const staged = viewFrameOf(world, entity);
  if (staged === undefined) throw new Error('missing staged view');
  const frame = { cameras: [] } as unknown as ExtractedFrame;
  staged.result = { ok: true, value: frame };
  const prior = stagedViewInputs(world, staged);
  expect(stagedViewInputs(world, staged)).toBe(prior);
  source.stage([], [], [b], opts, undefined, undefined);
  stageViewFrame(world, entity, opts);
  staged.result = { ok: true, value: frame };
  const next = stagedViewInputs(world, staged);
  expect(next).not.toBe(prior);
  expect(next.composition.worlds).toEqual([b]);
  expect(prior.composition.worlds).toEqual([a]);
  // Borrowed records are never admitted to the private adoption capability.
  const borrowed = { ...staged };
  expect(viewFrameScopes(world, borrowed).composition.worlds).toEqual([b]);
  source.worlds = [a];
  expect(viewFrameScopes(world, borrowed).composition.worlds).toEqual([a]);
});

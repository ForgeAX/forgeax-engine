import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import type { RenderBundle } from '@forgeax/engine-rhi';
import { expect, it } from 'vitest';
import { livePhysical, RetainedRasterEncodes } from '../gpu-driven/retained-raster-encode';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

const group = {};
const pipeline = {};
const mesh = {};
const rasterClass = {};
const bundle = {} as RenderBundle;
const material = () => ({ group, offset: 256 });
const owners = () => ({ pipeline, mesh });
const live = (vertex: object = {}) => ({ meshBinding: { vertex, index: undefined } });

function recordRun(encodes: RetainedRasterEncodes, key: object, lives: object[]) {
  const encode = encodes.begin(key, ['view'], material, owners);
  const run = encode.record(lives, 0, lives.length, livePhysical);
  run.materials.set(3, material());
  run.classes.set(rasterClass, owners());
  run.bundle = bundle;
  run.draws = lives.length;
  encodes.finish(key, ['view'], encode);
}

it('replays a run only when owners, buffers and resolved groups all match', () => {
  const encodes = new RetainedRasterEncodes();
  const key = {};
  const lives = [live(), live()];
  encodes.beginFrame();
  recordRun(encodes, key, lives);
  const same = encodes.begin(key, ['view'], material, owners);
  expect(same.reuse(lives, 0, 2, livePhysical)?.bundle).toBe(bundle);
  const edited = encodes.begin(key, ['view'], material, owners);
  expect(edited.reuse([lives[0] as object, live()], 0, 2, livePhysical)).toBeUndefined();
  const moved = encodes.begin(key, ['view'], () => ({ group, offset: 512 }), owners);
  expect(moved.reuse(lives, 0, 2, livePhysical)).toBeUndefined();
  const recompiled = encodes.begin(key, ['view'], material, () => ({ pipeline: {}, mesh }));
  expect(recompiled.reuse(lives, 0, 2, livePhysical)).toBeUndefined();
  const otherView = encodes.begin(key, ['other'], material, owners);
  expect(otherView.reuse(lives, 0, 2, livePhysical)).toBeUndefined();
});

it('never replays a run with per-frame Skin inputs', () => {
  const encodes = new RetainedRasterEncodes();
  const key = {};
  const lives = [live()];
  const encode = encodes.begin(key, [], material, owners);
  encode.record(lives, 0, 1, livePhysical).draws = Number.NaN;
  encodes.finish(key, [], encode);
  expect(encodes.begin(key, [], material, owners).reuse(lives, 0, 1, livePhysical)).toBeUndefined();
});

it('releases runs that a frame and its successor did not encode', async () => {
  const encodes = new RetainedRasterEncodes();
  const key = {};
  let lives: object[] | undefined = [live()];
  const released = new WeakRef(lives[0] as object);
  encodes.beginFrame();
  recordRun(encodes, key, lives);
  lives = undefined;
  encodes.beginFrame();
  expect(encodes.size).toBe(1);
  encodes.beginFrame();
  expect(encodes.size).toBe(0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  gc();
  expect(released.deref()).toBeUndefined();
});

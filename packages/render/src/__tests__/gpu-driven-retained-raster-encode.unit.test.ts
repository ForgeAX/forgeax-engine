import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import type { BindGroup, RenderBundle, RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { expect, it, vi } from 'vitest';
import type { ProjectedRasterClass } from '../gpu-driven/production-raster-classes';
import { IndirectPassBindings } from '../gpu-driven/production-raster-encode';
import {
  classOwner,
  livePhysical,
  RetainedRasterEncodes,
  runFacts,
} from '../gpu-driven/retained-raster-encode';

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
  recordRun(encodes, key, lives);
  const edited = encodes.begin(key, ['view'], material, owners);
  expect(edited.reuse([lives[0] as object, live()], 0, 2, livePhysical)).toBeUndefined();
  recordRun(encodes, key, lives);
  const moved = encodes.begin(key, ['view'], () => ({ group, offset: 512 }), owners);
  expect(moved.reuse(lives, 0, 2, livePhysical)).toBeUndefined();
  recordRun(encodes, key, lives);
  const recompiled = encodes.begin(key, ['view'], material, () => ({ pipeline: {}, mesh }));
  expect(recompiled.reuse(lives, 0, 2, livePhysical)).toBeUndefined();
  recordRun(encodes, key, lives);
  const otherView = encodes.begin(key, ['other'], material, owners);
  expect(otherView.reuse(lives, 0, 2, livePhysical)).toBeUndefined();
});

it('retains Skin commands when their current pass and physical owners match', () => {
  const encodes = new RetainedRasterEncodes();
  const key = {};
  const lives = [live()];
  const cls = { deformation: 'skin' } as ProjectedRasterClass;
  const encode = encodes.begin(key, ['skin-offsets'], material, owners);
  const run = encode.record(lives, 0, 1, livePhysical);
  const bindings = new IndirectPassBindings(
    {} as RhiRenderPassEncoder,
    group as BindGroup,
    undefined,
    undefined,
  );
  bindings.recordRun(run);
  bindings.observeRunClass(cls, pipeline as never, mesh as BindGroup);
  bindings.countRunDraw();
  run.bundle = bundle;
  expect(run.draws).toBe(1);
  encodes.finish(key, ['skin-offsets'], encode);
  expect(
    encodes.begin(key, ['skin-offsets'], material, owners).reuse(lives, 0, 1, livePhysical)?.bundle,
  ).toBe(bundle);
  expect(
    encodes.begin(key, ['changed-skin-offsets'], material, owners).reuse(lives, 0, 1, livePhysical),
  ).toBeUndefined();
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

it('rejects changed physical buffers on the same live owner and preserves the recorded snapshot', () => {
  const encodes = new RetainedRasterEncodes();
  const key = {},
    owner = live();
  const encode = encodes.begin(key, ['view'], material, owners);
  const block = encode.record([owner], 0, 1, livePhysical);
  encodes.finish(key, ['view'], encode);
  const before = [...block.physical];
  owner.meshBinding.vertex = {};
  const changed = encodes.begin(key, ['view'], material, owners);
  expect(changed.reuse([owner], 0, 1, livePhysical)).toBeUndefined();
  expect(block.physical).toEqual(before);
});

it('rechecks in-place material slot remapping and pass membership before replay', () => {
  const resource = {};
  const owner = {
    ...live(),
    materialBindingClass: 'main',
    batch: { key: { materialSlot: 7 }, binding: { material: resource } },
  };
  const slots = new Map([[resource, new Map([['main', 2]])]]);
  const selected = new Set([2]);
  const facts = runFacts(() => true, slots, selected);
  const encodes = new RetainedRasterEncodes(),
    key = {};
  const seed = () => {
    const encode = encodes.begin(key, ['view'], material, owners);
    const block = encode.record([owner], 0, 1, facts);
    encodes.finish(key, ['view'], encode);
    return block;
  };
  const block = seed();
  expect(block.physical).toEqual([owner.meshBinding.vertex, undefined, 2]);
  selected.clear();
  expect(
    encodes.begin(key, ['view'], material, owners).reuse([owner], 0, 1, facts),
  ).toBeUndefined();
  expect(block.physical[2]).toBe(2);
  selected.add(2);
  seed();
  slots.get(resource)?.set('main', 3);
  selected.add(3);
  expect(
    encodes.begin(key, ['view'], material, owners).reuse([owner], 0, 1, facts),
  ).toBeUndefined();
});

it.each([
  'match',
  'mismatch',
  'throw',
] as const)('resolves owners once across retained runs after %s', (mode) => {
  const encodes = new RetainedRasterEncodes(),
    key = {},
    lives = [live(), live()];
  const oldGroup = {},
    nextGroup = {};
  const initial = encodes.begin(key, ['view'], material, owners);
  const first = initial.record(lives, 0, 1, livePhysical);
  const second = initial.record(lives, 1, 2, livePhysical);
  const old = { group: oldGroup, offset: 0 },
    next = { group: nextGroup, offset: 0 };
  first.materials.set(1, old);
  first.materials.set(2, mode === 'mismatch' ? old : next);
  second.materials.set(1, old);
  second.materials.set(2, next);
  second.materials.set(3, next);
  encodes.finish(key, ['view'], initial);
  let throws = mode === 'throw';
  const resolve = vi.fn((slot: number) => {
    if (slot === 2 && throws) {
      throws = false;
      throw new Error('resolve failed');
    }
    return slot === 1 ? old : next;
  });
  const encode = encodes.begin(key, ['view'], resolve, owners);
  if (mode === 'throw')
    expect(() => encode.reuse(lives, 0, 1, livePhysical)).toThrow('resolve failed');
  else
    expect(encode.reuse(lives, 0, 1, livePhysical)).toBe(mode === 'mismatch' ? undefined : first);
  expect(encode.reuse(lives, 1, 2, livePhysical)).toBe(second);
  expect(resolve.mock.calls.map(([slot]) => slot)).toEqual(
    mode === 'throw' ? [1, 2, 2, 3] : [1, 2, 3],
  );
  expect(first.materials.get(2)).toBe(mode === 'mismatch' ? old : next);
});

it('preserves prefix memoization when an owner callback reenters the same encode', () => {
  const encodes = new RetainedRasterEncodes(),
    key = {},
    lives = [live(), live()];
  const initial = encodes.begin(key, ['view'], material, owners);
  const first = initial.record(lives, 0, 1, livePhysical),
    second = initial.record(lives, 1, 2, livePhysical);
  const value = material();
  first.materials.set(1, value);
  first.materials.set(2, value);
  second.materials.set(1, value);
  second.materials.set(3, value);
  encodes.finish(key, ['view'], initial);
  let nested: unknown;
  const resolve = vi.fn((slot: number) => {
    if (slot === 2) nested = encode.reuse(lives, 1, 2, livePhysical);
    return value;
  });
  const encode = encodes.begin(key, ['view'], resolve, owners);
  expect(encode.reuse(lives, 0, 1, livePhysical)).toBe(first);
  expect(nested).toBe(second);
  expect(resolve.mock.calls.map(([slot]) => slot)).toEqual([1, 2, 3]);
});

it.each([
  'material',
  'class',
] as const)('memoizes a missing %s owner across rejected runs', (kind) => {
  const encodes = new RetainedRasterEncodes(),
    key = {},
    lives = [live(), live()];
  const initial = encodes.begin(key, ['view'], material, owners);
  for (let index = 0; index < 2; index++) {
    const block = initial.record(lives, index, index + 1, livePhysical);
    if (kind === 'material') block.materials.set(3, material());
    else block.classes.set(rasterClass, owners());
  }
  encodes.finish(key, ['view'], initial);
  const missing = vi.fn(() => undefined);
  const encode = encodes.begin(
    key,
    ['view'],
    kind === 'material' ? missing : material,
    kind === 'class' ? missing : owners,
  );
  expect(encode.reuse(lives, 0, 1, livePhysical)).toBeUndefined();
  expect(encode.reuse(lives, 1, 2, livePhysical)).toBeUndefined();
  expect(missing).toHaveBeenCalledTimes(1);
});

it('resolves a new class once after the first fully checked run', () => {
  const encodes = new RetainedRasterEncodes(),
    key = {},
    lives = [live(), live()];
  const initial = encodes.begin(key, ['view'], material, owners),
    extra = {};
  const first = initial.record(lives, 0, 1, livePhysical),
    second = initial.record(lives, 1, 2, livePhysical);
  first.classes.set(rasterClass, owners());
  second.classes.set(rasterClass, owners());
  second.classes.set(extra, owners());
  encodes.finish(key, ['view'], initial);
  const resolve = vi.fn(owners);
  const encode = encodes.begin(key, ['view'], material, resolve);
  expect(encode.reuse(lives, 0, 1, livePhysical)).toBe(first);
  expect(encode.reuse(lives, 1, 2, livePhysical)).toBe(second);
  expect(encode.reuse(lives, 1, 2, livePhysical)).toBe(second);
  expect(resolve.mock.calls).toHaveLength(2);
});

it('compares the complete ordered fact stream with Object.is and rejects a changed fact count', () => {
  const encodes = new RetainedRasterEncodes(),
    key = {},
    lives = [live(), live()];
  let facts: unknown[] = [Number.NaN, 0];
  let reads = 0;
  const read = (_owner: object, consume: (value: unknown) => void) => {
    reads++;
    for (const fact of facts) consume(fact);
  };
  const seed = encodes.begin(key, ['view'], material, owners);
  const block = seed.record(lives, 0, 2, read);
  encodes.finish(key, ['view'], seed);
  const same = encodes.begin(key, ['view'], material, owners);
  expect(same.reuse(lives, 0, 2, read)).toBe(block);
  encodes.finish(key, ['view'], same);
  facts = [Number.NaN, -0];
  reads = 0;
  const changed = encodes.begin(key, ['view'], material, owners);
  expect(changed.reuse(lives, 0, 2, read)).toBeUndefined();
  expect(reads).toBe(2);
  encodes.finish(key, ['view'], same);
  facts = [Number.NaN, 0, undefined];
  expect(encodes.begin(key, ['view'], material, owners).reuse(lives, 0, 2, read)).toBeUndefined();
  expect(block.physical).toEqual([Number.NaN, 0, Number.NaN, 0]);
});

it('publishes independent current raster owner facts without retaining a prior wrapper', () => {
  const first = classOwner({ ok: true, value: pipeline }, mesh);
  const repeated = classOwner({ ok: true, value: pipeline }, mesh);
  expect(repeated).toEqual(first);
  expect(repeated).not.toBe(first);
  const nextPipeline = {};
  expect(classOwner({ ok: true, value: nextPipeline }, mesh)).toEqual({
    pipeline: nextPipeline,
    mesh,
  });
  expect(first).toEqual({ pipeline, mesh });
  expect(classOwner({ ok: false }, mesh)).toBeUndefined();
  expect(classOwner({ ok: true, value: pipeline }, undefined)).toBeUndefined();
});

it('preserves pipeline getter reads and failures before publishing owner facts', () => {
  const values = [{}, {}, {}];
  let reads = 0;
  const result = classOwner(
    {
      ok: true,
      get value() {
        return values[reads++];
      },
    },
    mesh,
  );
  expect(reads).toBe(3);
  expect(result?.pipeline).toBe(values[2]);
  const fault = new Error('pipeline value failed');
  const first = classOwner({ ok: true, value: pipeline }, mesh);
  expect(() =>
    classOwner(
      {
        ok: true,
        get value() {
          throw fault;
        },
      },
      mesh,
    ),
  ).toThrow(fault);
  expect(first).toEqual({ pipeline, mesh });
});

it('preserves a raw pipeline getter changing to undefined on its final read', () => {
  let reads = 0;
  const result = classOwner(
    {
      ok: true,
      get value() {
        return ++reads < 3 ? pipeline : undefined;
      },
    },
    mesh,
  );
  expect(reads).toBe(3);
  expect(result).toEqual({ pipeline: undefined, mesh });
});

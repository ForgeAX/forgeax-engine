import { mat4 } from '@forgeax/engine-math';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { SkinTasks } from '../record/skin-tasks';
import { skinTaskFixture } from './skin-task-fixture';

it('poses only actual capsule demand and reuses task storage across absent/empty/restored definitions', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const capsules = {
    joints: new Uint16Array([0]),
    shapes: new Float32Array([0, 0, 0, 0, 1, 0, 0.1]),
  };
  const f = skinTaskFixture(1, capsules),
    tasks = new SkinTasks(device, true);
  const allocate = vi.spyOn(device, 'createBuffer'),
    upload = vi.spyOn(device.queue, 'writeBuffer');
  try {
    tasks.begin(f.frame);
    const ready = tasks.capsules(f.first);
    if (ready.status !== 'ready') throw new Error('Expected actual world-space capsules');
    expect(Array.from(ready.capsules).slice(0, 7)).toEqual([3, 0, 0, expect.closeTo(0.1), 3, 1, 0]);
    expect(tasks.capsules(f.first)).toBe(ready);
    const storage = ready.capsules.buffer;
    await tasks.complete();
    await f.frames.submitFrame(f.frame, Promise.resolve(), true);
    for (const [definition, status] of [
      [undefined, 'no-shadow-capsules'],
      [{ joints: new Uint16Array(), shapes: new Float32Array() }, 'no-shadow-capsules'],
      [capsules, 'ready'],
    ] as const) {
      f.skin.skeletonChanged(0, 7, {
        kind: 'skeleton',
        jointCount: 1,
        inverseBindMatrices: mat4.identity(mat4.create()),
        ...(definition === undefined ? {} : { shadowCapsules: definition }),
      });
      f.matrix[12] = 7;
      f.skin.joint(0, 19, f.matrix);
      const frame = f.frames.prepareFrame(f.scene.slotsSnapshot());
      if (frame === undefined) throw new Error('Missing fixed capsule frame');
      tasks.begin(frame);
      const result = tasks.capsules(f.first);
      expect(result.status).toBe(status);
      if (result.status === 'ready') {
        expect(result.capsules.buffer).toBe(storage);
        expect(result.capsules[0]).toBe(7);
      }
      await tasks.complete();
      await f.frames.submitFrame(frame, Promise.resolve(), false);
    }
    expect(allocate).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  } finally {
    await tasks.dispose();
    f.dispose();
  }
});

it('poses capsule endpoints through jointWorld times inverseBind and scales the radius', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const capsules = {
    joints: new Uint16Array([1]),
    shapes: new Float32Array([0, 1, 0, 0, 2, 0, 0.25]),
  };
  const f = skinTaskFixture(2, capsules),
    tasks = new SkinTasks(device, true);
  try {
    f.frames.discardFrame();
    const inverse = new Float32Array(32);
    inverse.set(mat4.identity(mat4.create()));
    const second = mat4.identity(mat4.create());
    second[13] = -1;
    inverse.set(second, 16);
    f.skin.skeletonChanged(0, 7, {
      kind: 'skeleton',
      jointCount: 2,
      inverseBindMatrices: inverse,
      shadowCapsules: capsules,
    });
    const world = mat4.identity(mat4.create());
    world[0] = 2;
    world[5] = 2;
    world[10] = 2;
    world[12] = 3;
    f.skin.joint(0, 20, world);
    const frame = f.frames.prepareFrame(f.scene.slotsSnapshot());
    if (frame === undefined) throw new Error('Missing actual capsule pose frame');
    tasks.begin(frame);
    const result = tasks.capsules(f.first);
    if (result.status !== 'ready') throw new Error('Missing actual capsule task output');
    expect(Array.from(result.capsules)).toEqual([3, 0, 0, 0.5, 3, 2, 0, 0]);
    await tasks.complete();
  } finally {
    await tasks.dispose();
    f.dispose();
  }
});

it('omits an overflowing composed pose from capsule and draw demand without failing the recording', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const capsules = {
    joints: new Uint16Array([0]),
    shapes: new Float32Array([0, 0, 0, 0, 1, 0, 0.1]),
  };
  const f = skinTaskFixture(1, capsules),
    tasks = new SkinTasks(device, true);
  try {
    f.frames.discardFrame();
    const inverse = mat4.identity(mat4.create());
    inverse[0] = 3e38;
    f.skin.skeletonChanged(0, 7, {
      kind: 'skeleton',
      jointCount: 1,
      inverseBindMatrices: inverse,
      shadowCapsules: capsules,
    });
    const world = mat4.identity(mat4.create());
    world[0] = 3e38;
    f.skin.joint(0, 19, world);
    const frame = f.frames.prepareFrame(f.scene.slotsSnapshot());
    if (frame === undefined) throw new Error('Missing actual overflow frame');
    tasks.begin(frame);
    expect(tasks.capsules(f.first)).toEqual({ status: 'pose-unavailable' });
    expect(tasks.demand(f.first)).toBeUndefined();
    expect(tasks.paletteUploadBytes).toBe(0);
    await tasks.complete();
  } finally {
    await tasks.dispose();
    f.dispose();
  }
});

it('keeps the Scene healthy when a shared Skeleton becomes malformed and omits only its consumers', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const f = skinTaskFixture(1),
    tasks = new SkinTasks(device, true);
  try {
    f.frames.discardFrame();
    for (const malformed of [
      { jointCount: 0, inverseBindMatrices: new Float32Array(0) },
      { jointCount: 1, inverseBindMatrices: new Float32Array(16).fill(1e39) },
      {
        jointCount: 1,
        inverseBindMatrices: mat4.identity(mat4.create()),
        shadowCapsules: { joints: new Uint16Array([1]), shapes: new Float32Array(7).fill(1) },
      },
    ]) {
      f.skin.skeletonChanged(0, 7, { kind: 'skeleton', ...malformed });
      const frame = f.frames.prepareFrame(f.scene.slotsSnapshot());
      if (frame === undefined) throw new Error('Missing healthy Skin frame');
      tasks.begin(frame);
      expect(tasks.demand(f.first)).toBeUndefined();
      await tasks.complete();
      f.frames.discardFrame();
    }
    f.skin.skeletonChanged(0, 7, {
      kind: 'skeleton',
      jointCount: 1,
      inverseBindMatrices: mat4.identity(mat4.create()),
    });
    const restored = f.frames.prepareFrame(f.scene.slotsSnapshot());
    if (restored === undefined) throw new Error('Missing restored Skin frame');
    tasks.begin(restored);
    expect(tasks.demand(f.first)).toBeDefined();
    await tasks.complete();
  } finally {
    await tasks.dispose();
    f.dispose();
  }
});

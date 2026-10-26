import { mat4 } from '@forgeax/engine-math';
import { expect, it, vi } from 'vitest';
import { GpuInputArena } from '../gpu-input-arena';
import { MaterialResource } from '../material-resource';
import { defaultMaterialSnapshot, type RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';
import { SkinInputs } from '../scene/skin-inputs';
import { SkinFrames, SkinSceneInputs } from '../scene/skin-scene-inputs';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected a retained Skin frame fact');
  return value;
}

function matrix(x = 0) {
  const out = mat4.identity(mat4.create());
  out[12] = x;
  return out;
}
function deferred() {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const material = MaterialResource.from(defaultMaterialSnapshot());

function fixture() {
  const arena = new GpuInputArena(),
    scene = new RenderScene(),
    skin = new SkinSceneInputs(arena, () => ({
      kind: 'skeleton',
      jointCount: 1,
      inverseBindMatrices: matrix(1),
    }));
  const row: RenderableSnapshot = {
    worldId: 0,
    entityKey: 17,
    transform: { world: matrix(99) },
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    skinBinding: { skeleton: 7, joints: [19] },
  };
  skin.apply(scene.apply([{ kind: 'update', worldId: 0, entityKey: 17, snapshot: row }]));
  skin.joint(0, 19, matrix(3));
  const slot = required(scene.slotsSnapshot().lookup(0, 17)).slot;
  const x = (root: ReturnType<SkinSceneInputs['capture']>) => {
    const out = mat4.create();
    expect(root.matrix(slot, 0, out, mat4.create())).toBe(true);
    return out[12];
  };
  return { arena, scene, skin, frames: new SkinFrames(skin), slot, x };
}

it('retains the submitted A root while B changes, aborts, and later C submits', async () => {
  const { arena, scene, skin, frames, x } = fixture(),
    aDone = deferred(),
    cDone = deferred();
  try {
    const a = required(frames.prepareFrame(scene.slotsSnapshot()));
    expect(a.previous).toBeUndefined();
    expect(a.slots.lookup(0, 17)?.snapshot.transform.world[12]).toBe(99);
    expect(x(a.current)).toBe(4);
    expect(() => frames.prepareFrame(scene.slotsSnapshot())).toThrow();
    const releaseA = frames.submitFrame(a, aDone.promise, true);
    skin.joint(0, 19, matrix(8));
    const b = required(frames.prepareFrame(scene.slotsSnapshot()));
    expect(x(b.current)).toBe(9);
    expect(x(required(b.previous))).toBe(4);
    frames.discardFrame();
    expect(() => x(b.current)).toThrow();
    expect(() => x(required(b.previous))).toThrow();
    expect(x(a.current)).toBe(4);
    expect(() => frames.submitFrame(b, Promise.resolve(), true)).toThrow();
    skin.joint(0, 19, matrix(11));
    const c = required(frames.prepareFrame(scene.slotsSnapshot()));
    expect(x(required(c.previous))).toBe(4);
    const releaseC = frames.submitFrame(c, cDone.promise, true);
    expect(x(a.current)).toBe(4);
    aDone.resolve();
    await releaseA;
    expect(() => x(a.current)).toThrow();
    expect(x(required(c.previous))).toBe(4);
    const next = required(frames.prepareFrame(scene.slotsSnapshot()));
    expect(x(required(next.previous))).toBe(12);
    frames.discardFrame();
    cDone.resolve();
    await releaseC;
  } finally {
    aDone.resolve();
    cDone.resolve();
    skin.dispose();
    arena.dispose();
  }
});

it('releases task roots on rejected completion and keeps the error observable', async () => {
  const { arena, scene, skin, frames, x } = fixture(),
    done = deferred();
  try {
    const a = required(frames.prepareFrame(scene.slotsSnapshot()));
    const released = frames.submitFrame(a, done.promise, true),
      error = new Error('device lost');
    const rejected = expect(released).rejects.toBe(error);
    done.reject(error);
    await rejected;
    expect(() => x(a.current)).toThrow();
    frames.resetHistory();
    const recovered = required(frames.prepareFrame(scene.slotsSnapshot()));
    expect(recovered.previous).toBeUndefined();
    expect(x(recovered.current)).toBe(4);
    frames.discardFrame();
  } finally {
    skin.dispose();
    arena.dispose();
  }
});

it('keeps in-flight roots readable through history reset and owner retirement', async () => {
  const { arena, scene, skin, frames, x } = fixture(),
    done = deferred();
  try {
    const a = required(frames.prepareFrame(scene.slotsSnapshot())),
      released = frames.submitFrame(a, done.promise, true);
    skin.joint(0, 19, matrix(8));
    const b = required(frames.prepareFrame(scene.slotsSnapshot()));
    frames.resetHistory();
    expect(() => x(b.current)).toThrow();
    expect(x(a.current)).toBe(4);
    const c = required(frames.prepareFrame(scene.slotsSnapshot()));
    expect(c.previous).toBeUndefined();
    frames.resetHistory();
    skin.dispose();
    expect(() => x(c.current)).toThrow();
    expect(x(a.current)).toBe(4);
    done.resolve();
    await released;
    expect(() => x(a.current)).toThrow();
  } finally {
    done.resolve();
    skin.dispose();
    arena.dispose();
  }
});

it('uses the actual fixed Scene slot root when a later frame reuses its address', async () => {
  const { arena, scene, skin, frames, slot, x } = fixture(),
    done = deferred();
  try {
    const a = required(frames.prepareFrame(scene.slotsSnapshot())),
      released = frames.submitFrame(a, done.promise, true);
    skin.apply(scene.apply([{ kind: 'remove', worldId: 0, entityKey: 17 }]));
    const row: RenderableSnapshot = {
      worldId: 0,
      entityKey: 29,
      transform: { world: matrix(7) },
      material,
      materials: [material],
      materialBindingSources: ['engine-default'],
      skinBinding: { skeleton: 7, joints: [19] },
    };
    skin.apply(scene.apply([{ kind: 'update', worldId: 0, entityKey: 29, snapshot: row }]));
    skin.joint(0, 19, matrix(8));
    const b = required(frames.prepareFrame(scene.slotsSnapshot()));
    expect(b.slots.lookup(0, 29)?.slot).toBe(slot);
    expect(a.slots.lookup(0, 17)?.slot).toBe(slot);
    expect(a.slots.lookup(0, 29)).toBeUndefined();
    expect(b.current.historyCompatible(required(b.previous), slot)).toBe(false);
    expect(x(a.current)).toBe(4);
    frames.discardFrame();
    done.resolve();
    await released;
  } finally {
    done.resolve();
    skin.dispose();
    arena.dispose();
  }
});

it('does no root capture without Skin demand and retires old history after a successful empty frame', async () => {
  const arena = new GpuInputArena(),
    scene = new RenderScene(),
    skin = new SkinSceneInputs(arena, () => undefined);
  const frames = new SkinFrames(skin);
  const capture = vi.spyOn(SkinInputs.prototype, 'capture');
  try {
    expect(frames.prepareFrame(scene.slotsSnapshot())).toBeUndefined();
    expect(capture).not.toHaveBeenCalled();
  } finally {
    capture.mockRestore();
    skin.dispose();
    arena.dispose();
  }
  const f = fixture();
  try {
    const a = required(f.frames.prepareFrame(f.scene.slotsSnapshot()));
    await f.frames.submitFrame(a, Promise.resolve(), true);
    f.skin.apply(f.scene.apply([{ kind: 'remove', worldId: 0, entityKey: 17 }]));
    const empty = required(f.frames.prepareFrame(f.scene.slotsSnapshot()));
    expect(empty.current.jointCapacity).toBe(0);
    expect(f.x(required(empty.previous))).toBe(4);
    f.frames.discardFrame();
    const retry = required(f.frames.prepareFrame(f.scene.slotsSnapshot()));
    expect(f.x(required(retry.previous))).toBe(4);
    await f.frames.submitFrame(retry, Promise.resolve(), true);
    expect(f.frames.prepareFrame(f.scene.slotsSnapshot())).toBeUndefined();
  } finally {
    f.skin.dispose();
    f.arena.dispose();
  }
});

it('bounds root retention through repeated submit, discard and reset cycles without walking Bindings', async () => {
  const { arena, scene, skin, frames } = fixture(),
    bind = vi.spyOn(SkinInputs.prototype, 'bind');
  try {
    for (let index = 0; index < 160; index++) {
      skin.joint(0, 19, matrix(index));
      const frame = required(frames.prepareFrame(scene.slotsSnapshot()));
      if (index % 3 === 0) frames.discardFrame();
      else await frames.submitFrame(frame, Promise.resolve(), true);
      if (index % 11 === 0) frames.resetHistory();
    }
    expect(bind).not.toHaveBeenCalled();
  } finally {
    bind.mockRestore();
    skin.dispose();
    arena.dispose();
  }
});

it('reserves history before submission so the fixed-root limit cannot break post-submit retirement', async () => {
  const { arena, scene, skin, frames, x } = fixture(),
    done = deferred();
  const holders: ReturnType<SkinSceneInputs['capture']>[] = [];
  try {
    const a = required(frames.prepareFrame(scene.slotsSnapshot()));
    for (let index = 0; index < 128; index++) {
      try {
        holders.push(skin.capture());
      } catch {
        break;
      }
    }
    expect(holders.length).toBeGreaterThan(100);
    expect(() => skin.capture()).toThrow();
    let released: Promise<void> | undefined;
    expect(() => {
      released = frames.submitFrame(a, done.promise, true);
    }).not.toThrow();
    frames.discardFrame();
    expect(x(a.current)).toBe(4);
    done.resolve();
    await required(released);
    expect(() => x(a.current)).toThrow();
  } finally {
    done.resolve();
    for (const holder of holders) holder.release();
    skin.dispose();
    arena.dispose();
  }
});

function errorsIn(cause: unknown): unknown[] {
  return cause instanceof AggregateError ? cause.errors.flatMap(errorsIn) : [cause];
}

it('retires every owned root and the live numeric tree after an actual range release fails', async () => {
  const live = new Set<number>();
  const allocate = GpuInputArena.prototype.allocateDescriptor,
    release = GpuInputArena.prototype.releaseDescriptor;
  const allocations = vi
    .spyOn(GpuInputArena.prototype, 'allocateDescriptor')
    .mockImplementation(function (this: GpuInputArena, count) {
      const address = allocate.call(this, count);
      live.add(address);
      return address;
    });
  let fail = false;
  const error = new Error('range retired then failed');
  const releases = vi
    .spyOn(GpuInputArena.prototype, 'releaseDescriptor')
    .mockImplementation(function (this: GpuInputArena, address, count) {
      release.call(this, address, count);
      live.delete(address);
      if (fail) {
        fail = false;
        throw error;
      }
    });
  const { arena, scene, skin, frames } = fixture();
  const dispose = vi.spyOn(SkinInputs.prototype, 'dispose');
  try {
    const a = required(frames.prepareFrame(scene.slotsSnapshot()));
    await frames.submitFrame(a, Promise.resolve(), true);
    skin.joint(0, 19, matrix(8));
    frames.prepareFrame(scene.slotsSnapshot());
    skin.joint(0, 19, matrix(11));
    fail = true;
    let failure: unknown;
    try {
      frames.resetHistory();
    } catch (cause) {
      failure = cause;
    }
    skin.dispose();
    expect(errorsIn(failure)).toContain(error);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(live.size).toBe(0);
    expect(() => skin.dispose()).not.toThrow();
    expect(() => skin.capture()).toThrow();
  } finally {
    fail = false;
    skin.dispose();
    arena.dispose();
    dispose.mockRestore();
    releases.mockRestore();
    allocations.mockRestore();
  }
});

it('keeps both queue rejection and numeric cleanup failure in the completion error', async () => {
  const { arena, scene, skin, frames } = fixture(),
    done = deferred();
  const queueError = new Error('queue lost'),
    cleanupError = new Error('completion range release');
  const actual = arena.releaseDescriptor.bind(arena);
  const release = vi.spyOn(arena, 'releaseDescriptor');
  try {
    const a = required(frames.prepareFrame(scene.slotsSnapshot()));
    const released = frames.submitFrame(a, done.promise, true);
    skin.joint(0, 19, matrix(8));
    frames.resetHistory();
    release.mockImplementationOnce((address, count) => {
      actual(address, count);
      throw cleanupError;
    });
    const observed = released.catch((cause: unknown) => cause);
    done.reject(queueError);
    const failure = await observed;
    expect(errorsIn(failure)).toContain(queueError);
    expect(errorsIn(failure)).toContain(cleanupError);
  } finally {
    release.mockRestore();
    skin.dispose();
    arena.dispose();
  }
});

it('retains physically submitted preparation reads without advancing Scene history', async () => {
  const { arena, scene, skin, frames, x } = fixture(),
    done = deferred();
  try {
    const a = required(frames.prepareFrame(scene.slotsSnapshot()));
    await frames.submitFrame(a, Promise.resolve(), true);
    skin.joint(0, 19, matrix(8));
    const b = required(frames.prepareFrame(scene.slotsSnapshot()));
    const released = frames.submitFrame(b, done.promise, false);
    frames.discardFrame();
    expect(x(b.current)).toBe(9);
    skin.joint(0, 19, matrix(11));
    const c = required(frames.prepareFrame(scene.slotsSnapshot()));
    expect(x(required(c.previous))).toBe(4);
    frames.discardFrame();
    expect(x(b.current)).toBe(9);
    done.resolve();
    await released;
    expect(() => x(b.current)).toThrow();
  } finally {
    done.resolve();
    skin.dispose();
    arena.dispose();
  }
});

it('rolls back every prepared lease when history reservation exceeds the root bound', async () => {
  const { arena, scene, skin, frames } = fixture();
  const holders: ReturnType<SkinSceneInputs['capture']>[] = [];
  try {
    const a = required(frames.prepareFrame(scene.slotsSnapshot()));
    await frames.submitFrame(a, Promise.resolve(), true);
    for (let index = 0; index < 128; index++) {
      try {
        holders.push(skin.capture());
      } catch {
        break;
      }
    }
    required(holders.pop()).release();
    required(holders.pop()).release();
    expect(() => frames.prepareFrame(scene.slotsSnapshot())).toThrow();
    for (const holder of holders) holder.release();
    holders.length = 0;
    const retry = required(frames.prepareFrame(scene.slotsSnapshot()));
    expect(retry.previous).toBeDefined();
    frames.discardFrame();
  } finally {
    for (const holder of holders) holder.release();
    skin.dispose();
    arena.dispose();
  }
});

import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, onTestFinished, vi } from 'vitest';
import type { GpuSceneResourceHold } from '../gpu-scene';
import { uploadFixture } from './gpu-driven-topology-upload-fixture';

async function fixture(expectRetirementFault = false) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const f = uploadFixture(device, shader);
  const holds: GpuSceneResourceHold[] = [];
  onTestFinished(() => {
    for (const hold of holds) hold.release();
    if (expectRetirementFault) expect(() => f.close()).toThrow();
    else f.close();
  });
  const capture = () => {
    const frame = f.gpuScene.captureResources().unwrap();
    frame.indexForResource(f.material, f.material.snapshot);
    return frame;
  };
  return {
    ...f,
    capture,
    keep: (hold: GpuSceneResourceHold) => {
      holds.push(hold);
      return hold;
    },
    version: () => Reflect.get(f.gpuScene, 'sharedMaterials').get(f.material).version,
  };
}

it('moves real references into a frozen hold without read or submission authority', async () => {
  const f = await fixture();
  const frame = f.capture();
  const version = f.version();
  expect(version.references).toBe(2);
  expect(f.gpuScene.holdResources(frame).ok).toBe(false);
  frame.seal().unwrap();
  const hold = f.keep(f.gpuScene.holdResources(frame).unwrap());
  expect(Object.keys(hold)).toEqual(['release']);
  expect(Object.isFrozen(hold)).toBe(true);
  frame.release();
  expect(version.references).toBe(2);
  expect(frame.indexForResource(f.material)).toBeUndefined();
  expect(() => frame.inputReads()).toThrow();
  expect(() => frame.seal()).toThrow();
  expect(() => frame.submit()).toThrow();
  expect(f.gpuScene.holdResources(frame).ok).toBe(false);
  hold.release();
  expect(version.references).toBe(1);
  hold.release();
  expect(version.references).toBe(1);
});

it.each([
  'holdResources',
  'holdMaterialRoots',
] as const)('%s rejects foreign, copied, released and submitted frames', async (method) => {
  const f = await fixture();
  const foreign = await fixture();
  const frame = f.capture();
  frame.seal().unwrap();
  expect(foreign.gpuScene[method](frame).ok).toBe(false);
  expect(f.gpuScene[method](Object.freeze({ ...frame })).ok).toBe(false);
  frame.release();
  expect(f.gpuScene[method](frame).ok).toBe(false);
  const submitted = f.capture();
  submitted.seal().unwrap();
  const completed = Promise.resolve();
  submitted.submit(completed);
  expect(f.gpuScene[method](submitted).ok).toBe(false);
  await completed;
});

it('keeps an old version alive while fresh probes reject its stale pins', async () => {
  const f = await fixture();
  const frame = f.capture();
  const old = f.version();
  const pins = frame.pins?.();
  expect(pins).toBeDefined();
  frame.seal().unwrap();
  const hold = f.keep(f.gpuScene.holdResources(frame).unwrap());
  f.material.adopt({ ...f.material.snapshot, roughness: 0.25 });
  f.gpuScene.sync({ ...f.projection.apply([]), materialUpdates: [f.material] }).unwrap();
  expect(f.version()).not.toBe(old);
  expect(old.references).toBe(1);
  const probe = f.gpuScene.captureResources().unwrap();
  try {
    expect(pins !== undefined && probe.adoptPins?.(pins)).toBe(false);
  } finally {
    probe.release();
  }
  hold.release();
  expect(old.references).toBe(0);
});

it('does not retire an in-flight frame when the independent resident hold releases', async () => {
  const f = await fixture();
  const held = f.capture();
  const old = f.version();
  held.seal().unwrap();
  const hold = f.keep(f.gpuScene.holdResources(held).unwrap());
  const submitted = f.capture();
  submitted.seal().unwrap();
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  submitted.submit(completed);
  f.material.adopt({ ...f.material.snapshot, roughness: 0.25 });
  f.gpuScene.sync({ ...f.projection.apply([]), materialUpdates: [f.material] }).unwrap();
  expect(old.references).toBe(2);
  hold.release();
  expect(old.references).toBe(1);
  finish();
  await completed;
  expect(old.references).toBe(0);
});

it('reuses direct row addresses in queue order while keeping the sealed physical domain alive', async () => {
  const f = await fixture();
  const frame = f.capture();
  const old = f.version();
  const reads = frame.inputReads();
  const table = f.gpuScene.tableBindingIdentity;
  frame.seal().unwrap();
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  frame.submit(completed, 'queue-order');
  frame.release();
  expect(old.references).toBe(1);
  expect(f.gpuScene.readHoldsTableRoot(reads, table)).toBe(true);
  f.material.adopt({ ...f.material.snapshot, roughness: 0.25 });
  f.gpuScene.sync({ ...f.projection.apply([]), materialUpdates: [f.material] }).unwrap();
  expect(f.version().descriptor).toBe(old.descriptor);
  expect(f.version().start).toBe(old.start);
  // A sibling still recording must keep the exact old version across an edit.
  const sibling = f.capture();
  const direct = f.capture();
  const shared = f.version();
  direct.seal().unwrap();
  direct.submit(completed, 'queue-order');
  f.material.adopt({ ...f.material.snapshot, roughness: 0.75 });
  f.gpuScene.sync({ ...f.projection.apply([]), materialUpdates: [f.material] }).unwrap();
  expect(f.version().descriptor).not.toBe(shared.descriptor);
  expect(shared.references).toBe(1);
  sibling.release();
  finish();
  await completed;
  expect(f.gpuScene.readHoldsTableRoot(reads, table)).toBe(false);
  expect(shared.references).toBe(0);
});

it('retires a submitted frame after a rejected completion without treating its reason as cleanup', async () => {
  const f = await fixture();
  const frame = f.capture();
  const version = f.version();
  frame.seal().unwrap();
  const completed = Promise.reject(new Error('submission completion rejected'));
  frame.submit(completed);
  await completed.catch(() => undefined);
  expect(version.references).toBe(1);
  const next = f.gpuScene.captureResources().unwrap();
  next.release();
});

it('keeps held versions out of the ordinary read-domain quota and drains without an update', async () => {
  const f = await fixture();
  const held: GpuSceneResourceHold[] = [];
  for (let index = 0; index < 128; index++) {
    const frame = f.gpuScene.captureResources().unwrap();
    frame.seal().unwrap();
    held.push(f.keep(f.gpuScene.holdResources(frame).unwrap()));
  }
  const ordinary = [];
  for (let index = 0; index < 128; index++) ordinary.push(f.gpuScene.captureResources().unwrap());
  expect(f.gpuScene.captureResources().ok).toBe(false);
  for (const hold of held) hold.release();
  expect(f.gpuScene.captureResources().ok).toBe(false);
  for (const frame of ordinary) frame.release();
  const next = f.gpuScene.captureResources().unwrap();
  next.release();
});

it('releases the held version after Scene disposal without reviving the source', async () => {
  const f = await fixture();
  const frame = f.capture();
  const old = f.version();
  frame.seal().unwrap();
  const hold = f.keep(f.gpuScene.holdResources(frame).unwrap());
  f.gpuScene.dispose();
  expect(old.references).toBe(1);
  expect(f.gpuScene.captureResources().ok).toBe(false);
  hold.release();
  expect(old.references).toBe(0);
});

it('rejects terminal reentry while transferring the read domain', async () => {
  const f = await fixture();
  const capture = f.gpuScene.inputs.capture.bind(f.gpuScene.inputs);
  const hook = vi.spyOn(f.gpuScene.inputs, 'capture').mockImplementation(() => {
    const inputs = capture();
    const release = inputs.release.bind(inputs);
    inputs.release = () => {
      release();
      f.gpuScene.dispose();
    };
    return inputs;
  });
  try {
    const frame = f.capture();
    const old = f.version();
    frame.seal().unwrap();
    const transferred = f.gpuScene.holdResources(frame);
    if (transferred.ok) transferred.value.release();
    expect(transferred.ok).toBe(false);
    expect(old.references).toBe(0);
  } finally {
    hook.mockRestore();
  }
});

it('rejects a second transfer while the first closes its read domain', async () => {
  const f = await fixture();
  const capture = f.gpuScene.inputs.capture.bind(f.gpuScene.inputs);
  let nested: boolean | undefined;
  const hook = vi.spyOn(f.gpuScene.inputs, 'capture').mockImplementation(() => {
    const inputs = capture();
    const release = inputs.release.bind(inputs);
    inputs.release = () => {
      release();
      nested = f.gpuScene.holdResources(frame).ok;
    };
    return inputs;
  });
  const frame = f.capture();
  try {
    frame.seal().unwrap();
    const held = f.keep(f.gpuScene.holdResources(frame).unwrap());
    expect(nested).toBe(false);
    expect(f.version().references).toBe(2);
    held.release();
    expect(f.version().references).toBe(1);
  } finally {
    hook.mockRestore();
  }
});

it.each([
  ['holdResources', 'before'],
  ['holdResources', 'after'],
  ['holdMaterialRoots', 'before'],
  ['holdMaterialRoots', 'after'],
] as const)('%s keeps transfer cleanup failure sticky and drains versions (%s effect)', async (method, when) => {
  const f = await fixture(true);
  const capture = f.gpuScene.inputs.capture.bind(f.gpuScene.inputs);
  const cause = new Error(`read retirement failed ${when} effect`);
  const hook = vi.spyOn(f.gpuScene.inputs, 'capture').mockImplementation(() => {
    const inputs = capture();
    const release = inputs.release.bind(inputs);
    inputs.release = () => {
      if (when === 'after') release();
      throw cause;
    };
    return inputs;
  });
  try {
    const frame = f.capture();
    const version = f.version();
    frame.seal().unwrap();
    expect(version.references).toBe(2);
    expect(() => f.gpuScene[method](frame)).toThrow();
    expect(version.references).toBe(1);
    expect(f.gpuScene.captureResources().ok).toBe(false);
    expect(f.gpuScene[method](frame).ok).toBe(false);
    expect(() => frame.release()).toThrow();
    expect(version.references).toBe(1);
    expect(Reflect.get(f.gpuScene, 'failedResourceFrames').size).toBe(1);
  } finally {
    hook.mockRestore();
  }
});

it('tracks actual material roots and invalidates captured snapshots after same-size adoption', async () => {
  const f = await fixture();
  const frame = f.capture();
  const original = f.material.snapshot;
  frame.seal().unwrap();
  const roots = f.gpuScene.holdMaterialRoots(frame).unwrap();
  f.keep(roots);
  expect(Object.keys(roots).sort()).toEqual(['isCurrent', 'release']);
  expect(roots.isCurrent()).toBe(true);
  f.material.adopt({ ...original, roughness: 0.125 });
  f.gpuScene.sync({ ...f.projection.apply([]), materialUpdates: [f.material] }).unwrap();
  expect(roots.isCurrent()).toBe(false);
  roots.release();
  expect(roots.isCurrent()).toBe(false);
  roots.release();
});

it('rejects old logical-root adoption while preserving its legitimate version-only transfer', async () => {
  const f = await fixture();
  const frame = f.capture();
  frame.seal().unwrap();
  f.material.adopt({ ...f.material.snapshot, roughness: 0.125 });
  f.gpuScene.sync({ ...f.projection.apply([]), materialUpdates: [f.material] }).unwrap();
  expect(f.gpuScene.holdMaterialRoots(frame).ok).toBe(false);
  const versionOnly = f.keep(f.gpuScene.holdResources(frame).unwrap());
  versionOnly.release();
});

it('settles each material holder once when the Scene disposes before its leases', async () => {
  const f = await fixture();
  const holds = [f.capture(), f.capture()].map((frame) => {
    frame.seal().unwrap();
    const held = f.gpuScene.holdMaterialRoots(frame).unwrap();
    f.keep(held);
    return held;
  });
  const version = f.version();
  expect(version.references).toBe(3);
  f.gpuScene.dispose();
  expect(version.references).toBe(2);
  for (const [index, held] of holds.entries()) {
    expect(held.isCurrent()).toBe(false);
    held.release();
    expect(version.references).toBe(1 - index);
    held.release();
    expect(version.references).toBe(1 - index);
  }
});

it('rejects a material changed by the read-domain retirement callback and unwinds the acquired root', async () => {
  const f = await fixture();
  const capture = f.gpuScene.inputs.capture.bind(f.gpuScene.inputs);
  let changed = false;
  const hook = vi.spyOn(f.gpuScene.inputs, 'capture').mockImplementation(() => {
    const inputs = capture();
    const release = inputs.release.bind(inputs);
    inputs.release = () => {
      release();
      if (changed) return;
      changed = true;
      f.material.adopt({ ...f.material.snapshot, roughness: 0.125 });
      f.gpuScene.sync({ ...f.projection.apply([]), materialUpdates: [f.material] }).unwrap();
    };
    return inputs;
  });
  try {
    const frame = f.capture();
    const previous = f.version();
    frame.seal().unwrap();
    expect(f.gpuScene.holdMaterialRoots(frame).ok).toBe(false);
    expect(previous.references).toBe(0);
    expect(f.version().references).toBe(1);
    frame.release();
    expect(f.version().references).toBe(1);
  } finally {
    hook.mockRestore();
  }
});

it('owns cleanup when final material-root qualification throws before a hold is issued', async () => {
  const f = await fixture(true);
  const frame = f.capture();
  const version = f.version();
  const allocation = Reflect.get(f.gpuScene, 'sharedMaterials').get(f.material);
  const holders = allocation.holders;
  frame.seal().unwrap();
  const cause = new Error('final material root probe failed');
  const hook = vi.spyOn(f.gpuScene.inputs, 'resourceIsCurrent').mockImplementation(() => {
    throw cause;
  });
  try {
    expect(() => f.gpuScene.holdMaterialRoots(frame)).toThrow();
  } finally {
    hook.mockRestore();
  }
  expect(() => frame.release()).toThrow('Material-root custody transfer failed');
  expect(version.references).toBe(1);
  expect(allocation.holders).toBe(holders);
  expect(f.gpuScene.captureResources().ok).toBe(false);
  expect(Reflect.get(f.gpuScene, 'failedResourceFrames').size).toBe(1);
});

it('observes material-root currentness without acquiring another read domain', async () => {
  const f = await fixture();
  const frame = f.capture();
  frame.seal().unwrap();
  const roots = f.gpuScene.holdMaterialRoots(frame).unwrap();
  f.keep(roots);
  const capture = vi.spyOn(f.gpuScene.inputs, 'capture');
  try {
    expect(roots.isCurrent()).toBe(true);
    expect(roots.isCurrent()).toBe(true);
    expect(capture).not.toHaveBeenCalled();
  } finally {
    capture.mockRestore();
  }
});

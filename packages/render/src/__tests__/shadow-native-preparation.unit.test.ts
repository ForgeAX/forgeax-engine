import { err, ok, RhiError, type Texture } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { assert, expect, it, vi } from 'vitest';
import { ShadowDepthLayers } from '../shadow-depth-layers';

it('keeps a native-callback successor and retires only the unaccepted shadow texture', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const owner = new ShadowDepthLayers(device);
  const create = device.createTexture.bind(device);
  let outer: Texture | undefined;
  let successor: Texture | undefined;
  const destroyed = vi.spyOn(device, 'destroyTexture');
  const creating = vi.spyOn(device, 'createTexture').mockImplementationOnce((descriptor) => {
    outer = create(descriptor).unwrap();
    successor = owner.texture('same-label', 8, 2);
    return ok(outer);
  });
  try {
    expect(() => owner.texture('same-label', 4, 2)).toThrow();
    assert(outer && successor);
    expect(owner.allocation('same-label')).toBe(successor);
    expect(owner.residentTexture('same-label', 8, 2)).toBe(successor);
    expect(owner.residentTexture('same-label', 4, 2)).toBeUndefined();
    expect(destroyed.mock.calls).toEqual([[outer]]);
    owner.dispose();
    expect(destroyed.mock.calls).toEqual([[outer], [successor]]);
  } finally {
    creating.mockRestore();
    destroyed.mockRestore();
    owner.dispose();
  }
});

it.each([
  'error',
  'throw-undefined',
] as const)('retains exact unaccepted cleanup failure after %s and still attempts independent release', async (mode) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const owner = new ShadowDepthLayers(device);
  const kept = owner.texture('independent', 4, 2);
  const create = device.createTexture.bind(device);
  const destroy = device.destroyTexture.bind(device);
  let live = true;
  let rejected: Texture | undefined;
  const creating = vi.spyOn(device, 'createTexture').mockImplementationOnce((descriptor) => {
    rejected = create(descriptor).unwrap();
    live = false;
    return ok(rejected);
  });
  const refused = new RhiError({
    code: 'rhi-not-available',
    expected: 'injected destroy refusal',
    hint: 'preserve the exact native receipt',
  });
  const destroying = vi.spyOn(device, 'destroyTexture').mockImplementation((texture) => {
    if (texture !== rejected) return destroy(texture);
    if (mode === 'throw-undefined') throw undefined;
    return err(refused);
  });
  const work = owner.prepareTexture('rejected', 8, 2, () => live);
  try {
    expect(() => work.next()).toThrow(AggregateError);
    assert(rejected);
    expect(owner.allocation('rejected')).toBeUndefined();
    expect(() => owner.dispose()).toThrow(AggregateError);
    expect(() => owner.dispose()).toThrow(AggregateError);
    expect(destroying.mock.calls.filter(([texture]) => texture === rejected)).toHaveLength(1);
    expect(destroying.mock.calls.filter(([texture]) => texture === kept)).toHaveLength(1);
  } finally {
    creating.mockRestore();
    destroying.mockRestore();
    // This controlled fault threw before any native effect; test teardown knows this handle remains live.
    if (rejected !== undefined) destroy(rejected).unwrap();
  }
});

it('refuses off-frame shadow shape replacement before native work and preserves the original allocation', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const owner = new ShadowDepthLayers(device);
  const original = owner.texture('live', 4, 2);
  const creates = vi.spyOn(device, 'createTexture');
  try {
    expect(() => owner.prepareTexture('live', 8, 2, () => true).next()).toThrow();
    expect(creates).not.toHaveBeenCalled();
    expect(owner.allocation('live')).toBe(original);
  } finally {
    creates.mockRestore();
    owner.dispose();
  }
});

it('prepares only the requested active shadow prefix', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const owner = new ShadowDepthLayers(device);
  try {
    const work = owner.prepareTexture('spot-shadow-depth', 8, 32, () => true, 1);
    let next = work.next();
    while (!next.done) next = work.next();
    const full = owner.residentView('spot-shadow-depth');
    const prefix = owner.residentView('spot-shadow-depth', undefined, 1);
    expect(full).toBeUndefined();
    expect(prefix).toBeDefined();
    expect(owner.residentView('spot-shadow-depth', undefined, 2)).toBeUndefined();
    const create = vi.spyOn(device, 'createTextureView');
    try {
      expect(owner.view('spot-shadow-depth', undefined, 1)).toBe(prefix);
      expect(create).not.toHaveBeenCalled();
    } finally {
      create.mockRestore();
    }
  } finally {
    owner.dispose();
  }
});

it('restores the submitted atlas and releases each failed resize before retry', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const owner = new ShadowDepthLayers(device);
  const original = owner.texture('spot', 4, 2);
  const destroyed = vi.spyOn(device, 'destroyTexture');
  try {
    for (const size of [8, 16, 32]) {
      owner.beginReplacement();
      const rejected = owner.texture('spot', size, 2);
      const added = owner.texture('point', size, 6);
      owner._abort();
      expect(owner.allocation('spot')).toBe(original);
      expect(owner.allocation('point')).toBeUndefined();
      expect(destroyed).toHaveBeenCalledWith(rejected);
      expect(destroyed).toHaveBeenCalledWith(added);
      expect(destroyed).not.toHaveBeenCalledWith(original);
    }
    owner.beginReplacement();
    const final = owner.texture('spot', 8, 2);
    owner._commit();
    expect(owner.allocation('spot')).toBe(final);
    expect(destroyed).toHaveBeenCalledWith(original);
    expect(destroyed).toHaveBeenCalledTimes(7);
  } finally {
    owner.dispose();
    destroyed.mockRestore();
  }
});

import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { createFeatureSceneInputs } from '../assembly/feature-scene-inputs';
import { createFeatureSceneSdf } from '../assembly/feature-scene-sdf';
import type { RenderSystemInternals } from '../record/render-context';

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  vi.spyOn(device, 'limits', 'get').mockReturnValue({
    ...device.limits,
    minStorageBufferOffsetAlignment: 256,
    minUniformBufferOffsetAlignment: 256,
    maxBindGroups: 4,
    maxBindingsPerBindGroup: 16,
    maxStorageBuffersPerShaderStage: 8,
    maxUniformBuffersPerShaderStage: 12,
    maxUniformBufferBindingSize: 65536,
    maxStorageBufferBindingSize: 128 * 1024 * 1024,
    maxBufferSize: 256 * 1024 * 1024,
    maxComputeWorkgroupSizeX: 256,
    maxComputeInvocationsPerWorkgroup: 256,
    maxComputeWorkgroupsPerDimension: 65535,
  });
  const module = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const scope = {};
  let revision = 0;
  const internals = {
    device,
    assets: { catalogEpoch: 0 },
    immediateShaderModuleFactory: { createShaderModule: () => ok(module) },
  } as unknown as RenderSystemInternals;
  const source = () => ({
    scopes: [scope] as never,
    retained: {
      identity: scope,
      revision,
      worlds: [scope],
      slots: [],
      isCurrent: () => true,
      isSourceCurrent: () => true,
    } as never,
  });
  const owner = createFeatureSceneSdf(internals);
  const request = {
    kind: 'scene-sdf' as const,
    name: 'collision',
    world: 0,
    descriptor: {
      origin: [0, 0, 0] as const,
      dimensions: [3, 3, 3] as const,
      spacing: 1,
      maxDistance: 2,
      maxInstances: 16,
      maxFieldBytes: 1024,
    },
  };
  return { device, internals, owner, source, request, changeSource: () => revision++ };
}

it('preserves only fields belonging to failed consumers and retires unrelated fields', async () => {
  const f = await fixture();
  const destroyed = vi.spyOn(f.device, 'destroyBuffer');
  try {
    f.owner.begin();
    const a = f.owner.prepare('a', f.request, f.source());
    const b = f.owner.prepare(
      'b',
      {
        ...f.request,
        descriptor: { ...f.request.descriptor, origin: [10, 0, 0] },
      },
      f.source(),
    );
    f.owner.complete(true);
    f.owner.begin();
    f.owner.abortFeature('a');
    f.owner.complete(true);
    expect(destroyed).not.toHaveBeenCalledWith(a.buffer);
    expect(destroyed).toHaveBeenCalledWith(b.buffer);
  } finally {
    f.owner.dispose();
  }
});

it('reuses an unchanged accepted scene without enumerating its Mesh holders', async () => {
  const f = await fixture();
  try {
    f.owner.begin();
    const first = f.owner.prepare('a', f.request, f.source());
    f.owner.complete(true);
    const source = f.source();
    Object.defineProperty(source.retained, 'slots', {
      get() {
        throw new Error('unchanged Scene SDF must not enumerate scene slots');
      },
    });
    f.owner.begin();
    expect(f.owner.prepare('a', f.request, source).buffer).toBe(first.buffer);
    f.owner.complete(true);
  } finally {
    f.owner.dispose();
  }
});

it.each([
  { world: -1 },
  { world: 0.5 },
  { descriptor: { spacing: Number.NaN } },
  { descriptor: { dimensions: [1, 3, 3] } },
  { descriptor: { dimensions: [129, 3, 3] } },
])('rejects malformed ranges before GPU allocation (%j)', async (patch) => {
  const f = await fixture();
  const created = vi.spyOn(f.device, 'createBuffer');
  try {
    f.owner.begin();
    expect(() =>
      f.owner.prepare(
        'a',
        {
          ...f.request,
          ...patch,
          descriptor: { ...f.request.descriptor, ...patch.descriptor },
        } as typeof f.request,
        f.source(),
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'scene-sdf-unavailable',
        detail: expect.objectContaining({ reason: 'invalid-range' }),
      }),
    );
    expect(created).not.toHaveBeenCalled();
    f.owner.complete(false);
  } finally {
    f.owner.dispose();
  }
});

it('retains shared fields through the last accepted submission fence and rejected replacement', async () => {
  const f = await fixture();
  const destroyed = vi.spyOn(f.device, 'destroyBuffer');
  let finish = () => {};
  const fence = new Promise<void>((resolve) => {
    finish = resolve;
  });
  try {
    f.owner.begin();
    const first = f.owner.prepare('a', f.request, f.source());
    expect(f.owner.prepare('b', f.request, f.source()).buffer).toBe(first.buffer);
    f.owner.complete(true, fence);
    f.changeSource();
    f.owner.begin();
    const rejected = f.owner.prepare('a', f.request, f.source());
    f.owner.complete(false);
    expect(destroyed).toHaveBeenCalledWith(rejected.buffer);
    expect(destroyed).not.toHaveBeenCalledWith(first.buffer);
    f.owner.dispose();
    expect(destroyed).not.toHaveBeenCalledWith(first.buffer);
    finish();
    await fence;
    await Promise.resolve();
    expect(destroyed).toHaveBeenCalledWith(first.buffer);
  } finally {
    finish();
    f.owner.dispose();
  }
});

it('retires detached World fields only after their last submission completes', async () => {
  const f = await fixture();
  const destroyed = vi.spyOn(f.device, 'destroyBuffer');
  let finish = () => {};
  const fence = new Promise<void>((resolve) => {
    finish = resolve;
  });
  try {
    f.owner.begin();
    const source = f.source();
    const field = f.owner.prepare('player', f.request, source);
    f.owner.complete(true, fence);
    f.owner.detach(source.scopes[0]);
    expect(destroyed).not.toHaveBeenCalledWith(field.buffer);
    finish();
    await fence;
    await Promise.resolve();
    expect(destroyed).toHaveBeenCalledWith(field.buffer);
    expect(destroyed).toHaveBeenCalledTimes(5);
    f.owner.detach(source.scopes[0]);
    f.owner.dispose();
    expect(destroyed).toHaveBeenCalledTimes(5);
  } finally {
    finish();
    f.owner.dispose();
  }
});

it('rejects a changing source inside one transaction and releases the original candidate', async () => {
  const f = await fixture();
  const destroyed = vi.spyOn(f.device, 'destroyBuffer');
  try {
    f.owner.begin();
    const candidate = f.owner.prepare('a', f.request, f.source());
    f.changeSource();
    expect(() => f.owner.prepare('a', f.request, f.source())).toThrow(
      expect.objectContaining({
        code: 'scene-sdf-unavailable',
        detail: expect.objectContaining({ reason: 'missing-source' }),
      }),
    );
    f.owner.complete(false);
    expect(destroyed).toHaveBeenCalledWith(candidate.buffer);
  } finally {
    f.owner.dispose();
  }
});

it('takes scene source from the active recording call while sharing one field owner', async () => {
  const f = await fixture();
  const inputs = createFeatureSceneInputs(f.internals, () => undefined);
  try {
    inputs.begin(0);
    expect(() => inputs.prepare('inactive-primary', f.request)).toThrow(
      expect.objectContaining({
        code: 'scene-sdf-unavailable',
        detail: { reason: 'missing-source', world: 0 },
      }),
    );
    const source = f.source();
    const first = inputs.prepare('active-view-a', f.request, source);
    expect(inputs.prepare('active-view-b', f.request, source)).toEqual(first);
    inputs.complete(true);
    f.changeSource();
    inputs.begin(1);
    const replacement = inputs.prepare('active-view-b', f.request, f.source());
    expect(replacement).not.toEqual(first);
    inputs.complete(true);
  } finally {
    inputs.dispose();
    f.owner.dispose();
  }
});

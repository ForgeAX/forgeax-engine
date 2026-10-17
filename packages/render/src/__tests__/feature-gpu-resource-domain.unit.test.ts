import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import {
  createRenderFeatureGpuWorkOwner,
  type RenderFeatureGpuBufferRef,
  type RenderFeatureGpuResourceDomain,
} from '../features/prepared-gpu-work';

const descriptor = {
  wgsl: 'synthetic',
  entryPoints: ['main'],
  bindings: [{ entries: [{ binding: 0, visibility: 4, buffer: { type: 'storage' as const } }] }],
};

async function fixture(identity = 'resource-domain') {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const factory = { createShaderModule: () => ok(shader) };
  const owner = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => factory,
  });
  const session = owner.beginFeature(identity, 0);
  const program = session.prepareProgram('program', descriptor).unwrap();
  const buffer = session.prepareBuffer('state', { size: 64, usage: ['storage'] }).unwrap();
  const bind = (reference: RenderFeatureGpuBufferRef, offset = 0, size = 16) =>
    session
      .prepareBindings('bindings', {
        program,
        entries: [{ binding: 0, buffer: reference, offset, size }],
      })
      .unwrap();
  const bindings = bind(buffer);
  const capture = () =>
    session
      .captureResourceDomain({ programs: [], buffers: [], bindings: [bindings, bindings] })
      .unwrap();
  return { device, owner, session, program, buffer, bindings, bind, capture };
}

const release = (leases: readonly { release(): { unwrap(): unknown } }[]) => {
  for (const lease of leases) lease.release().unwrap();
};

it('captures binding dependencies once and revives a complete parked owned domain', async () => {
  const f = await fixture('forgeax.vfx-render.gpu-particles');
  const buffers = vi.spyOn(f.device, 'createBuffer');
  const groups = vi.spyOn(f.device, 'createBindGroup');
  try {
    const domain = f.capture();
    release(f.session.commitFrame());
    f.session.beginFrame();
    release(f.session.commitFrame());
    f.session.beginFrame();
    expect(f.session.retainResourceDomain(domain).unwrap()).toBe(true);
    expect(f.session.resolveBuffer(f.buffer)).toBeDefined();
    release(f.session.commitFrame());
    f.session.beginFrame();
    expect(f.session.retainResourceDomain(domain).unwrap()).toBe(true);
    expect(f.bind(f.buffer)).toBe(f.bindings);
    expect(buffers).not.toHaveBeenCalled();
    expect(groups).not.toHaveBeenCalled();
  } finally {
    buffers.mockRestore();
    groups.mockRestore();
    f.owner.dispose().unwrap();
  }
});

it('rejects same-name replacements even while old refs remain valid until the fence', async () => {
  for (const replace of ['buffer', 'bindings', 'program']) {
    const f = await fixture();
    try {
      const domain = f.capture();
      release(f.session.commitFrame());
      f.session.beginFrame();
      if (replace === 'buffer')
        f.session.prepareBuffer('state', { size: 128, usage: ['storage'] }).unwrap();
      else if (replace === 'bindings') f.bind(f.buffer, 0, 32);
      else f.session.prepareProgram('program', { ...descriptor, wgsl: 'replacement' }).unwrap();
      expect(f.session.retainResourceDomain(domain).unwrap()).toBe(false);
      expect(
        f.session.captureResourceDomain({ programs: [], buffers: [], bindings: [f.bindings] }).ok,
      ).toBe(false);
      expect(f.session.resolveBuffer(f.buffer)).toBeDefined();
      f.session.abortFrame().unwrap();
      f.session.beginFrame();
      expect(f.session.retainResourceDomain(domain).unwrap()).toBe(true);
      expect(f.bind(f.buffer)).toBe(f.bindings);
    } finally {
      f.owner.dispose().unwrap();
    }
  }
});

it('does not turn an aborted cold admission into a reusable domain', async () => {
  const f = await fixture();
  try {
    const domain = f.capture();
    f.session.abortFrame().unwrap();
    f.session.beginFrame();
    expect(f.session.retainResourceDomain(domain).unwrap()).toBe(false);
    expect(f.session.writeBuffer(f.buffer, 0, new Uint32Array([1])).ok).toBe(false);
    const program = f.session.prepareProgram('program', descriptor).unwrap();
    const buffer = f.session.prepareBuffer('state', { size: 64, usage: ['storage'] }).unwrap();
    const bindings = f.session
      .prepareBindings('bindings', { program, entries: [{ binding: 0, buffer }] })
      .unwrap();
    const next = f.session
      .captureResourceDomain({ programs: [program], buffers: [buffer], bindings: [bindings] })
      .unwrap();
    expect(f.session.retainResourceDomain(domain).unwrap()).toBe(false);
    expect(f.session.retainResourceDomain(next).unwrap()).toBe(true);
  } finally {
    f.owner.dispose().unwrap();
  }
});

it('rejects forged, foreign-session, old-generation and disposed domains', async () => {
  const f = await fixture();
  const domain = f.capture();
  expect(f.session.retainResourceDomain({} as RenderFeatureGpuResourceDomain).unwrap()).toBe(false);
  const other = f.owner.beginFeature('other', 0);
  expect(other.retainResourceDomain(domain).unwrap()).toBe(false);
  const recovered = f.owner.beginFeature('resource-domain', 1);
  expect(recovered.retainResourceDomain(domain).unwrap()).toBe(false);
  expect(
    recovered.captureResourceDomain({
      programs: [f.program],
      buffers: [f.buffer],
      bindings: [f.bindings],
    }).ok,
  ).toBe(false);
  f.owner.dispose().unwrap();
  expect(f.session.retainResourceDomain(domain).unwrap()).toBe(false);
});

it('keeps independent completion leases and a failed retain never revives an old buffer', async () => {
  const f = await fixture();
  const destroyed = vi.spyOn(f.device, 'destroyBuffer');
  try {
    const first = f.capture();
    const firstPhysical = f.session.resolveBuffer(f.buffer)?.buffer;
    release(f.session.commitFrame());
    f.session.beginFrame();
    const secondBuffer = f.session
      .prepareBuffer('state', { size: 128, usage: ['storage'] })
      .unwrap();
    const secondPhysical = f.session.resolveBuffer(secondBuffer)?.buffer;
    const secondBinding = f.bind(secondBuffer);
    const second = f.session
      .captureResourceDomain({ programs: [], buffers: [], bindings: [secondBinding] })
      .unwrap();
    const firstFence = f.session.commitFrame();
    f.session.beginFrame();
    const thirdBuffer = f.session
      .prepareBuffer('state', { size: 256, usage: ['storage'] })
      .unwrap();
    const thirdPhysical = f.session.resolveBuffer(thirdBuffer)?.buffer;
    const thirdBinding = f.bind(thirdBuffer);
    const third = f.session
      .captureResourceDomain({ programs: [], buffers: [], bindings: [thirdBinding] })
      .unwrap();
    const secondFence = f.session.commitFrame();
    f.session.beginFrame();
    expect(f.session.retainResourceDomain(first).unwrap()).toBe(false);
    expect(f.session.retainResourceDomain(second).unwrap()).toBe(false);
    expect(f.session.retainResourceDomain(third).unwrap()).toBe(true);
    expect(destroyed).not.toHaveBeenCalled();
    release(secondFence);
    expect(destroyed).toHaveBeenCalledExactlyOnceWith(secondPhysical);
    expect(destroyed).not.toHaveBeenCalledWith(firstPhysical);
    release(firstFence);
    expect(destroyed).toHaveBeenCalledWith(firstPhysical);
    expect(destroyed).not.toHaveBeenCalledWith(thirdPhysical);
    expect(f.session.retainResourceDomain(first).unwrap()).toBe(false);
    expect(f.session.writeBuffer(f.buffer, 0, new Uint32Array([1])).ok).toBe(false);
    expect(destroyed).toHaveBeenCalledTimes(2);
    release(firstFence);
    release(secondFence);
    expect(destroyed).toHaveBeenCalledTimes(2);
  } finally {
    destroyed.mockRestore();
    f.owner.dispose().unwrap();
  }
});

it('writes current bytes in call order and rejects invalid writes before touching the queue', async () => {
  const f = await fixture();
  const writes = vi.spyOn(f.device.queue, 'writeBuffer');
  try {
    f.session.writeBuffer(f.buffer, 0, new Uint32Array([1, 2])).unwrap();
    const bytes = new Uint8Array([0, 9, 8, 7, 6]);
    f.session.writeBuffer(f.buffer, 4, new DataView(bytes.buffer, 1, 4)).unwrap();
    expect(writes.mock.calls.map((call) => call[1])).toEqual([0, 4]);
    expect(writes.mock.calls.map((call) => Array.from(call[2] as Uint8Array))).toEqual([
      [1, 0, 0, 0, 2, 0, 0, 0],
      [9, 8, 7, 6],
    ]);
    for (const offset of [-4, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1, 2, 64])
      expect(f.session.writeBuffer(f.buffer, offset, new Uint32Array([3])).ok).toBe(false);
    expect(f.session.writeBuffer(f.buffer, 0, new Uint8Array(3)).ok).toBe(false);
    f.session.prepareBuffer('state', { size: 128, usage: ['storage'] }).unwrap();
    expect(f.session.writeBuffer(f.buffer, 0, new Uint32Array([4])).ok).toBe(false);
    expect(writes).toHaveBeenCalledTimes(2);
  } finally {
    writes.mockRestore();
    f.owner.dispose().unwrap();
  }
});

it('rejects provider buffers and bindings instead of borrowing external lifetime authority', async () => {
  const f = await fixture();
  const external = f.device.createBuffer({ size: 64, usage: 0x0088 }).unwrap();
  try {
    const borrowed = f.session
      .prepareBufferResource('provider', external, { size: 64, usage: ['storage'] })
      .unwrap();
    expect(
      f.session.captureResourceDomain({ programs: [], buffers: [borrowed], bindings: [] }).ok,
    ).toBe(false);
    const bindings = f.session
      .prepareBindings('provider', {
        program: f.program,
        entries: [{ binding: 0, buffer: borrowed }],
      })
      .unwrap();
    expect(
      f.session.captureResourceDomain({ programs: [], buffers: [], bindings: [bindings] }).ok,
    ).toBe(false);
  } finally {
    f.owner.dispose().unwrap();
    f.device.destroyBuffer(external).unwrap();
  }
});

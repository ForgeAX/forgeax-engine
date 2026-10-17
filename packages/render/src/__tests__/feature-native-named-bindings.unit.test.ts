import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import {
  createRenderFeatureGpuWorkOwner,
  type RenderFeatureGpuBufferRef,
  type RenderFeatureGpuPreparedResourceRef,
} from '../features/prepared-gpu-work';

const descriptor = {
  wgsl: 'synthetic',
  entryPoints: ['main'],
  bindings: [
    {
      entries: [
        { binding: 0, visibility: 4, buffer: { type: 'storage' as const, minBindingSize: 16 } },
      ],
    },
  ],
};

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const owner = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
  });
  const session = owner.beginFeature('named-bindings', 0);
  const program = session.prepareProgram('program', descriptor).unwrap();
  const buffer = session.prepareBuffer('arena', { size: 1024, usage: ['storage'] }).unwrap();
  const buffers = new Map<string, RenderFeatureGpuBufferRef>([['local', buffer]]);
  const resources = new Map<string, RenderFeatureGpuPreparedResourceRef>();
  const scope = { buffers, resources };
  const entry = { binding: 0, resource: 'local', offset: 256, size: 32 };
  const prepare = () =>
    session.prepareNamedBindings('binding', { program, entries: [entry] }, scope);
  return { device, owner, session, program, buffer, buffers, resources, scope, entry, prepare };
}

it('consumes named entries directly and shares exact references with the generic path', async () => {
  const f = await fixture();
  const groups = vi.spyOn(f.device, 'createBindGroup');
  try {
    const entries = [f.entry];
    entries.map = () => {
      throw Error('Intermediate entry projection');
    };
    const named = f.session
      .prepareNamedBindings('binding', { program: f.program, entries }, f.scope)
      .unwrap();
    const generic = f.session
      .prepareBindings('binding', {
        program: f.program,
        entries: [{ binding: 0, buffer: f.buffer, offset: 256, size: 32 }],
      })
      .unwrap();
    expect(generic).toBe(named);
    expect(groups).toHaveBeenCalledOnce();
    expect(Array.from(groups.mock.calls[0]?.[0].entries ?? [])[0]?.resource).toEqual({
      kind: 'buffer',
      value: { buffer: f.session.resolveBuffer(f.buffer)?.buffer, offset: 256, size: 32 },
    });
  } finally {
    groups.mockRestore();
    f.owner.dispose().unwrap();
  }
});

it('revalidates mutable ranges and the current program layout before warm reuse', async () => {
  const f = await fixture();
  try {
    const first = f.prepare().unwrap();
    for (const range of [
      { offset: 1, size: 32 },
      { offset: 256, size: 12 },
      { offset: 1024, size: 32 },
    ]) {
      Object.assign(f.entry, range);
      expect(f.prepare().ok).toBe(false);
    }
    Object.assign(f.entry, { offset: 512, size: 32 });
    expect(f.prepare().unwrap()).not.toBe(first);
    const program = f.session
      .prepareProgram('program', {
        ...descriptor,
        bindings: [
          {
            entries: [
              { binding: 0, visibility: 4, buffer: { type: 'storage', minBindingSize: 64 } },
            ],
          },
        ],
      })
      .unwrap();
    expect(
      f.session.prepareNamedBindings('binding', { program, entries: [f.entry] }, f.scope).ok,
    ).toBe(false);
  } finally {
    f.owner.dispose().unwrap();
  }
});

it('resolves the current scope reference and preserves physical aliases', async () => {
  const f = await fixture();
  try {
    const first = f.prepare().unwrap();
    const next = f.session.prepareBuffer('arena', { size: 2048, usage: ['storage'] }).unwrap();
    f.buffers.set('local', next);
    const second = f.prepare().unwrap();
    expect(second).not.toBe(first);
    f.resources.set('borrowed', { kind: 'buffer', reference: next });
    const alias = f.session
      .prepareNamedBindings(
        'alias',
        { program: f.program, entries: [{ ...f.entry, resource: 'borrowed' }] },
        f.scope,
      )
      .unwrap();
    const work = f.session
      .resolveComputePass('named-bindings', {
        program: f.program,
        bindings: second,
        dispatches: [
          { entryPoint: 'main', workgroups: [1] },
          { entryPoint: 'main', bindings: alias, workgroups: [1] },
        ],
      })
      .unwrap();
    expect(work.buffers).toHaveLength(1);
    expect(work.buffers[0]?.buffer).toBe(f.session.resolveBuffer(next)?.buffer);
  } finally {
    f.owner.dispose().unwrap();
  }
});

it('rejects missing and aborted references without publishing a replacement binding', async () => {
  const f = await fixture();
  try {
    const accepted = f.prepare().unwrap();
    for (const lease of f.session.commitFrame()) lease.release().unwrap();
    f.session.beginFrame();
    const transient = f.session.prepareBuffer('arena', { size: 2048, usage: ['storage'] }).unwrap();
    f.buffers.set('local', transient);
    expect(f.prepare().unwrap()).not.toBe(accepted);
    f.session.abortFrame().unwrap();
    expect(f.prepare().ok).toBe(false);
    f.buffers.delete('local');
    expect(f.prepare().ok).toBe(false);
    f.buffers.set('local', f.buffer);
    expect(f.prepare().unwrap()).toBe(accepted);
  } finally {
    f.owner.dispose().unwrap();
  }
});

it('rejects references from a previous device generation', async () => {
  const f = await fixture();
  try {
    const accepted = f.prepare().unwrap();
    const lease = f.session.commitFrame();
    const recovered = f.owner.beginFeature('named-bindings', 1);
    expect(
      recovered.prepareNamedBindings('binding', { program: f.program, entries: [f.entry] }, f.scope)
        .ok,
    ).toBe(false);
    const program = recovered.prepareProgram('program', descriptor).unwrap();
    expect(
      recovered.prepareNamedBindings('binding', { program, entries: [f.entry] }, f.scope).ok,
    ).toBe(false);
    expect(
      f.session.resolveComputePass('named-bindings', {
        program: f.program,
        bindings: accepted,
        dispatches: [{ entryPoint: 'main', workgroups: [1] }],
      }).ok,
    ).toBe(false);
    for (const item of lease) item.release().unwrap();
  } finally {
    f.owner.dispose().unwrap();
  }
});

it('keeps the generic mutable descriptor getter reads and validation unchanged', async () => {
  const f = await fixture();
  try {
    const reads: string[] = [];
    const entry = {
      binding: 0,
      get buffer() {
        reads.push('buffer');
        return f.buffer;
      },
      get offset() {
        reads.push('offset');
        return 256;
      },
      get size() {
        reads.push('size');
        return 32;
      },
    };
    f.session.prepareBindings('generic', { program: f.program, entries: [entry] }).unwrap();
    expect(reads).toEqual(['buffer', 'buffer', 'offset', 'size', 'offset', 'size']);
  } finally {
    f.owner.dispose().unwrap();
  }
});

it('keeps late targets unresolved until encoding and validates non-buffer ranges', async () => {
  const f = await fixture();
  try {
    const program = f.session
      .prepareProgram('late-program', {
        wgsl: 'synthetic',
        entryPoints: ['main'],
        bindings: [{ entries: [{ binding: 0, visibility: 4, texture: { sampleType: 'float' } }] }],
      })
      .unwrap();
    const texture = f.session.prepareTextureView('depth', undefined, 'depth').unwrap();
    f.resources.set('target', { kind: 'texture-view', reference: texture });
    const entries = [{ binding: 0, resource: 'target' }];
    const binding = f.session
      .prepareNamedBindings('late-binding', { program, entries }, f.scope)
      .unwrap();
    const work = f.session
      .resolveComputePass('named-bindings', {
        program,
        bindings: binding,
        dispatches: [{ entryPoint: 'main', workgroups: [1] }],
      })
      .unwrap();
    expect(work.sampledTargets).toEqual(['depth']);
    expect(work.dispatches[0]?.resolveBindGroup).toBeTypeOf('function');
    expect(
      f.session.prepareNamedBindings(
        'late-binding',
        {
          program,
          entries: [{ ...entries[0], binding: 0, resource: 'target', offset: 0 }],
        },
        f.scope,
      ).ok,
    ).toBe(false);
    expect(
      f.session.prepareNamedBindings('late-binding', { program, entries }, f.scope).unwrap(),
    ).toBe(binding);
  } finally {
    f.owner.dispose().unwrap();
  }
});

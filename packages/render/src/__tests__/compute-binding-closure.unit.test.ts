import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createRenderFeatureGpuWorkOwner } from '../features/prepared-gpu-work';
import { createRenderFeatureTarget } from '../features/targets';

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const owner = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
  });
  const session = owner.beginFeature('compute-closure', 0);
  const program = session
    .prepareProgram('program', {
      wgsl: 'synthetic',
      entryPoints: ['main'],
      bindings: [
        {
          entries: [
            { binding: 0, visibility: 4, buffer: { type: 'read-only-storage' } },
            { binding: 1, visibility: 4, buffer: { type: 'storage' } },
          ],
        },
      ],
    })
    .unwrap();
  const buffer = session
    .prepareBuffer('state', { size: 512, usage: ['storage', 'indirect'] })
    .unwrap();
  const binding = (name: string, offset = 0) =>
    session
      .prepareBindings(name, {
        program,
        entries: [
          { binding: 0, buffer, offset, size: 16 },
          { binding: 1, buffer, offset: 256, size: 16 },
        ],
      })
      .unwrap();
  return { owner, session, program, buffer, binding };
}

it('keeps every dispatch while deriving the shared binding closure once', async () => {
  const f = await fixture();
  try {
    const bindings = f.binding('shared');
    const resolved = f.session
      .resolveComputePass('compute-closure', {
        program: f.program,
        bindings,
        dispatches: [1, 0, 2, 3].map((count) => ({
          entryPoint: 'main',
          bindings,
          workgroups: [count] as const,
        })),
      })
      .unwrap();
    expect(resolved.dispatches.map((d) => d.workgroups)).toEqual([
      [1, 1, 1],
      [2, 1, 1],
      [3, 1, 1],
    ]);
    expect(resolved.buffers).toMatchObject([
      { name: 'state', size: 512, access: 'storage-read-write' },
    ]);
    expect(resolved.buffers).toHaveLength(1);
    f.session.commitFrame();
    f.session.beginFrame();
    expect(
      f.session
        .resolveComputePass('compute-closure', {
          program: f.program,
          bindings,
          dispatches: [{ entryPoint: 'main', workgroups: [0] }],
        })
        .unwrap().buffers,
    ).toEqual(resolved.buffers);
  } finally {
    f.owner.dispose().unwrap();
  }
});

it('retains distinct bindings that alias one physical buffer and validates each command', async () => {
  const f = await fixture();
  try {
    const first = f.binding('first'),
      second = f.binding('second', 256);
    const dispatches = [first, first, second, second].map((bindings) => ({
      entryPoint: 'main',
      bindings,
      workgroups: [1] as const,
    }));
    const result = f.session
      .resolveComputePass('compute-closure', { program: f.program, bindings: first, dispatches })
      .unwrap();
    expect(result.dispatches).toHaveLength(4);
    expect(result.dispatches[0]?.bindGroup).toBe(result.dispatches[1]?.bindGroup);
    expect(result.dispatches[2]?.bindGroup).toBe(result.dispatches[3]?.bindGroup);
    expect(result.dispatches[0]?.bindGroup).not.toBe(result.dispatches[2]?.bindGroup);
    expect(result.buffers).toHaveLength(1);
    expect(
      f.session.resolveComputePass('compute-closure', {
        program: f.program,
        bindings: first,
        dispatches: [...dispatches, { entryPoint: 'main', bindings: second, workgroups: [-1] }],
      }),
    ).toMatchObject({ ok: false, error: { detail: { reason: 'workgroup-count-invalid' } } });
    expect(
      f.session.resolveComputePass('compute-closure', {
        program: f.program,
        bindings: first,
        dispatches: [...dispatches, { entryPoint: 'missing', bindings: second, workgroups: [0] }],
      }),
    ).toMatchObject({ ok: false, error: { detail: { reason: 'entry-point-unavailable' } } });
  } finally {
    f.owner.dispose().unwrap();
  }
});

it('keeps separate indirect offsets, indirect-read usage and generation rejection', async () => {
  const f = await fixture();
  try {
    const bindings = f.binding('shared');
    const descriptor = {
      program: f.program,
      bindings,
      dispatches: [0, 12, 24].map((offset) => ({
        entryPoint: 'main',
        bindings,
        indirect: { buffer: f.buffer, offset },
      })),
    };
    const resolved = f.session.resolveComputePass('compute-closure', descriptor).unwrap();
    expect(resolved.dispatches.map((d) => d.indirectOffset)).toEqual([0, 12, 24]);
    expect(resolved.buffers.map((b) => b.access)).toEqual(['storage-read-write', 'indirect-read']);
    const last = descriptor.dispatches[2];
    if (last === undefined) throw new Error('Missing indirect fixture');
    last.indirect.offset = 508;
    expect(f.session.resolveComputePass('compute-closure', descriptor)).toMatchObject({
      ok: false,
      error: { detail: { reason: 'indirect-dispatch-invalid' } },
    });
    const next = f.owner.beginFeature('compute-closure', 1);
    expect(next.resolveComputePass('compute-closure', descriptor).ok).toBe(false);
  } finally {
    f.owner.dispose().unwrap();
  }
});

it('preserves late-bound target closure and first-use ordering across different bindings', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const owner = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
  });
  try {
    const session = owner.beginFeature('targets', 0);
    const program = session
      .prepareProgram('program', {
        wgsl: 'synthetic',
        entryPoints: ['main'],
        bindings: [
          {
            entries: [
              { binding: 0, visibility: 4, texture: { sampleType: 'float' } },
              {
                binding: 1,
                visibility: 4,
                storageTexture: { access: 'write-only', format: 'rgba8unorm' },
              },
            ],
          },
        ],
      })
      .unwrap();
    const targets = ['first', 'second', 'storage'].map((name) =>
      createRenderFeatureTarget({
        name,
        kind: 'scene-color',
        format: 'rgba8unorm',
        sampleCount: 1,
      }),
    );
    const references = targets.map((target, index) =>
      session.prepareTextureView(`view-${index}`, undefined, target).unwrap(),
    );
    const bindings = [0, 1].map((index) =>
      session
        .prepareBindings(`binding-${index}`, {
          program,
          entries: [
            {
              binding: 0,
              resource: {
                kind: 'texture-view',
                reference: references[index] as NonNullable<(typeof references)[number]>,
              },
            },
            {
              binding: 1,
              resource: {
                kind: 'texture-view',
                reference: references[2] as NonNullable<(typeof references)[number]>,
              },
            },
          ],
        })
        .unwrap(),
    );
    const first = bindings[0],
      second = bindings[1];
    if (first === undefined || second === undefined) throw new Error('Missing target bindings');
    const result = session
      .resolveComputePass('targets', {
        program,
        bindings: first,
        dispatches: [first, first, second, second].map((binding, index) => ({
          entryPoint: 'main',
          bindings: binding,
          workgroups: [index % 2] as const,
        })),
      })
      .unwrap();
    expect(result.dispatches).toHaveLength(2);
    expect(result.sampledTargets).toEqual(targets.slice(0, 2));
    expect(result.storageTargets).toEqual([targets[2]]);
    expect(result.dispatches.every((d) => d.resolveBindGroup !== undefined)).toBe(true);
  } finally {
    owner.dispose().unwrap();
  }
});

import { type ComputePipeline, type Result, RhiError } from '@forgeax/engine-rhi';
import { createShaderModule, RhiNullAdapter, rhi } from '@forgeax/engine-rhi-null';
import { err, ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import type { StandardScreenProbeGi } from '../../pipeline/standard-profile';
import type { PreparedIrradianceField } from '../../raytracing/renderer-irradiance-field';
import {
  RendererScreenProbe,
  type ScreenSoftwareWorld,
} from '../../raytracing/renderer-screen-probe';
import { SCREEN_PROBE_STAGES } from '../../raytracing/screen-probe-kernels';
import { SCREEN_PROBE_DEFAULTS } from '../../raytracing/screen-probe-plan';
import type { WorldTraversal } from '../../raytracing/world-traversal';
import type { RenderSystemInternals } from '../../record/render-context';

const profile: StandardScreenProbeGi = {
  gather: 'screen-probe',
  maxDistance: 4,
  environment: [0, 0, 0],
  probes: SCREEN_PROBE_DEFAULTS,
  field: {
    region: {
      grid: {
        origin: [-1, -1, -1],
        dimensions: [3, 3, 3],
        spacing: 1,
        maxDistance: 4,
        coverageDistance: 1,
      },
      maxInstances: 2,
      maxFieldBytes: 1024 * 1024,
    },
    probeSpacing: 1,
    raysPerProbe: 16,
    probeBudget: 2,
    hysteresis: 0.9,
    cards: { resolution: 16, maxCaptureBytes: 1024 * 1024, budget: 16 },
    resolution: 'half',
    radiosity: true,
  },
};

const meshDfMode: ScreenSoftwareWorld = {
  kind: 'mesh-df',
  policy: { receiverBiasVoxels: 1, expansionVoxels: 0.5, maxErrorVoxels: 16 },
};

async function fixture(rayQuery = false, probes = profile.probes, atlas = false) {
  const adapter = rayQuery
    ? new RhiNullAdapter({
        rayQuery: {
          maxBlasGeometryCount: 1,
          maxBlasPrimitiveCount: 1024,
          maxTlasInstanceCount: 2,
          maxAccelerationStructuresPerShaderStage: 1,
        },
      })
    : (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const create = device.createComputePipeline.bind(device);
  const pending: {
    result: Result<ComputePipeline, RhiError>;
    finish: (result: Result<ComputePipeline, RhiError>) => void;
  }[] = [];
  const asyncCreate = vi.fn(
    (descriptor: Parameters<typeof create>[0]) =>
      new Promise<Result<ComputePipeline, RhiError>>((finish) => {
        pending.push({ result: create(descriptor), finish });
      }),
  );
  Object.assign(device, { createComputePipelineAsync: asyncCreate });
  const source = '@compute @workgroup_size(64) fn integrateScreenProbes() {}';
  const generate = '@compute @workgroup_size(64) fn generateCachedProbeRays() {}';
  const runtime = {
    device,
    deviceScope: { generation: 1 },
    shaderRegistry: {
      entries: () => [
        { wgsl: source },
        { wgsl: generate },
        ...(atlas ? [{ wgsl: '@compute fn lightTraceFallbacksAtlas() {}' }] : []),
      ],
    },
    createShaderModule: vi.fn(createShaderModule),
    errorRegistry: { fire: vi.fn() },
  } as unknown as RenderSystemInternals;
  const screen = new RendererScreenProbe();
  const prepare = (
    field?: PreparedIrradianceField,
    softwareWorld?: ScreenSoftwareWorld,
    plannedTraversal?: WorldTraversal,
    reconstruction?: 'current-support',
    plannedFarRadiance?: boolean,
  ) =>
    screen.prepare({
      runtime,
      visibleSurface: true,
      profile: { ...profile, probes },
      field,
      plannedTraversal,
      plannedFarRadiance,
      width: 16,
      height: 16,
      ...(softwareWorld === undefined ? {} : { softwareWorld }),
      ...(reconstruction === undefined ? {} : { reconstruction }),
    });
  const finish = () => {
    const item = pending.shift();
    if (!item) throw new Error('no pending completion');
    item.finish(item.result);
  };
  const drain = async () => {
    for (let i = 0; i < 400; i++) {
      while (pending.length) finish();
      await Promise.resolve();
    }
  };
  const field = (generation = 1) =>
    ({
      generation,
      traversal: 'global-sdf',
      fence: { currentGeneration: () => generation },
      plan: { grid: { spacing: 1 } },
      retained: { revision: 0 },
      receivers: ok({ state: 'unavailable', reason: 'field-not-ready' }),
      screenProbeHistory: () => 'stable',
      track: vi.fn(),
      commit: vi.fn(),
    }) as unknown as PreparedIrradianceField;
  return { device, runtime, screen, prepare, asyncCreate, pending, finish, drain, field };
}

it('rejects Mesh DF estimates before requesting pipelines for strict reference reconstruction', async () => {
  const f = await fixture();
  try {
    f.prepare(f.field(), meshDfMode);
    await f.drain();
    expect(f.runtime.errorRegistry.fire).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(f.runtime.errorRegistry.fire).mock.calls)).toContain(
      'current-support',
    );
    expect(f.runtime.createShaderModule).not.toHaveBeenCalled();
    expect(f.asyncCreate).not.toHaveBeenCalled();
    expect(f.screen.ready).toBeUndefined();
  } finally {
    f.screen.dispose();
    await f.drain();
  }
});

it('rejects late Mesh DF publication after selecting strict reconstruction and recovers explicitly', async () => {
  const f = await fixture();
  try {
    const field = f.field();
    f.prepare(field, meshDfMode, undefined, 'current-support');
    await vi.waitFor(() =>
      expect(f.asyncCreate.mock.calls.map(([d]) => d.compute.entryPoint)).toContain(
        'traceWorldProbes',
      ),
    );
    const requested = f.asyncCreate.mock.calls.length;
    f.prepare(field, meshDfMode);
    await f.drain();
    f.prepare(field, meshDfMode);
    expect(f.runtime.errorRegistry.fire).toHaveBeenCalledTimes(1);
    expect(f.asyncCreate).toHaveBeenCalledTimes(requested);
    expect(f.screen.ready).toBeUndefined();
    f.prepare(field, meshDfMode, undefined, 'current-support');
    await f.drain();
    f.prepare(field, meshDfMode, undefined, 'current-support');
    expect(f.screen.ready?.field).toBe(field);
    expect(f.asyncCreate.mock.calls.length).toBeGreaterThan(requested);
  } finally {
    f.screen.dispose();
    await f.drain();
  }
});

it('reconstruction policy changes replace the prepared generation and reject previous history flags', async () => {
  const f = await fixture();
  const field = f.field();
  Object.assign(field, {
    plan: { grid: { spacing: 1 }, querySettings: new Uint8Array(8) },
    canonical: { expected: [36, 32, 1, 1] },
    editStats: () => ({ pendingTiles: 0, pendingPriorityUpdates: 0 }),
  });
  const writes = vi.spyOn(f.device.queue, 'writeBuffer');
  try {
    f.prepare(field);
    await f.drain();
    f.prepare(field);
    const old = f.screen.ready;
    if (old === undefined) throw new Error('Expected strict prepared generation');
    old.writeFrame();
    old.commit();
    f.prepare(field, undefined, undefined, 'current-support');
    const next = f.screen.ready;
    if (next === undefined) throw new Error('Expected current-support prepared generation');
    expect(next.generation).toBeGreaterThan(old.generation);
    next.writeFrame();
    next.commit();
    next.writeFrame();
    const bytes = writes.mock.calls.filter(([buffer]) => buffer === next.frame.buffer).at(-1)?.[2];
    if (!(bytes instanceof Uint8Array)) throw new Error('Expected actual policy frame upload');
    expect(new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)[10]).toBe(15);
    f.prepare(field);
    expect(f.screen.ready?.generation).toBeGreaterThan(next.generation);
  } finally {
    writes.mockRestore();
    f.screen.dispose();
    await f.drain();
  }
});

it('allows Screen endpoint candidates while preparing canonical World with the actual Field', async () => {
  const f = await fixture();
  const field = f.field();
  Object.assign(field, {
    plan: { grid: { spacing: 1 }, querySettings: new Uint8Array(8) },
    canonical: { expected: [36, 32, 1, 1] },
    editStats: () => ({ pendingTiles: 0, pendingPriorityUpdates: 0 }),
  });
  const writes = vi.spyOn(f.device.queue, 'writeBuffer');
  try {
    f.prepare(field);
    await f.drain();
    f.prepare(field);
    const ready = f.screen.ready;
    expect(ready).toBeDefined();
    if (ready === undefined) throw new Error('Actual factory completion is required');
    expect(ready.field).toBe(field);
    expect(f.asyncCreate.mock.calls.map(([d]) => d.compute.entryPoint)).toEqual(
      expect.arrayContaining(['prepareScreenReceivers', 'traceWorldProbes']),
    );
    ready.writeFrame();
    ready.commit();
    ready.writeFrame();
    const frameWrites = writes.mock.calls.filter(([buffer]) => buffer === ready.frame.buffer);
    const bytes = frameWrites.at(-1)?.[2];
    if (!(bytes instanceof Uint8Array)) throw new Error('Actual frame upload required');
    const actual = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    expect((actual[10] ?? 0) & 1).toBe(1);
    expect(profile.probes.screenTrace.maxSteps).toBe(50);
    expect(actual[9]).toBe(profile.probes.screenTrace.maxSteps);
  } finally {
    writes.mockRestore();
    f.screen.dispose();
    await f.drain();
  }
});

it('requests the actual Screen pipeline factory while the shared Field is pending', async () => {
  const f = await fixture();
  try {
    f.prepare();
    await vi.waitFor(() =>
      expect(f.asyncCreate.mock.calls.map(([d]) => d.compute.entryPoint)).toContain(
        'placeUniformProbes',
      ),
    );
    expect(f.screen.ready).toBeUndefined();
    expect(f.runtime.createShaderModule).toHaveBeenCalledWith(
      f.device,
      expect.objectContaining({ label: 'screen-probe' }),
    );
  } finally {
    f.screen.dispose();
    await f.drain();
  }
});

it.each([
  undefined,
  { kind: 'paid-root' },
  { kind: 'mesh-df', policy: { receiverBiasVoxels: 1, expansionVoxels: 0.5, maxErrorVoxels: 16 } },
] as const)('prepares World from traversal demand before Field is ready without allocating resources (%s)', async (softwareWorld) => {
  const f = await fixture();
  const allocated = vi.spyOn(f.device, 'createBuffer');
  const reconstruction = softwareWorld?.kind === 'mesh-df' ? 'current-support' : undefined;
  try {
    f.prepare(undefined, softwareWorld, 'global-sdf', reconstruction);
    await vi.waitFor(() =>
      expect(f.asyncCreate.mock.calls.map(([d]) => d.compute.entryPoint)).toContain(
        'prepareScreenReceivers',
      ),
    );
    if (softwareWorld?.kind === 'paid-root')
      expect(f.asyncCreate.mock.calls.map(([d]) => d.compute.entryPoint)).toEqual(
        expect.arrayContaining(['prepareRoot', 'refineRoot']),
      );
    await f.drain();
    f.prepare(undefined, softwareWorld, 'global-sdf', reconstruction);
    expect(f.screen.ready).toBeUndefined();
    expect(allocated).not.toHaveBeenCalled();
    const requested = f.asyncCreate.mock.calls.length;
    const field = f.field();
    f.prepare(field, softwareWorld, 'global-sdf', reconstruction);
    expect(f.screen.ready?.field).toBe(field);
    expect(f.asyncCreate).toHaveBeenCalledTimes(requested);
  } finally {
    allocated.mockRestore();
    f.screen.dispose();
    await f.drain();
  }
});

it('replaces stale traversal demand and ignores its rejected completion when actual Field differs', async () => {
  const f = await fixture(true);
  try {
    f.prepare(undefined, undefined, 'global-sdf');
    await vi.waitFor(() =>
      expect(f.asyncCreate.mock.calls.map(([d]) => d.compute.entryPoint)).toContain(
        'prepareScreenReceivers',
      ),
    );
    const oldWorldIndex = f.asyncCreate.mock.calls.findIndex(
      ([d]) => d.compute.entryPoint === 'traceWorldProbes',
    );
    const oldWorld = f.pending[oldWorldIndex];
    if (!oldWorld) throw new Error('Actual pending World request required');
    const field = f.field();
    Object.assign(field, { traversal: 'ray-query' });
    f.prepare(field, undefined, 'global-sdf');
    await vi.waitFor(() =>
      expect(
        f.asyncCreate.mock.calls.filter(([d]) => d.compute.entryPoint === 'traceWorldProbes'),
      ).toHaveLength(2),
    );
    oldWorld.finish(
      err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'old software branch',
          hint: 'ignore stale demand',
        }),
      ),
    );
    f.pending.splice(oldWorldIndex, 1);
    await f.drain();
    f.prepare(field, undefined, 'global-sdf');
    expect(f.screen.ready?.field).toBe(field);
    expect(f.screen.ready?.receiver).toBeUndefined();
    expect(f.runtime.errorRegistry.fire).not.toHaveBeenCalled();
  } finally {
    f.screen.dispose();
    await f.drain();
  }
});

it('retires withdrawn traversal demand before late rejection and accepts a new hint', async () => {
  const f = await fixture(true);
  try {
    f.prepare(undefined, undefined, 'global-sdf');
    await vi.waitFor(() =>
      expect(f.asyncCreate.mock.calls.map(([d]) => d.compute.entryPoint)).toContain(
        'prepareScreenReceivers',
      ),
    );
    const oldWorldIndex = f.asyncCreate.mock.calls.findIndex(
      ([d]) => d.compute.entryPoint === 'traceWorldProbes',
    );
    const oldWorld = f.pending[oldWorldIndex];
    if (!oldWorld) throw new Error('Actual pending World request required');
    f.prepare();
    oldWorld.finish(
      err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'withdrawn branch',
          hint: 'ignore absent demand',
        }),
      ),
    );
    f.pending.splice(oldWorldIndex, 1);
    await f.drain();
    expect(f.runtime.errorRegistry.fire).not.toHaveBeenCalled();
    f.prepare(undefined, undefined, 'ray-query');
    await f.drain();
    expect(f.screen.ready).toBeUndefined();
    const field = f.field();
    Object.assign(field, { traversal: 'ray-query' });
    f.prepare(field);
    expect(f.screen.ready?.field).toBe(field);
    expect(f.screen.ready?.receiver).toBeUndefined();
  } finally {
    f.screen.dispose();
    await f.drain();
  }
});

it('reports current planned World failure once and rebuilds for a changed traversal', async () => {
  const f = await fixture(true);
  try {
    f.prepare(undefined, undefined, 'global-sdf');
    await vi.waitFor(() =>
      expect(f.asyncCreate.mock.calls.map(([d]) => d.compute.entryPoint)).toContain(
        'prepareScreenReceivers',
      ),
    );
    const worldIndex = f.asyncCreate.mock.calls.findIndex(
      ([d]) => d.compute.entryPoint === 'traceWorldProbes',
    );
    const world = f.pending[worldIndex];
    if (!world) throw new Error('Actual pending World request required');
    world.finish(
      err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'current planned World',
          hint: 'fail once',
        }),
      ),
    );
    f.pending.splice(worldIndex, 1);
    await f.drain();
    expect(f.screen.inspect(undefined).state).toBe('failed');
    const requested = f.asyncCreate.mock.calls.length;
    f.prepare(undefined, undefined, 'global-sdf');
    expect(f.asyncCreate).toHaveBeenCalledTimes(requested);
    expect(f.runtime.errorRegistry.fire).toHaveBeenCalledTimes(1);
    f.prepare(undefined, undefined, 'ray-query');
    await f.drain();
    const field = f.field();
    Object.assign(field, { traversal: 'ray-query' });
    f.prepare(field);
    expect(f.screen.ready?.field).toBe(field);
    expect(f.runtime.errorRegistry.fire).toHaveBeenCalledTimes(1);
  } finally {
    f.screen.dispose();
    await f.drain();
  }
});

it('rejects old planned World completion after the actual device is replaced', async () => {
  const f = await fixture();
  const replacement = await fixture();
  try {
    f.prepare(undefined, undefined, 'global-sdf');
    await vi.waitFor(() =>
      expect(f.asyncCreate.mock.calls.map(([d]) => d.compute.entryPoint)).toContain(
        'prepareScreenReceivers',
      ),
    );
    Object.assign(f.runtime, {
      device: replacement.device,
      deviceScope: replacement.runtime.deviceScope,
    });
    f.prepare(undefined, undefined, 'global-sdf');
    await f.drain();
    expect(f.screen.ready).toBeUndefined();
    expect(f.runtime.errorRegistry.fire).not.toHaveBeenCalled();
    await replacement.drain();
    const field = f.field(2);
    f.prepare(field);
    expect(f.screen.ready?.field).toBe(field);
    expect(replacement.asyncCreate.mock.calls.map(([d]) => d.compute.entryPoint)).toContain(
      'prepareScreenReceivers',
    );
  } finally {
    f.screen.dispose();
    replacement.screen.dispose();
    await f.drain();
    await replacement.drain();
  }
});

it.each([
  undefined,
  { kind: 'paid-root' },
  { kind: 'mesh-df', policy: { receiverBiasVoxels: 1, expansionVoxels: 0.5, maxErrorVoxels: 16 } },
] as const)('requests every independent World pipeline before the first completion (%s)', async (softwareWorld) => {
  const f = await fixture();
  try {
    f.prepare(
      f.field(),
      softwareWorld,
      undefined,
      softwareWorld?.kind === 'mesh-df' ? 'current-support' : undefined,
    );
    await vi.waitFor(() =>
      expect(f.asyncCreate.mock.calls.map(([d]) => d.compute.entryPoint)).toContain(
        'traceWorldProbes',
      ),
    );
    await Promise.resolve();
    const requested = f.asyncCreate.mock.calls.map(([d]) => d.compute.entryPoint);
    expect(requested).toContain('prepareScreenReceivers');
    if (softwareWorld?.kind === 'paid-root')
      expect(requested).toEqual(expect.arrayContaining(['prepareRoot', 'refineRoot']));
    expect(f.screen.ready).toBeUndefined();
  } finally {
    f.screen.dispose();
    await f.drain();
  }
});

it('does not reuse a strict or old-policy World PSO for a newly selected Mesh DF model', async () => {
  const f = await fixture();
  try {
    const field = f.field();
    f.prepare(field);
    await f.drain();
    f.prepare(field);
    expect(f.screen.ready).toBeDefined();
    const prior = f.runtime.createShaderModule as ReturnType<typeof vi.fn>;
    const count = () => prior.mock.calls.filter(([, d]) => d.label === 'screen-probe.world').length;
    const strictCount = count();
    f.prepare(field, meshDfMode, undefined, 'current-support');
    await f.drain();
    f.prepare(field, meshDfMode, undefined, 'current-support');
    expect(f.screen.ready).toBeDefined();
    expect(count()).toBe(strictCount + 1);
    expect(f.screen.inspect(undefined).softwareWorld).toEqual(meshDfMode);
    const changed: ScreenSoftwareWorld = {
      kind: 'mesh-df',
      policy: { receiverBiasVoxels: 0.5, expansionVoxels: 0.5, maxErrorVoxels: 16 },
    };
    f.prepare(field, changed, undefined, 'current-support');
    expect(f.screen.ready).toBeUndefined();
    await f.drain();
    f.prepare(field, changed, undefined, 'current-support');
    expect(f.screen.ready).toBeDefined();
    expect(count()).toBe(strictCount + 2);
  } finally {
    f.screen.dispose();
    await f.drain();
  }
});

it.each([
  'error',
  'dispose',
  'scope',
  'registry',
  'compiler',
] as const)('drains World and receiver before reporting or rejecting old %s preparation', async (outcome) => {
  const f = await fixture();
  try {
    f.prepare(f.field());
    await vi.waitFor(() =>
      expect(f.asyncCreate.mock.calls.map(([d]) => d.compute.entryPoint)).toContain(
        'prepareScreenReceivers',
      ),
    );
    const stages = f.asyncCreate.mock.calls.map(([d]) => d.compute.entryPoint);
    const pending = f.pending.splice(0);
    const receiver = pending[stages.indexOf('prepareScreenReceivers')];
    if (!receiver) throw new Error('Actual receiver request required');
    const worldError = new RhiError({
      code: 'rhi-descriptor-invalid',
      expected: 'controlled World failure',
      hint: 'first stage wins',
    });
    for (const [index, item] of pending.entries()) {
      if (item === receiver) continue;
      item.finish(stages[index] === 'traceWorldProbes' ? err(worldError) : item.result);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.runtime.errorRegistry.fire).not.toHaveBeenCalled();
    expect(f.screen.ready).toBeUndefined();
    if (outcome === 'dispose') f.screen.dispose();
    if (outcome === 'scope') Object.assign(f.runtime.deviceScope, { generation: 2 });
    if (outcome === 'registry') Object.assign(f.runtime, { shaderRegistry: {} });
    if (outcome === 'compiler') Object.assign(f.runtime, { createShaderModule: vi.fn() });
    receiver.finish(
      err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'later receiver failure',
          hint: 'must not replace World',
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.runtime.errorRegistry.fire).toHaveBeenCalledTimes(outcome === 'error' ? 1 : 0);
    expect(f.screen.ready).toBeUndefined();
    if (outcome === 'error') {
      expect(JSON.stringify(vi.mocked(f.runtime.errorRegistry.fire).mock.calls)).toContain(
        'controlled World failure',
      );
      expect(JSON.stringify(vi.mocked(f.runtime.errorRegistry.fire).mock.calls)).not.toContain(
        'later receiver failure',
      );
    }
  } finally {
    f.screen.dispose();
    await f.drain();
  }
});

it('keeps the one main preparation when Field arrives and gates assembly on both completions', async () => {
  const f = await fixture();
  const allocated = vi.spyOn(f.device, 'createBuffer');
  try {
    f.prepare();
    await vi.waitFor(() => expect(f.pending).toHaveLength(Object.keys(SCREEN_PROBE_STAGES).length));
    const field = f.field();
    f.prepare(field);
    await vi.waitFor(() =>
      expect(
        f.asyncCreate.mock.calls.some(([d]) => d.compute.entryPoint === 'traceWorldProbes'),
      ).toBe(true),
    );
    expect(f.screen.ready).toBeUndefined();
    expect(allocated).not.toHaveBeenCalled();
    f.prepare(field);
    expect(
      f.asyncCreate.mock.calls.filter(([d]) => d.compute.entryPoint === 'placeUniformProbes'),
    ).toHaveLength(1);
    await f.drain();
    f.prepare(field);
    expect(f.screen.ready?.field).toBe(field);
    expect(f.screen.ready?.kernels).toHaveProperty('generateProbeRays');
    expect(f.runtime.createShaderModule).toHaveBeenCalledTimes(4);
  } finally {
    f.screen.dispose();
    await f.drain();
  }
});

it.each([
  'disable',
  'dispose',
] as const)('drains pending work without a consumer after %s', async (action) => {
  const f = await fixture();
  const allocated = vi.spyOn(f.device, 'createBuffer');
  f.screen.disable();
  expect(f.asyncCreate).not.toHaveBeenCalled();
  f.prepare();
  await vi.waitFor(() => expect(f.pending).toHaveLength(Object.keys(SCREEN_PROBE_STAGES).length));
  f.screen[action]();
  await f.drain();
  expect(f.pending).toHaveLength(0);
  expect(f.screen.ready).toBeUndefined();
  expect(allocated).not.toHaveBeenCalled();
  expect(f.runtime.errorRegistry.fire).not.toHaveBeenCalled();
  f.screen.dispose();
});

it.each([
  'result',
  'reject',
] as const)('keeps a main %s failure structured and does not retry each frame', async (failure) => {
  const f = await fixture();
  const cause = new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'valid Screen pipeline',
    hint: 'controlled failure',
  });
  f.asyncCreate.mockImplementation(() =>
    failure === 'reject' ? Promise.reject(cause) : Promise.resolve(err(cause)),
  );
  try {
    f.prepare();
    await vi.waitFor(() => expect(f.screen.inspect(undefined).state).toBe('failed'));
    f.prepare();
    expect(f.asyncCreate).toHaveBeenCalledTimes(Object.keys(SCREEN_PROBE_STAGES).length);
    expect(f.runtime.errorRegistry.fire).toHaveBeenCalledTimes(1);
    expect(f.screen.ready).toBeUndefined();
  } finally {
    f.screen.dispose();
    await f.drain();
  }
});

it.each([
  'scope',
  'registry',
  'compiler',
] as const)('rejects pending adoption from an old %s identity', async (identity) => {
  const f = await fixture();
  try {
    f.prepare(undefined, undefined, 'global-sdf');
    await vi.waitFor(() =>
      expect(f.asyncCreate.mock.calls.map(([d]) => d.compute.entryPoint)).toContain(
        'prepareScreenReceivers',
      ),
    );
    if (identity === 'scope') Object.assign(f.runtime.deviceScope, { generation: 2 });
    else if (identity === 'registry')
      Object.assign(f.runtime, {
        shaderRegistry: {
          entries: () => [
            { wgsl: '@compute fn integrateScreenProbes() {}' },
            { wgsl: '@compute fn generateCachedProbeRays() {}' },
          ],
        },
      });
    else Object.assign(f.runtime, { createShaderModule: vi.fn(createShaderModule) });
    f.prepare(undefined, undefined, 'global-sdf');
    await vi.waitFor(() =>
      expect(
        f.asyncCreate.mock.calls.filter(([d]) => d.compute.entryPoint === 'placeUniformProbes'),
      ).toHaveLength(2),
    );
    await f.drain();
    expect(f.screen.ready).toBeUndefined();
    expect(f.runtime.errorRegistry.fire).not.toHaveBeenCalled();
    const field = f.field(2);
    f.prepare(field);
    await f.drain();
    f.prepare(field);
    expect(f.screen.ready?.field).toBe(field);
  } finally {
    f.screen.dispose();
    await f.drain();
  }
});

it('retains the actual submission fence when disabling a prepared Screen generation', async () => {
  const f = await fixture();
  const destroyed = vi.spyOn(f.device, 'destroyBuffer');
  try {
    const field = f.field();
    f.prepare(field);
    await f.drain();
    f.prepare(field);
    const ready = f.screen.ready;
    expect(ready).toBeDefined();
    if (!ready) throw new Error('Screen generation missing');
    let complete = () => {};
    const submitted = new Promise<void>((resolve) => {
      complete = resolve;
    });
    ready.track(submitted);
    f.screen.disable();
    expect(ready.fence.currentGeneration()).toBe(-1);
    expect(destroyed).not.toHaveBeenCalled();
    complete();
    await Promise.resolve();
    await Promise.resolve();
    expect(destroyed).toHaveBeenCalledWith(ready.frame.buffer);
    expect(field.track).toHaveBeenCalledWith(submitted);
  } finally {
    f.screen.dispose();
    await f.drain();
  }
});

it('requires an unambiguous published Screen module even while Field is pending', async () => {
  const f = await fixture();
  Object.assign(f.runtime.shaderRegistry ?? {}, { entries: () => [] });
  try {
    f.prepare();
    await vi.waitFor(() => expect(f.screen.inspect(undefined).state).toBe('failed'));
    expect(f.asyncCreate).not.toHaveBeenCalled();
    expect(f.runtime.createShaderModule).not.toHaveBeenCalled();
  } finally {
    f.screen.dispose();
  }
});

it.each([
  'missing',
  'duplicate',
] as const)('rejects a %s private Generate publication before compiling either module', async (kind) => {
  const f = await fixture();
  const main = { wgsl: '@compute fn integrateScreenProbes() {}' };
  const cached = { wgsl: '@compute fn generateCachedProbeRays() {}' };
  Object.assign(f.runtime.shaderRegistry ?? {}, {
    entries: () => (kind === 'missing' ? [main] : [main, cached, cached]),
  });
  try {
    f.prepare();
    await vi.waitFor(() => expect(f.screen.inspect(undefined).state).toBe('failed'));
    expect(f.asyncCreate).not.toHaveBeenCalled();
    expect(f.runtime.createShaderModule).not.toHaveBeenCalled();
  } finally {
    f.screen.dispose();
  }
});

it('preserves author history controls in actual submitted current-support frame uploads', async () => {
  for (let flags = 0; flags < 8; flags++) {
    const f = await fixture(false, {
      ...profile.probes,
      history: { screen: (flags & 1) !== 0, pixel: (flags & 2) !== 0, probe: (flags & 4) !== 0 },
    });
    const field = f.field();
    Object.assign(field, {
      plan: { grid: { spacing: 1 }, querySettings: new Uint8Array(8) },
      canonical: { expected: [36, 32, 1, 1] },
      editStats: () => ({ pendingTiles: 0, pendingPriorityUpdates: 0 }),
    });
    const writes = vi.spyOn(f.device.queue, 'writeBuffer');
    try {
      f.prepare(field, undefined, undefined, 'current-support');
      await f.drain();
      f.prepare(field, undefined, undefined, 'current-support');
      const ready = f.screen.ready;
      if (ready === undefined) throw new Error('Actual Renderer factory completion required');
      const uploaded = () => {
        const bytes = writes.mock.calls
          .filter(([buffer]) => buffer === ready.frame.buffer)
          .at(-1)?.[2];
        if (!(bytes instanceof Uint8Array)) throw new Error('Actual Frame upload required');
        return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)[10];
      };
      ready.writeFrame();
      expect(uploaded()).toBe(8);
      ready.writeFrame();
      expect(uploaded()).toBe(8);
      ready.commit();
      ready.writeFrame();
      expect(uploaded()).toBe(8 | flags);
      const fieldHistory = vi.spyOn(field, 'screenProbeHistory');
      fieldHistory.mockReturnValue('local-motion');
      ready.writeFrame(false);
      expect(uploaded()).toBe(8 | (flags & 1));
      ready.writeFrame(true);
      expect(uploaded()).toBe(8 | (flags & 3));
      fieldHistory.mockReturnValue('invalid');
      ready.writeFrame(true);
      expect(uploaded()).toBe(8 | (flags & 1));
    } finally {
      writes.mockRestore();
      f.screen.dispose();
      await f.drain();
    }
  }
});

it('selects both Screen modules from one finite publication iterator snapshot', async () => {
  const f = await fixture();
  const iterator = [
    { wgsl: '@compute fn integrateScreenProbes() {}' },
    { wgsl: '@compute fn generateCachedProbeRays() {}' },
  ].values();
  const entries = vi.fn(() => iterator);
  Object.assign(f.runtime.shaderRegistry ?? {}, { entries });
  try {
    f.prepare();
    await vi.waitFor(() =>
      expect(f.asyncCreate).toHaveBeenCalledTimes(Object.keys(SCREEN_PROBE_STAGES).length),
    );
    expect(entries).toHaveBeenCalledTimes(1);
  } finally {
    f.screen.dispose();
    await f.drain();
  }
});

it('prepares only the active reconstruction stages across far-atlas and software traversal', async () => {
  const f = await fixture(
    true,
    { ...profile.probes, integration: 'screen-space', irradiance: 'probe-octahedral' },
    true,
  );
  const requested = () => f.asyncCreate.mock.calls.map(([d]) => d.label);
  try {
    f.prepare(undefined, undefined, undefined, 'current-support', true);
    await f.drain();
    expect(requested()).toEqual([]);
    f.prepare(undefined, undefined, 'ray-query', 'current-support', true);
    await f.drain();
    expect(requested()).toContain('screen-probe.generateHardwareCacheProbeRays');
    expect(requested()).toContain('screen-probe.preintegrateScattered');
    for (const stage of [
      'generateProbeRays',
      'generateHistoryProbeRays',
      'resolveProbeRays',
      'temporalProbeRadiance',
      'preintegrate',
      'lightTraceFallbacks',
    ])
      expect(requested()).not.toContain(`screen-probe.${stage}`);
    const far = Object.assign(f.field(), { traversal: 'ray-query', farRadiance: {} });
    const calls = f.asyncCreate.mock.calls.length;
    f.prepare(far, undefined, 'ray-query', 'current-support', true);
    expect(f.screen.ready?.field).toBe(far);
    expect(f.asyncCreate).toHaveBeenCalledTimes(calls);

    const near = Object.assign(f.field(2), { traversal: 'ray-query' });
    f.asyncCreate.mockClear();
    f.prepare(near, undefined, 'ray-query', 'current-support', true);
    await f.drain();
    f.prepare(near, undefined, 'ray-query', 'current-support', true);
    expect(f.screen.ready?.field).toBe(near);
    expect(requested()).toContain('screen-probe.generateHistoryProbeRays');
    expect(requested()).toContain('screen-probe.preintegrateScattered');
    expect(requested()).not.toContain('screen-probe.generateHardwareCacheProbeRays');

    const software = f.field(3);
    f.asyncCreate.mockClear();
    f.prepare(software, undefined, 'global-sdf', 'current-support', true);
    expect(f.screen.ready).toBeUndefined();
    await f.drain();
    f.prepare(software, undefined, 'global-sdf', 'current-support', true);
    expect(f.screen.ready?.field).toBe(software);
    expect(requested()).toContain('screen-probe.generateProbeRays');
    expect(requested()).toContain('screen-probe.preintegrate');
    expect(requested()).not.toContain('screen-probe.generateHardwareCacheProbeRays');
  } finally {
    f.screen.dispose();
    await f.drain();
  }
});

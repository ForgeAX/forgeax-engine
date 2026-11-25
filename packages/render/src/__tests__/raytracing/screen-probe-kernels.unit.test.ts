import {
  type BindGroup,
  type ComputePipeline,
  type Result,
  type RhiComputePassEncoder,
  RhiError,
} from '@forgeax/engine-rhi';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-null';
import { err } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import {
  createScreenProbeKernels,
  SCREEN_PROBE_STAGES,
} from '../../raytracing/screen-probe-kernels';

const stages = Object.keys(SCREEN_PROBE_STAGES);

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (
    await createShaderModule(device, { code: 'CPU factory lifecycle module' })
  ).unwrap();
  const generateModule = (
    await createShaderModule(device, { code: 'Private Generate module' })
  ).unwrap();
  const create = device.createComputePipeline.bind(device);
  const requests: {
    result: Result<ComputePipeline, RhiError>;
    resolve: (result: Result<ComputePipeline, RhiError>) => void;
    reject: (cause: unknown) => void;
  }[] = [];
  const pending = vi.fn(
    (descriptor: Parameters<typeof create>[0]) =>
      new Promise<Result<ComputePipeline, RhiError>>((resolve, reject) => {
        requests.push({ result: create(descriptor), resolve, reject });
      }),
  );
  Object.assign(device, { createComputePipelineAsync: pending });
  const drain = async () => {
    for (let turn = 0; turn < 100; turn++) {
      for (const request of requests) request.resolve(request.result);
      await Promise.resolve();
    }
  };
  return { device, module, generateModule, requests, pending, drain };
}

it('requests every independent Screen stage while the first pipeline is pending', async () => {
  const f = await fixture();
  const prepared = createScreenProbeKernels(f.device, f.module, f.generateModule);
  try {
    await vi.waitFor(() =>
      expect(f.pending.mock.calls.map(([d]) => d.compute.entryPoint)).toEqual(
        stages.map((stage) => (stage === 'generateProbeRays' ? 'generateCachedProbeRays' : stage)),
      ),
    );
  } finally {
    await f.drain();
    await prepared;
  }
});

it('keeps stage order, the original descriptors and one shared sample layout after reverse completion', async () => {
  const f = await fixture();
  const layouts = vi.spyOn(f.device, 'createPipelineLayout');
  const buffers = vi.spyOn(f.device, 'createBuffer');
  const prepared = createScreenProbeKernels(f.device, f.module, f.generateModule);
  try {
    expect(f.requests).toHaveLength(stages.length);
    for (const request of [...f.requests].reverse()) request.resolve(request.result);
    const result = (await prepared).unwrap();
    expect(Object.keys(result.kernels)).toEqual(stages);
    expect(layouts).toHaveBeenCalledTimes(stages.length);
    for (const [descriptor] of layouts.mock.calls) {
      const groups = Array.from(descriptor.bindGroupLayouts);
      expect(groups).toHaveLength(2);
      expect(groups[1]).toBe(result.sampleLayout);
    }
    expect(f.pending.mock.calls.map(([d]) => d.label)).toEqual(
      stages.map((s) => `screen-probe.${s}`),
    );
    for (const [descriptor] of f.pending.mock.calls) {
      expect(descriptor.compute.module).toBe(
        descriptor.label === 'screen-probe.generateProbeRays' ? f.generateModule : f.module,
      );
    }
    expect(buffers).not.toHaveBeenCalled();
  } finally {
    await f.drain();
    await prepared;
  }
});

it.each([
  'result',
  'throw',
] as const)('drains late stages and preserves the first stage %s ahead of the opposite later failure', async (kind) => {
  const f = await fixture();
  const first = new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'first stage error',
    hint: 'controlled',
  });
  const later = new Error('later rejected stage');
  const original = err(first);
  let settled = false;
  const outcome = createScreenProbeKernels(f.device, f.module, f.generateModule).then(
    (value) => ({ value }),
    (reason: unknown) => ({ reason }),
  );
  void outcome.then(() => {
    settled = true;
  });
  try {
    expect(f.requests).toHaveLength(stages.length);
    const early = f.requests[2];
    const late = f.requests[6];
    const last = f.requests.at(-1);
    if (!early || !late || !last) throw new Error('missing stage requests');
    if (kind === 'result') {
      early.resolve(original);
      late.reject(later);
    } else {
      early.reject(first);
      late.resolve(
        err(
          new RhiError({ code: 'rhi-not-available', expected: 'later error', hint: 'controlled' }),
        ),
      );
    }
    for (const [index, request] of f.requests.entries()) {
      if (index !== 2 && index !== 6 && request !== last) request.resolve(request.result);
    }
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(settled).toBe(false);
    last.resolve(last.result);
    const result = await outcome;
    if (kind === 'result') expect('value' in result ? result.value : undefined).toBe(original);
    else expect('reason' in result ? result.reason : undefined).toBe(first);
  } finally {
    await f.drain();
    await outcome;
  }
});

it('rejects the shared sample layout before any independent pipeline request', async () => {
  const f = await fixture();
  const refused = err(
    new RhiError({ code: 'rhi-descriptor-invalid', expected: 'sample layout', hint: 'controlled' }),
  );
  vi.spyOn(f.device, 'createBindGroupLayout').mockReturnValueOnce(refused);
  expect(await createScreenProbeKernels(f.device, f.module, f.generateModule)).toBe(refused);
  expect(f.pending).not.toHaveBeenCalled();
});

it('reuses the two fixed buffer bindings and renews a changed handle or binding window', async () => {
  const f = await fixture();
  const prepared = createScreenProbeKernels(f.device, f.module, f.generateModule);
  await f.drain();
  const { kernels } = (await prepared).unwrap();
  const makeBuffer = () => f.device.createBuffer({ size: 256, usage: 64 | 128 }).unwrap();
  const frame = makeBuffer();
  const fixed = makeBuffer();
  const historyA = makeBuffer();
  const historyB = makeBuffer();
  const replacement = makeBuffer();
  const setBindGroup = vi.fn();
  const pass = {
    setPipeline: vi.fn(),
    setBindGroup,
    dispatchWorkgroups: vi.fn(),
  } as unknown as RhiComputePassEncoder;
  const sample = {} as BindGroup;
  const create = vi.spyOn(f.device, 'createBindGroup');
  const generate = kernels.generateProbeRays;
  assert(generate !== undefined);
  const record = (history: typeof historyA, frameSize: number) => {
    generate
      .record(
        pass,
        (slot) => {
          if (slot === 'frame') return { buffer: frame, size: frameSize };
          return { buffer: slot === 'rays' ? history : fixed };
        },
        sample,
        1,
      )
      .unwrap();
    return setBindGroup.mock.calls.at(-2)?.[1];
  };
  const a = record(historyA, 192);
  const b = record(historyB, 192);
  expect(record(historyA, 192)).toBe(a);
  expect(record(historyB, 192)).toBe(b);
  expect(create).toHaveBeenCalledTimes(2);
  expect(record(historyB, 256)).not.toBe(b);
  expect(record(replacement, 192)).not.toBe(b);
  expect(create).toHaveBeenCalledTimes(4);
});

it.each([
  'half-scalar',
  'full-bent',
  undefined,
] as const)('only prepares short-range AO kernels for an enabled mode (%s)', async (mode) => {
  const f = await fixture();
  const prepared = createScreenProbeKernels(
    f.device,
    f.module,
    f.generateModule,
    true,
    true,
    undefined,
    mode,
  );
  await f.drain();
  const { kernels } = (await prepared).unwrap();
  expect(kernels.computeScreenProbeShortRangeAo !== undefined).toBe(mode !== undefined);
});

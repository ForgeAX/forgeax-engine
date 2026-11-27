import { createBoxGeometry } from '@forgeax/engine-geometry';
import { expect, it, vi } from 'vitest';
import { screenProbeWorldWgsl } from '../../../render/src/raytracing/screen-probe-kernels';
import { compileShader } from '../../../shader-compiler/src/index';
import {
  observeScreenWorldHit,
  screenWorldHitObservation,
} from './screen-canonical-world-hit.fixture';
import { checkScreenWorldHit, exactCanonicalWorld } from './screen-canonical-world-oracle.fixture';

it('forwards both bind-group overloads and null or undefined unbinding without changing identities', async () => {
  const module: GPUShaderModule = Object.create(null);
  const pipeline: GPUComputePipeline = Object.create(null);
  const group: GPUBindGroup = Object.create(null);
  const pending = Promise.resolve(pipeline);
  const setGroup = vi.fn<GPUComputePassEncoder['setBindGroup']>();
  const pass: GPUComputePassEncoder = Object.assign(Object.create(null), {
    setPipeline: vi.fn(),
    setBindGroup: setGroup,
    dispatchWorkgroups: vi.fn(),
  });
  const encoder: GPUCommandEncoder = Object.assign(Object.create(null), {
    beginComputePass: vi.fn(() => pass),
  });
  const device: GPUDevice = Object.assign(Object.create(null), {
    queue: { writeBuffer: vi.fn(), writeTexture: vi.fn() },
    createShaderModule: vi.fn(() => module),
    createComputePipelineAsync: vi.fn(() => pending),
    createBindGroup: vi.fn(() => group),
    createCommandEncoder: vi.fn(() => encoder),
  });
  const observer = observeScreenWorldHit(device);
  try {
    expect(device.createShaderModule({ code: 'diagnostic boundary only' })).toBe(module);
    const promise = device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'traceWorldProbes' },
    });
    expect(promise).toBe(pending);
    expect(await promise).toBe(pipeline);
    expect(device.createBindGroup({ layout: Object.create(null), entries: [] })).toBe(group);
    expect(device.createCommandEncoder()).toBe(encoder);
    expect(encoder.beginComputePass({ label: 'screen-probe.trace-world' })).toBe(pass);
    pass.setPipeline(pipeline);
    const offsets = new Uint32Array([0, 16, 32]);
    const iterable = [16, 32];
    expect(pass.setBindGroup(0, group)).toBeUndefined();
    expect(pass.setBindGroup(0, group, iterable)).toBeUndefined();
    expect(pass.setBindGroup(0, group, offsets, 1, 2)).toBeUndefined();
    expect(pass.setBindGroup(0, null)).toBeUndefined();
    expect(pass.setBindGroup(0, undefined)).toBeUndefined();
    expect(setGroup.mock.calls).toEqual([
      [0, group],
      [0, group, iterable],
      [0, group, offsets, 1, 2],
      [0, null],
      [0, undefined],
    ]);
    expect(setGroup.mock.calls[1]?.[2]).toBe(iterable);
    expect(setGroup.mock.calls[2]?.[2]).toBe(offsets);
    expect(setGroup.mock.contexts.every((context) => context === pass)).toBe(true);
  } finally {
    observer.dispose();
  }
});

it('keeps the actual World query prefix and only replaces its observable output tail', async () => {
  const source = screenProbeWorldWgsl('global-sdf');
  const observed = screenWorldHitObservation(source);
  expect(observed.source.slice(0, observed.prefix.length)).toBe(
    source.slice(0, observed.prefix.length),
  );
  const result = (
    await compileShader(observed.source, { id: 'screen-canonical-actual-hit-observation' })
  ).unwrap();
  expect(result.reflection.boundGlobals.find((value) => value.binding === 7)?.elementStride).toBe(
    32,
  );
  expect(result.reflection.entryPoints?.some((entry) => entry.name === 'traceWorldProbes')).toBe(
    true,
  );
  expect(() => screenWorldHitObservation(source.replace(' let status=hit.state.x;', ''))).toThrow();
  expect(() =>
    screenWorldHitObservation(
      source.replace(
        ' let status=hit.state.x;',
        ' let status=hit.state.x; let status=hit.state.x;',
      ),
    ),
  ).toThrow();
});

it('rejects the exit face and oversized error while retaining other primitives of the receiver', () => {
  const receiver = {
    mesh: createBoxGeometry(4, 4, 0.25).unwrap(),
    handle: 9,
    position: [0, 0, -0.125] as const,
  };
  const blocker = {
    mesh: createBoxGeometry(0.5, 0.5, 0.015625).unwrap(),
    handle: 10,
    position: [0, 0, 0.0625] as const,
  };
  const origin = [
    { n: 1n, d: 8n },
    { n: 1n, d: 16n },
    { n: 0n, d: 1n },
  ];
  const primary = exactCanonicalWorld(
    [receiver],
    [...origin.slice(0, 2), { n: 1n, d: 2n }],
    [0, 0, -1],
    { handle: -1, primitive: -1 },
    2,
  );
  const selected = primary.hits[0];
  if (!selected) throw new Error('Authored receiver must intersect');
  const contact = { handle: receiver.handle, primitive: selected.primitive };
  const reference = exactCanonicalWorld([receiver, blocker], origin, [0, 0, 1], contact, 2);
  const first = reference.hits[0];
  if (!first) throw new Error('Authored blocker must intersect');
  expect(first.handle).toBe(blocker.handle);
  const actual = {
    status: 1,
    flags: (0x80000000 | (first.primitive << 2)) >>> 0,
    instance: 42,
    t: 7 / 128,
    error: 0,
    position: [0.125, 0.0625, 7 / 128],
    legacyDistance: 7 / 128,
    primitive: first.primitive,
  };
  expect(checkScreenWorldHit(actual, reference, 42).handle).toBe(blocker.handle);
  expect(() =>
    checkScreenWorldHit({ ...actual, position: [0.125, 0.0625, 9 / 128] }, reference, 42),
  ).toThrow();
  expect(() => checkScreenWorldHit({ ...actual, error: 1 }, reference, 42)).toThrow();
  const back = exactCanonicalWorld([receiver, blocker], origin, [0, 0, -1], contact, 2);
  const other = back.hits[0];
  if (!other) throw new Error('A different receiver primitive must remain');
  expect(other.handle).toBe(receiver.handle);
  expect(other.primitive).not.toBe(selected.primitive);
  checkScreenWorldHit(
    {
      ...actual,
      primitive: other.primitive,
      flags: (0x80000000 | (other.primitive << 2)) >>> 0,
      t: 0.25,
      position: [0.125, 0.0625, -0.25],
    },
    back,
    42,
  );
});

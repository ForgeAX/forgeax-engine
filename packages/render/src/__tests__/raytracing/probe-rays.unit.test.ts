import type { RhiDevice } from '@forgeax/engine-rhi';
import { createShaderModule, RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { assert, expect, it, vi } from 'vitest';
import { createProbeRayRecorder, type ProbeRayInputs } from '../../raytracing/probe-rays';

async function deviceForAdmission() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  assert(device instanceof RhiNullDevice);
  Object.defineProperty(device, 'limits', {
    value: {
      maxBindGroups: 4,
      maxBindingsPerBindGroup: 1000,
      maxStorageBuffersPerShaderStage: 8,
      maxUniformBuffersPerShaderStage: 12,
      maxUniformBufferBindingSize: 65536,
      maxComputeWorkgroupSizeX: 256,
      maxComputeInvocationsPerWorkgroup: 256,
      maxComputeWorkgroupsPerDimension: 65535,
      maxStorageBufferBindingSize: 134217728,
      maxBufferSize: 268435456,
      minUniformBufferOffsetAlignment: 256,
      minStorageBufferOffsetAlignment: 256,
    },
  });
  return device;
}

it('rejects nonexact ranges, aliases and overflowing square budgets without encoding', async () => {
  const device = await deviceForAdmission();
  const recorder = createProbeRayRecorder(
    device,
    (await createShaderModule(device, { code: '' })).unwrap(),
  ).unwrap();
  const buffer = (size: number) => device.createBuffer({ size: size + 512, usage: 0xcc }).unwrap();
  const input: ProbeRayInputs = {
    probes: { buffer: buffer(32), offset: 256, size: 32 },
    candidate: { buffer: buffer(32), offset: 256, size: 32 },
    settings: { buffer: buffer(16), offset: 256, size: 16 },
    rays: { buffer: buffer(81 * 48), offset: 256, size: 81 * 48 },
    diagnostics: { buffer: buffer(16), offset: 256, size: 16 },
  };
  const pass = device.createCommandEncoder({}).unwrap().beginComputePass({});
  for (const [count, resolution] of [
    [0, 9],
    [1.5, 9],
    [1, 1.5],
    [1, 0],
    [1, 257],
    [65537, 1],
    [Number.MAX_SAFE_INTEGER, 256],
    [NaN, 1],
    [1, Infinity],
  ])
    expect(recorder.record(pass, input, count ?? 0, resolution ?? 0)).toMatchObject({
      ok: false,
      error: { code: 'limit-exceeded' },
    });
  for (const name of ['probes', 'candidate', 'settings', 'rays', 'diagnostics'] as const) {
    for (const size of [0, input[name].size - 4, input[name].size + 4, Infinity, NaN])
      expect(recorder.record(pass, { ...input, [name]: { ...input[name], size } }, 1, 9).ok).toBe(
        false,
      );
    for (const offset of [-1, 4, NaN, Infinity, 256.5, 268435456])
      expect(recorder.record(pass, { ...input, [name]: { ...input[name], offset } }, 1, 9).ok).toBe(
        false,
      );
  }
  for (const output of ['rays', 'diagnostics'] as const)
    for (const name of [
      'probes',
      'candidate',
      'settings',
      output === 'rays' ? 'diagnostics' : 'rays',
    ] as const)
      expect(
        recorder.record(
          pass,
          { ...input, [output]: { ...input[output], buffer: input[name].buffer } },
          1,
          9,
        ).ok,
      ).toBe(false);
  expect(device.totalDispatchCount).toBe(0);
  expect(device.totalBindGroupCount).toBe(0);
  const allocate = vi.spyOn(device, 'createBuffer'),
    submit = vi.spyOn(device.queue, 'submit');
  recorder.record(pass, input, 1, 9).unwrap();
  expect(device.totalDispatchCount).toBe(1);
  expect(allocate).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
  pass.end();
});

it('admits the exact maximum and respects per-device dispatch and storage limits', async () => {
  const device = await deviceForAdmission();
  const module = (await createShaderModule(device, { code: '' })).unwrap();
  const limited = (limits: Partial<RhiDevice['limits']>) => {
    const value = Object.create(device) as RhiDevice;
    Object.defineProperty(value, 'limits', { value: { ...device.limits, ...limits } });
    return value;
  };
  const input = {
    probes: { buffer: device.createBuffer({ size: 32, usage: 128 }).unwrap(), size: 32 },
    candidate: { buffer: device.createBuffer({ size: 32, usage: 128 }).unwrap(), size: 32 },
    settings: { buffer: device.createBuffer({ size: 16, usage: 64 }).unwrap(), size: 16 },
    rays: {
      buffer: device.createBuffer({ size: 65536 * 48, usage: 128 }).unwrap(),
      size: 65536 * 48,
    },
    diagnostics: { buffer: device.createBuffer({ size: 16, usage: 128 }).unwrap(), size: 16 },
  };
  const pass = device.createCommandEncoder({}).unwrap().beginComputePass({});
  for (const limits of [
    { maxComputeWorkgroupsPerDimension: 1023 },
    { maxStorageBufferBindingSize: 65536 * 48 - 4 },
    { maxBufferSize: 65536 * 48 - 4 },
  ])
    expect(
      createProbeRayRecorder(limited(limits), module).unwrap().record(pass, input, 1, 256),
    ).toMatchObject({ ok: false, error: { code: 'limit-exceeded' } });
  expect(device.totalDispatchCount).toBe(0);
  createProbeRayRecorder(device, module).unwrap().record(pass, input, 1, 256).unwrap();
  expect(device.totalDispatchCount).toBe(1);
  pass.end();
});

it('rejects unsupported capabilities before creating pipeline resources', async () => {
  const device = await deviceForAdmission();
  const module = (await createShaderModule(device, { code: '' })).unwrap();
  const layout = vi.spyOn(device, 'createBindGroupLayout');
  for (const name of ['compute', 'storageBuffer'] as const) {
    const value = Object.create(device) as RhiDevice;
    Object.defineProperty(value, 'caps', { value: { ...device.caps, [name]: false } });
    expect(createProbeRayRecorder(value, module)).toMatchObject({
      ok: false,
      error: { code: 'rhi-not-available' },
    });
  }
  for (const [name, minimum] of [
    ['maxBindGroups', 1],
    ['maxBindingsPerBindGroup', 5],
    ['maxStorageBuffersPerShaderStage', 4],
    ['maxUniformBuffersPerShaderStage', 1],
    ['maxUniformBufferBindingSize', 16],
    ['maxComputeWorkgroupSizeX', 64],
    ['maxComputeInvocationsPerWorkgroup', 64],
  ] as const) {
    const value = Object.create(device) as RhiDevice;
    Object.defineProperty(value, 'limits', { value: { ...device.limits, [name]: minimum - 1 } });
    expect(createProbeRayRecorder(value, module)).toMatchObject({
      ok: false,
      error: { code: 'limit-exceeded' },
    });
  }
  expect(layout).not.toHaveBeenCalled();
});

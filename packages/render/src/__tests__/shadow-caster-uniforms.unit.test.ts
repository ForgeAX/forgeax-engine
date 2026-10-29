import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { err } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { createViewPipelineState } from '../assembly/view-pipeline-state';
import { createShadowCasterCascadeBuffer } from '../assembly/webgpu-ready-resources';
import { DeviceScope } from '../device/device-scope';
import { RhiErrorListenerRegistry } from '../lifecycle';
import type { PipelineState, RenderSystemInternals } from '../record/render-context';
import { writeShadowCasterMatrices } from '../record/shadow-caster-uniforms';
import type { ViewLights } from '../world/render-lights';

async function deviceFixture() {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const uploads = new Map<Buffer, Uint8Array>();
  const original = device.queue.writeBuffer.bind(device.queue);
  const write = vi.spyOn(device.queue, 'writeBuffer').mockImplementation((buffer, offset, data) => {
    const result = original(buffer, offset, data);
    if (!result.ok) return result;
    const source = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    let bytes = uploads.get(buffer);
    if (bytes === undefined) {
      bytes = new Uint8Array(2048);
      uploads.set(buffer, bytes);
    }
    bytes.set(source, offset);
    return result;
  });
  return { device, uploads, write };
}

function expectHeaders(bytes: Uint8Array | undefined): void {
  expect(bytes).toBeDefined();
  if (bytes === undefined) throw Error('Missing shadow caster initialization');
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  for (let cascade = 0; cascade < 4; cascade++)
    expect(Array.from(words.subarray(cascade * 64, cascade * 64 + 4))).toEqual([cascade, 0, 0, 0]);
  for (let tile = 0; tile < 4; tile++)
    expect(Array.from(words.subarray((4 + tile) * 64, (4 + tile) * 64 + 4))).toEqual([0, 1, 0, 0]);
}

it('prepares every directional and spot header when the boot buffer is created', async () => {
  const f = await deviceFixture();
  const buffer = createShadowCasterCascadeBuffer(
    f.device.createBuffer.bind(f.device),
    f.device.queue,
  );
  try {
    expectHeaders(f.uploads.get(buffer));
    expect(f.write.mock.calls.filter(([target]) => target === buffer)).toHaveLength(1);
  } finally {
    f.device.destroyBuffer(buffer);
    f.write.mockRestore();
  }
});

it('prepares independent headers for each writable view and replacement generation', async () => {
  const f = await deviceFixture();
  const base = { perPassResources: { skyboxRotationBuffer: null } } as PipelineState;
  const internals = {
    device: f.device,
    errorRegistry: new RhiErrorListenerRegistry(),
  } as RenderSystemInternals;
  const scopes = [
    DeviceScope.create(1, 'left'),
    DeviceScope.create(1, 'right'),
    DeviceScope.create(2, 'recovered'),
  ];
  try {
    const buffers = scopes.map(
      (scope) => createViewPipelineState(base, internals, scope).state.shadowCasterCascadeBuffer,
    );
    expect(new Set(buffers).size).toBe(3);
    for (const buffer of buffers) expectHeaders(f.uploads.get(buffer));
  } finally {
    for (const scope of scopes) scope.retire();
    f.write.mockRestore();
  }
});

it('rejects a buffer whose initial parameter upload fails', async () => {
  const f = await deviceFixture();
  const failure = new RhiError({
    code: 'queue-write-buffer-out-of-bounds',
    expected: 'initial headers upload',
    hint: 'injected creation failure',
  });
  f.write.mockReturnValue(err(failure));
  const buffers: Buffer[] = [];
  const create: RhiDevice['createBuffer'] = (descriptor) => {
    const result = f.device.createBuffer(descriptor);
    if (result.ok) buffers.push(result.value);
    return result;
  };
  try {
    expect(() => createShadowCasterCascadeBuffer(create, f.device.queue)).toThrow(failure);
  } finally {
    for (const buffer of buffers) f.device.destroyBuffer(buffer);
    f.write.mockRestore();
  }
});

it('uploads only current spot matrices while keeping every fixed header intact', async () => {
  const f = await deviceFixture();
  const buffer = createShadowCasterCascadeBuffer(
    f.device.createBuffer.bind(f.device),
    f.device.queue,
  );
  const first = Float32Array.from({ length: 16 }, (_, index) => index + 1);
  const last = Float32Array.from({ length: 16 }, (_, index) => 20 - index);
  const lights = {
    spot: [
      { shadowAtlasTile: 0, lightViewProj: first },
      { shadowAtlasTile: 3, lightViewProj: last },
      { shadowAtlasTile: -1, lightViewProj: first },
      { shadowAtlasTile: 4, lightViewProj: first },
      { shadowAtlasTile: 1, lightViewProj: undefined },
    ],
  } as unknown as ViewLights;
  try {
    f.write.mockClear();
    writeShadowCasterMatrices(f.device.queue, buffer, lights);
    expect(f.write.mock.calls.map(([, offset]) => offset)).toEqual([1040, 1808]);
    const bytes = f.uploads.get(buffer);
    expectHeaders(bytes);
    if (bytes === undefined) throw Error('Missing initialized buffer');
    expect(Array.from(new Float32Array(bytes.buffer, 1040, 16))).toEqual(Array.from(first));
    expect(Array.from(new Float32Array(bytes.buffer, 1808, 16))).toEqual(Array.from(last));
    f.write.mockClear();
    writeShadowCasterMatrices(f.device.queue, buffer, { spot: [] } as unknown as ViewLights);
    expect(f.write).not.toHaveBeenCalled();
    expectHeaders(bytes);
  } finally {
    f.device.destroyBuffer(buffer);
    f.write.mockRestore();
  }
});

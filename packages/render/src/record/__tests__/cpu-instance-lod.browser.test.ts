import { encodePng } from '@forgeax/engine-image/png';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import * as wgpu from '../../../../rhi-wgpu/src/index';
import { cpuInstanceLodShader, verifyCpuInstanceLodPixels } from './cpu-instance-lod.gpu-fixture';

it.each([
  'webgpu',
  'wgpu-webgl2',
] as const)('preserves per-instance CPU LOD pixels across uniform page boundaries on %s', async (backend) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const saved = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  let adapter: import('@forgeax/engine-rhi').RhiAdapter;
  try {
    if (backend === 'wgpu-webgl2')
      Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
    adapter =
      backend === 'webgpu'
        ? (await webgpu.rhi.requestAdapter()).unwrap()
        : (await wgpu.rhi.requestAdapter({}, canvas)).unwrap();
  } finally {
    if (backend === 'wgpu-webgl2') {
      if (saved === undefined) Reflect.deleteProperty(navigator, 'gpu');
      else Object.defineProperty(navigator, 'gpu', saved);
    }
  }
  const device = (await adapter.requestDevice()).unwrap();
  expect(device.caps.backendKind).toBe(backend);
  const pack = backend === 'webgpu' ? webgpu : wgpu;
  const module = (
    await pack.createShaderModule(device, { code: cpuInstanceLodShader(device.caps.storageBuffer) })
  ).unwrap();
  try {
    const pixels = await verifyCpuInstanceLodPixels(device, module, 'forward');
    for (const [name, bytes] of Object.entries(pixels)) {
      const png = encodePng(64, 64, bytes);
      let binary = '';
      for (const byte of png) binary += String.fromCharCode(byte);
      await commands.writeFile(
        `artifacts/webgl2-basics/cpu-lod/${backend}-${name}.png`,
        btoa(binary),
        'base64',
      );
    }
    if (device.caps.storageBuffer) await verifyCpuInstanceLodPixels(device, module, 'shadow');
  } finally {
    pack.disposeDevice(device);
  }
}, 60_000);

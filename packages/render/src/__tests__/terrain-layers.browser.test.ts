import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { it } from 'vitest';
import * as wgpu from '../../../rhi-wgpu/src/index';
import sampling from '../../../shader/src/terrain-layer-sampling.wgsl?raw';
import { verifyTerrainLayerEdits } from './terrain-layers.gpu-fixture';

it.each([
  { name: 'webgpu', backend: webgpu },
  { name: 'wgpu-webgl2', backend: wgpu },
])('follows shared Terrain edits and fixed versions on $name', async ({ backend, name }) => {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  try {
    if (name === 'wgpu-webgl2') await wgpu.ensureReady();
    const adapter =
      name === 'wgpu-webgl2'
        ? await wgpu.requestAdapter(undefined, canvas)
        : await webgpu.requestAdapter();
    const device = (await adapter.unwrap().requestDevice()).unwrap();
    try {
      await verifyTerrainLayerEdits(sampling, backend, device);
    } finally {
      backend.disposeDevice(device);
    }
  } finally {
    canvas.remove();
  }
}, 60000);

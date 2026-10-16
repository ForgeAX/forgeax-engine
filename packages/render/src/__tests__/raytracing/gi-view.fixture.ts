import { vec3 } from '@forgeax/engine-math';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect } from 'vitest';
import { buildRaySurfaceScene } from '../../raytracing/attributes';
import { createRayPathTracer } from '../../raytracing/path-tracer';
import type { DiffuseGiFixture } from './diffuse-gi.commands';
import { giSource, runGi, verifyGiReplay } from './diffuse-gi.fixture';
import { readBuffer } from './path-tracer.fixture';

/** A three-face perspective view must agree with independently generated triangle rays. */
export async function verifyGiPerspective(fixture: DiffuseGiFixture) {
  const resolution = 128,
    source = giSource(fixture, 'white', 0, [0, 0, 0], [1, 1, 1]);
  const camera = {
    origin: [3, 2, 5] as const,
    target: [0, 0, 0] as const,
    up: [0, 1, 0] as const,
    verticalFov: 0.7,
  };
  const lights = [
    {
      kind: 'point' as const,
      position: vec3.create(3, 4, 5),
      color: vec3.create(35, 35, 35),
      intensity: 35,
      invRangeSquared: 0,
    },
  ];
  const result = await runGi(fixture, {
    sources: [source],
    lights,
    capture: true,
    settings: { resolution, view: { camera, near: 0.1, far: 30 } },
  });
  await verifyGiReplay(result);
  const device = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const material = fixture.rayMaterials.find((m) => m.name === 'white');
  if (!material) throw new Error('missing white ray material');
  const tracer = (
    await createRayPathTracer(device, webgpu.createShaderModule, {
      kernel: fixture.pathKernel,
      scene: buildRaySurfaceScene([{ ...source.instance, materialId: 0 }]).unwrap(),
      materials: [{ id: 0, ...material }],
      lights,
      settings: {
        width: resolution,
        height: resolution,
        camera,
        maxBounces: 1,
        seed: 47,
        environment: [0, 0, 0],
        maxDistance: 40,
      },
    })
  ).unwrap();
  try {
    const encoder = device.createCommandEncoder({}).unwrap();
    for (let i = 0; i < 16; i++) tracer.recordSample(encoder).unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const bytes = await readBuffer(
      device,
      tracer.buffers.accumulation,
      resolution * resolution * 80,
    );
    const path = new Float32Array(bytes.buffer),
      counts = new Uint32Array(bytes.buffer),
      field = new Float32Array(result.field.buffer),
      states = new Uint32Array(result.field.buffer);
    let disagreement = 0,
      error = 0,
      energy = 0,
      hits = 0;
    for (let i = 0; i < resolution * resolution; i++) {
      expect(counts[i * 20 + 3]).toBe(16);
      expect(counts[i * 20 + 7]).toBe(0);
      const raster = states[i * 20 + 16] !== 0,
        ray = (path[i * 20 + 15] ?? -1) >= 0;
      if (raster !== ray) disagreement++;
      if (raster && ray) hits++;
      for (let c = 0; c < 3; c++) {
        const a = field[i * 20 + c] ?? Number.NaN,
          b = path[i * 20 + c] ?? Number.NaN;
        expect(Number.isFinite(a) && Number.isFinite(b)).toBe(true);
        error += Math.abs(a - b);
        energy += b;
      }
    }
    expect(hits).toBeGreaterThan(2500);
    expect(disagreement / (resolution * resolution)).toBeLessThan(0.02);
    expect(error / energy).toBeLessThan(0.035);
  } finally {
    tracer.dispose();
    webgpu._internal_getRawDevice(device)?.destroy();
  }
}

import * as gpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect } from 'vitest';
import { buildRaySurfaceScene } from '../../raytracing/attributes';
import { createRayPathTracer } from '../../raytracing/path-tracer';
import type { RayPathFixture } from './path-tracer.commands';
import { plane, readBuffer, settings } from './path-tracer.fixture';

const SAMPLES = 256;

/**
 * Open-sky white furnace for both receiver responses. Under a uniform unit sky,
 * the diffuse receiver must return exactly the raster diffuse-GI composite
 * weight times albedo (energy 1 for a white dielectric, 0 for a metal), while
 * the full receiver also counts the specular reflection of that sky. Counting
 * that reflection as diffuse indirect understated a glossy scene's lane ratio.
 */
export async function verifyPathReceiver(fixture: RayPathFixture) {
  const device = (await (await gpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const mean = async (name: string, receiver: 'full' | 'diffuse') => {
    const material = fixture.materials.find((m) => m.name === name);
    assert(material);
    const tracer = (
      await createRayPathTracer(device, gpu.createShaderModule, {
        kernel: fixture.kernel,
        scene: buildRaySurfaceScene([plane()]).unwrap(),
        materials: [{ id: 0, ...material }],
        lights: [],
        settings: { ...settings, receiver, environment: [1, 1, 1], maxBounces: 2 },
      })
    ).unwrap();
    try {
      for (let chunk = 0; chunk < SAMPLES; chunk += 32) {
        const e = device.createCommandEncoder({}).unwrap();
        for (let i = 0; i < 32; i++) tracer.recordSample(e).unwrap();
        device.queue.submit([e.finish().unwrap()]).unwrap();
      }
      const pixels = settings.width * settings.height;
      const bytes = await readBuffer(device, tracer.buffers.accumulation, pixels * 80);
      const floats = new Float32Array(bytes.buffer),
        words = new Uint32Array(bytes.buffer);
      const sum = [0, 0, 0];
      for (let p = 0; p < pixels; p++) {
        expect(words[p * 20 + 3]).toBe(SAMPLES);
        expect(words[p * 20 + 7]).toBe(0);
        for (let c = 0; c < 3; c++) sum[c] = (sum[c] ?? 0) + (floats[p * 20 + c] ?? NaN) / pixels;
      }
      return sum;
    } finally {
      tracer.dispose();
    }
  };
  const white = await mean('white', 'diffuse');
  const matte = await mean('matte', 'diffuse');
  const metal = await mean('metal', 'diffuse');
  const metalFull = await mean('metal', 'full');
  for (let c = 0; c < 3; c++) {
    expect(white[c]).toBeCloseTo(1, 1);
    expect(matte[c]).toBeCloseTo([0.8, 0.4, 0.2][c] ?? NaN, 1);
    expect(metal[c]).toBe(0);
    expect(metalFull[c]).toBeGreaterThan(0.3);
  }
  return { white, matte, metal, metalFull };
}

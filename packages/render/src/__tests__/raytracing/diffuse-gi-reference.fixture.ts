import { vec3 } from '@forgeax/engine-math';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect } from 'vitest';
import { buildRaySurfaceScene } from '../../raytracing/attributes';
import { createRayPathTracer } from '../../raytracing/path-tracer';
import type { DiffuseGiFixture } from './diffuse-gi.commands';
import { giSource, runGi } from './diffuse-gi.fixture';
import { readBuffer } from './path-tracer.fixture';
/** Independent exact triangles + shared hit BSDF; never reads SDF/cards/probes. */
export async function verifyGiPathReference(fixture: DiffuseGiFixture) {
  const sources = [
    giSource(fixture, 'white', 0, [0, 0, -0.5], [3, 3, 0.5]),
    giSource(fixture, 'red', 1, [-4, 0, 3], [0.5, 2, 2]),
  ];
  const device = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const tracer = (
    await createRayPathTracer(device, webgpu.createShaderModule, {
      kernel: fixture.pathKernel,
      scene: buildRaySurfaceScene(
        sources.map((s) => ({ ...s.instance, materialId: s.sections[0]?.material.id ?? -1 })),
      ).unwrap(),
      materials: sources.map((s, i) => {
        const m = fixture.rayMaterials.find((m) => m.name === (i === 0 ? 'white' : 'red'));
        assert(m);
        return { id: s.sections[0]?.material.id ?? -1, ...m };
      }),
      lights: [
        {
          kind: 'directional',
          contactShadowLength: 0,
          direction: vec3.create(-1, 0, 0),
          color: vec3.create(Math.PI, Math.PI, Math.PI),
          intensity: Math.PI,
        },
      ],
      settings: {
        width: 16,
        height: 16,
        camera: {
          origin: [0, 0, 8],
          target: [0, 0, 0],
          up: [0, 1, 0],
          verticalFov: 2 * Math.atan(2 / 8),
        },
        environment: [0, 0, 0],
        maxDistance: 30,
        maxBounces: 2,
        seed: 47,
      },
    })
  ).unwrap();
  let reference: Uint8Array;
  try {
    for (let batch = 0; batch < 32; batch++) {
      const encoder = device.createCommandEncoder({}).unwrap();
      for (let i = 0; i < 16; i++) tracer.recordSample(encoder).unwrap();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
    }
    reference = await readBuffer(device, tracer.buffers.accumulation, 256 * 80);
  } finally {
    tracer.dispose();
    webgpu._internal_getRawDevice(device)?.destroy();
  }
  const gi = await runGi(fixture, { sources });
  const pt = new Float32Array(reference.buffer),
    counts = new Uint32Array(reference.buffer);
  for (let i = 0; i < 256; i++) {
    expect(counts[i * 20 + 3]).toBe(512);
    expect(counts[i * 20 + 7]).toBe(0);
  }
  const means = (buffer: Uint8Array, offset: number) => {
    const f = new Float32Array(buffer.buffer);
    return [0, 1, 2].map(
      (c) =>
        Array.from({ length: 256 }, (_, i) => f[i * 20 + offset + c] ?? Number.NaN).reduce(
          (a, b) => a + b,
          0,
        ) / 256,
    );
  };
  const ptMean = means(reference, 0),
    rayMean = means(gi.reference, 12),
    fieldMean = means(gi.field, 12);
  expect(pt[0]).toBeGreaterThan(0);
  // Declared diffuse proxy + finite probe/hemisphere quadrature, not a path-traced equality claim.
  for (const m of [rayMean, fieldMean])
    for (let c = 0; c < 3; c++)
      expect(Math.abs((m[c] ?? 0) - (ptMean[c] ?? 0))).toBeLessThan(0.025);
  return { reference, ptMean, rayMean, fieldMean, samples: 512 };
}

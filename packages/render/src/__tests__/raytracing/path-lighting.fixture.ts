import { vec3 } from '@forgeax/engine-math';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect } from 'vitest';
import { buildRaySurfaceScene, type RaySurfaceInstance } from '../../raytracing/attributes';
import {
  createRayPathTracer,
  type RayPathMaterial,
  type RayPathSettings,
} from '../../raytracing/path-tracer';
import type { LightSnapshot } from '../../render-system-extract';
import type { RayPathFixture } from './path-tracer.commands';
import { plane, readBuffer, settings } from './path-tracer.fixture';

export async function verifyPathLighting(fixture: RayPathFixture) {
  const device = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const errors: string[] = [];
  const raw = webgpu._internal_getRawDevice(device);
  raw?.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const matte = fixture.materials.find((m) => m.name === 'matte'),
    emission = fixture.materials.find((m) => m.name === 'emission');
  assert(matte && emission);
  const materials = [
    { id: 0, ...matte },
    { id: 1, ...emission },
  ];
  const run = async (
    instances: RaySurfaceInstance[],
    lights: LightSnapshot[],
    options: RayPathSettings,
    samples = 1,
    selected = materials,
  ) => {
    const tracer = (
      await createRayPathTracer(device, webgpu.createShaderModule, {
        kernel: fixture.kernel,
        scene: buildRaySurfaceScene(instances).unwrap(),
        materials: selected,
        lights,
        settings: options,
      })
    ).unwrap();
    try {
      for (let chunk = 0; chunk < samples; chunk += 16) {
        const e = device.createCommandEncoder({}).unwrap();
        for (let i = chunk; i < Math.min(chunk + 16, samples); i++) tracer.recordSample(e).unwrap();
        device.queue.submit([e.finish().unwrap()]).unwrap();
        await device.queue.onSubmittedWorkDone();
      }
      const bytes = await readBuffer(
        device,
        tracer.buffers.accumulation,
        options.width * options.height * 80,
      );
      const u = new Uint32Array(bytes.buffer);
      for (let i = 0; i < options.width * options.height; i++) {
        expect(u[i * 20 + 3]).toBe(samples);
        expect(u[i * 20 + 7]).toBe(0);
      }
      return bytes;
    } finally {
      tracer.dispose();
    }
  };
  try {
    const dark = { ...settings, environment: [0, 0, 0] as const, maxBounces: 1 };
    const luminous = new Float32Array((await run([plane(1)], [], dark)).buffer);
    expect(luminous[0]).toBeCloseTo(2, 5);
    expect(luminous[1]).toBeCloseTo(1, 5);
    expect(luminous[2]).toBeCloseTo(0.5, 5);
    const sun: LightSnapshot = {
      kind: 'directional',
      contactShadowLength: 0,
      color: vec3.create(Math.PI, Math.PI, Math.PI),
      direction: vec3.create(-1, 0, -1),
      intensity: Math.PI,
    };
    const lit = new Float32Array((await run([plane()], [sun], dark)).buffer);
    expect(lit[0]).toBeGreaterThan(0.55);
    expect(lit[0]).toBeLessThan(0.6);
    // Offset blocker intersects shadow rays while staying outside primary rays.
    const blocker = {
      ...plane(),
      instanceId: 8,
      positions: [0.5, -3, 1, 2, -3, 1, 2, 3, 1, 0.5, 3, 1],
      indices: [0, 2, 1, 0, 3, 2],
    };
    const shadow = new Float32Array((await run([plane(), blocker], [sun], dark)).buffer);
    expect(shadow[0]).toBe(0);
    const back = { ...plane(), indices: [0, 2, 1, 0, 3, 2] };
    const culled = new Float32Array((await run([back], [sun], dark)).buffer);
    expect(culled[0]).toBe(0);
    // Material edits create a new frozen batch, with no old HDR history.
    const changed = {
      ...matte,
      asset: { ...matte.asset, values: { ...matte.asset.values, baseColor: [0.2, 0.4, 0.8, 1] } },
    };
    const edited = new Float32Array(
      (
        await run([plane()], [sun], dark, 1, [
          { id: 0, ...changed },
          { id: 1, ...emission },
        ])
      ).buffer,
    );
    expect(edited[0]).toBeLessThan(lit[0] ?? 0);
    expect(edited[2]).toBeGreaterThan(lit[2] ?? 0);
    // A ceiling emitter outside the primary view is only reachable by a BSDF
    // continuation. This is an emitter-hit test, not emitter NEE evidence.
    const ceiling = {
      ...plane(1),
      instanceId: 8,
      positions: [-20, -20, 3, 20, -20, 3, 20, 20, 3, -20, 20, 3],
      indices: [0, 2, 1, 0, 3, 2],
    };
    const bounceOne = new Float32Array((await run([plane(), ceiling], [], dark, 32)).buffer);
    const bounceTwo = new Float32Array(
      (await run([plane(), ceiling], [], { ...dark, maxBounces: 2 }, 128)).buffer,
    );
    expect(bounceOne[0]).toBe(0);
    const indirect =
      Array.from({ length: 64 }, (_, i) => bounceTwo[i * 20] ?? 0).reduce((a, b) => a + b) / 64;
    expect(indirect).toBeGreaterThan(1.4);
    expect(indirect).toBeLessThan(1.7);
    // Deliberately break material/UV/texture contracts; none may become a black fallback.
    const scene = buildRaySurfaceScene([plane()]).unwrap();
    for (const selected of [
      [],
      [{ id: 0, ...matte, program: { ...matte.program, contract: 'stale' } }],
    ])
      expect(
        (
          await createRayPathTracer(device, webgpu.createShaderModule, {
            kernel: fixture.kernel,
            scene,
            materials: selected,
            lights: [],
            settings: dark,
          })
        ).ok,
      ).toBe(false);
    const textured = fixture.materials.find((m) => m.name === 'textured');
    assert(textured);
    for (const instances of [[{ ...plane(), uvSets: [] }], [plane()]])
      expect(
        (
          await createRayPathTracer(device, webgpu.createShaderModule, {
            kernel: fixture.kernel,
            scene: buildRaySurfaceScene(instances).unwrap(),
            materials: [{ id: 0, ...textured }],
            lights: [],
            settings: dark,
          })
        ).ok,
      ).toBe(false);
    const result = {
      emission: Array.from(luminous.slice(0, 3)),
      direct: Array.from(lit.slice(0, 3)),
      shadow: Array.from(shadow.slice(0, 3)),
      indirect,
    };
    expect(errors).toEqual([]);
    return result;
  } finally {
    raw?.destroy();
  }
}

export async function renderPathGallery(fixture: RayPathFixture) {
  const device = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const matte = fixture.materials.find((m) => m.name === 'matte'),
    metal = fixture.materials.find((m) => m.name === 'metal'),
    emission = fixture.materials.find((m) => m.name === 'emission');
  assert(matte && metal && emission);
  const materials: RayPathMaterial[] = [
    [0.7, 0.7, 0.7, 1],
    [0.65, 0.05, 0.03, 1],
    [0.03, 0.3, 0.65, 1],
  ].map((baseColor, id) => ({
    id,
    ...matte,
    asset: { ...matte.asset, values: { ...matte.asset.values, baseColor } },
  }));
  materials.push({ id: 3, ...metal }, { id: 4, ...emission });
  const instances: RaySurfaceInstance[] = [];
  const quad = (id: number, p: number[]) =>
    instances.push({ ...plane(id), instanceId: instances.length + 1, positions: p });
  quad(0, [-2, 0, 2, 2, 0, 2, 2, 0, -2, -2, 0, -2]);
  quad(0, [-2, 0, -2, 2, 0, -2, 2, 4, -2, -2, 4, -2]);
  quad(1, [-2, 0, 2, -2, 0, -2, -2, 4, -2, -2, 4, 2]);
  quad(2, [2, 0, -2, 2, 0, 2, 2, 4, 2, 2, 4, -2]);
  quad(0, [-2, 4, -2, 2, 4, -2, 2, 4, 2, -2, 4, 2]);
  quad(4, [-0.6, 3.99, -0.6, 0.6, 3.99, -0.6, 0.6, 3.99, 0.6, -0.6, 3.99, 0.6]);
  // A raised metal box gives visible occlusion and glossy indirect response.
  quad(3, [-0.6, 1.4, 0.3, 0.6, 1.4, 0.3, 0.6, 1.4, -0.9, -0.6, 1.4, -0.9]);
  quad(3, [-0.6, 0, 0.3, 0.6, 0, 0.3, 0.6, 1.4, 0.3, -0.6, 1.4, 0.3]);
  quad(3, [-0.6, 0, -0.9, -0.6, 0, 0.3, -0.6, 1.4, 0.3, -0.6, 1.4, -0.9]);
  quad(3, [0.6, 0, 0.3, 0.6, 0, -0.9, 0.6, 1.4, -0.9, 0.6, 1.4, 0.3]);
  const options: RayPathSettings = {
    width: 64,
    height: 64,
    camera: { origin: [0, 1.8, 5.5], target: [0, 1.8, -0.5], up: [0, 1, 0], verticalFov: 0.75 },
    seed: 47,
    maxBounces: 4,
    environment: [0.03, 0.03, 0.03],
    maxDistance: 100,
  };
  const tracer = (
    await createRayPathTracer(device, webgpu.createShaderModule, {
      kernel: fixture.kernel,
      scene: buildRaySurfaceScene(instances).unwrap(),
      materials,
      lights: [
        {
          kind: 'point',
          color: vec3.create(12, 12, 12),
          position: vec3.create(0, 3.5, 0),
          intensity: 12,
          invRangeSquared: 0,
        },
      ],
      settings: options,
    })
  ).unwrap();
  try {
    for (let chunk = 0; chunk < 8; chunk++) {
      const e = device.createCommandEncoder({}).unwrap();
      for (let i = 0; i < 16; i++) tracer.recordSample(e).unwrap();
      device.queue.submit([e.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
    }
    const bytes = await readBuffer(device, tracer.buffers.accumulation, 64 * 64 * 80);
    const u = new Uint32Array(bytes.buffer);
    for (let i = 0; i < 4096; i++) {
      expect(u[i * 20 + 3]).toBe(128);
      expect(u[i * 20 + 7]).toBe(0);
    }
    return { bytes, width: 64, height: 64, samples: 128 };
  } finally {
    tracer.dispose();
    webgpu._internal_getRawDevice(device)?.destroy();
  }
}

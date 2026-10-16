import type { RhiDevice } from '@forgeax/engine-rhi';
import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import { assert, expect } from 'vitest';
import { buildRaySurfaceScene } from '../../raytracing/attributes';
import { CARD_LOOKUP_STRIDE, createSdfCardLookup } from '../../raytracing/card-lookup';
import { createRayPathTracer } from '../../raytracing/path-tracer';
import { createSdfQuery } from '../../raytracing/sdf-query';
import { createSurfaceCapture } from '../../raytracing/surface-cards';
import type { RayPathFixture } from './path-tracer.commands';
import { readBuffer, settings } from './path-tracer.fixture';
import type { SdfCardsFixture } from './sdf-cards.commands';
import { sdfCubeInstance } from './sdf-cards.fixture';

export async function verifyNormalFrame(path: RayPathFixture, fixture: SdfCardsFixture) {
  const recorder = attachRecorder(webgpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const raw = webgpu._internal_getRawDevice(
      (device as RhiDevice & { _realDevice: RhiDevice })._realDevice,
    ),
    errors: string[] = [];
  assert(raw, 'recorder source device must be observable for validation and teardown');
  raw.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const normals: number[] = [],
    tangents: number[] = [];
  for (let i = 0; i < sdfCubeInstance.positions.length; i += 3) {
    const x = sdfCubeInstance.positions[i] ?? 0,
      y = sdfCubeInstance.positions[i + 1] ?? 0,
      z = sdfCubeInstance.positions[i + 2] ?? 0;
    const length = Math.hypot(3 * x, 0.2 * y, z),
      tangentLength = Math.hypot(z, 3 * x);
    normals.push((3 * x) / length, (0.2 * y) / length, z / length);
    tangents.push(z / tangentLength, 0, (-3 * x) / tangentLength, -1);
  }
  const instance = {
    ...sdfCubeInstance,
    normals,
    tangents,
    transform: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  };
  const field = {
    ...fixture.field,
    bricks: Uint32Array.from(fixture.field.bricks),
    values: Float32Array.from(fixture.field.values),
  };
  const source = {
    instance,
    layout: fixture.layout,
    sections: [
      {
        indexOffset: 0,
        indexCount: instance.indices.length,
        material: { id: 0, ...fixture.normalMap.card },
        textureContentKey: 'normal:1',
      },
    ],
  };
  const texture = device
    .createTexture({ size: { width: 2, height: 2 }, format: 'rgba8unorm', usage: 6 })
    .unwrap();
  device.queue
    .writeTexture(
      { texture },
      new Uint8Array([
        133, 128, 255, 255, 133, 128, 255, 255, 133, 128, 255, 255, 133, 128, 255, 255,
      ]),
      { bytesPerRow: 8 },
      { width: 2, height: 2 },
    )
    .unwrap();
  const textureView = device.createTextureView(texture, {}).unwrap(),
    sampler = device.createSampler({}).unwrap();
  const resolveTexture = () => ok({ view: textureView, sampler });
  const { tangents: _tangents, ...missingFrame } = instance;
  expect(
    (
      await createSurfaceCapture(
        device,
        recorder.backend.createShaderModule,
        [{ ...source, instance: missingFrame }],
        { kind: 'cards', resolution: 16 },
        resolveTexture,
      )
    ).ok,
  ).toBe(false);
  expect(
    (
      await createRayPathTracer(device, recorder.backend.createShaderModule, {
        scene: buildRaySurfaceScene([missingFrame]).unwrap(),
        kernel: path.kernel,
        materials: [{ id: 0, ...fixture.normalMap.ray }],
        lights: [],
        settings,
        resolveTexture,
      })
    ).ok,
  ).toBe(false);
  const cards = (
    await createSurfaceCapture(
      device,
      recorder.backend.createShaderModule,
      [source],
      { kind: 'cards', resolution: 16 },
      resolveTexture,
    )
  ).unwrap();
  const query = (
    await createSdfQuery(
      device,
      recorder.backend.createShaderModule,
      [{ ...instance, field }],
      [0.8, -0.8].map((x) => ({
        origin: [x, 0, 3] as const,
        direction: [0, 0, -1] as const,
        tMin: 0,
        tMax: 10,
        mask: 255,
      })),
    )
  ).unwrap();
  const lookup = (
    await createSdfCardLookup(device, recorder.backend.createShaderModule, query, cards, [source])
  ).unwrap();
  const stale = (
    await createSdfCardLookup(device, recorder.backend.createShaderModule, query, cards, [
      { ...source, instance: { ...instance, normals: normals.map((v) => -v) } },
    ])
  ).unwrap();
  const tracer = (
    await createRayPathTracer(device, recorder.backend.createShaderModule, {
      scene: buildRaySurfaceScene([instance]).unwrap(),
      kernel: path.kernel,
      materials: [{ id: 0, ...fixture.normalMap.ray }],
      resolveTexture,
      lights: [],
      settings: {
        ...settings,
        maxBounces: 1,
        camera: { origin: [0.8, 0, 3], target: [0.8, 0, 1], up: [0, 1, 0], verticalFov: 0.001 },
      },
    })
  ).unwrap();
  const captured = recorder.captureFrame();
  (await recorder.frameBoundary()).unwrap();
  const encoder = device.createCommandEncoder({}).unwrap();
  tracer.recordSample(encoder).unwrap(); // works 0..4
  cards.record(encoder).unwrap(); // works 5..10
  query.record(encoder).unwrap(); // work 11
  lookup.record(encoder).unwrap(); // work 12
  stale.record(encoder).unwrap(); // work 13
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  const inputBytes = await readBuffer(device, tracer.buffers.inputs, 64 * 224);
  const surfaceBytes = await readBuffer(device, tracer.buffers.surfaces, 64 * 96);
  const pathBytes = await readBuffer(device, tracer.buffers.paths, 64 * 80);
  const lookupBytes = await readBuffer(device, lookup.buffer, 2 * CARD_LOOKUP_STRIDE);
  const staleBytes = await readBuffer(device, stale.buffer, 2 * CARD_LOOKUP_STRIDE);
  (await recorder.frameBoundary()).unwrap();
  const bytes = (await captured).unwrap().bytes;
  const inputs = new Float32Array(inputBytes.buffer),
    surfaces = new Float32Array(surfaceBytes.buffer),
    paths = new Float32Array(pathBytes.buffer);
  const inputIds = new Uint32Array(inputBytes.buffer),
    surfaceIds = new Uint32Array(surfaceBytes.buffer);
  for (let i = 0; i < 64; i++) {
    expect(inputIds[i * 56 + 53]).toBe(1);
    for (const [lane, value] of [0, 0, 1, 1].entries())
      expect(inputs[i * 56 + 8 + lane]).toBeCloseTo(value, 6);
    expect(inputs[i * 56 + 15]).toBeCloseTo(1, 6); // authored -1 times mirrored winding -1
    expect(surfaceIds[i * 24 + 16]).toBe(1);
    const nv = Array.from(inputs.slice(i * 56 + 48, i * 56 + 51)),
      nvLength = Math.hypot(...nv);
    expect(
      Math.hypot(...nv.map((v, c) => (surfaces[i * 24 + 4 + c] ?? 0) - v / nvLength)),
    ).toBeGreaterThan(0.02);
    expect(surfaces[i * 24 + 4]).toBeGreaterThan(0.85);
    expect(surfaces[i * 24 + 6]).toBeLessThan(0.5);
    for (const [lane, value] of [0, 0, 1].entries())
      expect(surfaces[i * 24 + 20 + lane]).toBeCloseTo(value, 6);
    expect(paths[i * 20]).toBe(inputs[i * 56 + 4]); // offset along geometry, not the tilted shading normal
    expect(paths[i * 20 + 1]).toBe(inputs[i * 56 + 5]);
    expect(paths[i * 20 + 2]).toBeGreaterThan(inputs[i * 56 + 6] ?? 0);
    expect(paths[i * 20 + 15]).toBe(0);
  }
  const mapped = new Float32Array(lookupBytes.buffer),
    mappedIds = new Uint32Array(lookupBytes.buffer),
    staleIds = new Uint32Array(staleBytes.buffer);
  for (let i = 0; i < 2; i++) {
    expect(mappedIds[i * (CARD_LOOKUP_STRIDE / 4)]).toBe(1); // geometric match survives a shading normal below the old 0.5 cutoff
    expect(Math.abs(mapped[i * (CARD_LOOKUP_STRIDE / 4) + 8] ?? 0)).toBeGreaterThan(0.85);
    expect(mapped[i * (CARD_LOOKUP_STRIDE / 4) + 10]).toBeLessThan(0.5);
    expect(staleIds[i * (CARD_LOOKUP_STRIDE / 4)]).toBe(3);
  }
  // Counterfactual: using shading normals for geometry association loses both hits.
  const wrongNormalLookup = (
    await createSdfCardLookup(
      device,
      (d, desc) => {
        const geometricMatch = 'dot(decodeCardNormal(frame.zw),hitNormal)';
        expect(desc.code.split(geometricMatch)).toHaveLength(2);
        return recorder.backend.createShaderModule(d, {
          ...desc,
          code: desc.code.replace(geometricMatch, 'dot(decodeCardNormal(frame.xy),hitNormal)'),
        });
      },
      query,
      cards,
      [source],
    )
  ).unwrap();
  const counterfactual = device.createCommandEncoder({}).unwrap();
  wrongNormalLookup.record(counterfactual).unwrap();
  device.queue.submit([counterfactual.finish().unwrap()]).unwrap();
  const wrong = new Uint32Array(
    (await readBuffer(device, wrongNormalLookup.buffer, 2 * CARD_LOOKUP_STRIDE)).buffer,
  );
  expect([wrong[0], wrong[CARD_LOOKUP_STRIDE / 4]]).toEqual([2, 2]);
  wrongNormalLookup.dispose();
  expect(errors).toEqual([]);
  tracer.dispose();
  lookup.dispose();
  stale.dispose();
  query.dispose();
  cards.dispose();
  device.destroyTexture(texture).unwrap();
  (await recorder.dispose()).unwrap();
  raw.destroy();
  const tape = decodeTape(bytes).unwrap(),
    model = buildFrameModel(tape);
  expect(model.works).toHaveLength(14);
  const fresh = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const replay = (
    await openReplay(tape, { device: fresh, createShaderModule: webgpu.createShaderModule })
  ).unwrap();
  try {
    for (const [work, binding, expected] of [
      [3, 4, inputBytes],
      [3, 5, surfaceBytes],
      [3, 3, pathBytes],
      [12, 2, lookupBytes],
      [13, 2, staleBytes],
    ] as const) {
      const resource = model.works[work]?.bindings.find((b) => b.binding === binding)?.resourceId;
      assert(resource);
      expect(Array.from((await replay.readResourceAtWork(resource, work)).unwrap().bytes)).toEqual(
        Array.from(expected),
      );
    }
    // The first card cannot contain the later +Z raster result. Replay must honor work prefixes.
    const depth = model.works[12]?.bindings.find((b) => b.binding === 7)?.resourceId;
    assert(depth);
    const before = new Float32Array(
      (await replay.readResourceAtWork(depth, 5)).unwrap().bytes.slice().buffer,
    );
    const after = new Float32Array(
      (await replay.readResourceAtWork(depth, 10)).unwrap().bytes.slice().buffer,
    );
    const columns = cards.width / cards.resolution;
    const pixel = (Math.floor(4 / columns) * 16 + 8) * cards.width + (4 % columns) * 16 + 8;
    expect(before[pixel]).toBe(1);
    // Half-cell near margin over a two-cell depth interval places the box face at 0.25.
    expect(after[pixel]).toBeCloseTo(0.25, 5);
  } finally {
    (await replay.dispose()).unwrap();
  }
  return {
    bytes,
    inputBytes,
    surfaceBytes,
    lookupBytes,
    results: {
      works: 14,
      errors,
      mirroredPrimaryHits: 64,
      mapped: 2,
      stale: 2,
      counterfactualUnmapped: 2,
    },
  };
}

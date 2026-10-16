import { vec3 } from '@forgeax/engine-math';
import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect } from 'vitest';
import {
  createDiffuseGi,
  type DiffuseGiSettings,
  GI_PIXEL_STRIDE,
} from '../../raytracing/diffuse-gi';
import type { SurfaceCardSource } from '../../raytracing/surface-cards';
import type { DiffuseGiFixture } from './diffuse-gi.commands';
import { readBuffer } from './path-tracer.fixture';
import { sdfCubeIndices, sdfCubePositions } from './sdf-cards.geometry';
export const giSettings: DiffuseGiSettings = {
  view: {
    origin: [-2, 2, 8],
    u: [1, 0, 0],
    v: [0, -1, 0],
    n: [0, 0, 1],
    width: 4,
    height: 4,
    depth: 16,
  },
  resolution: 16,
  cardResolution: 16,
  probeOrigin: [-2.5, -2.5, 0.25],
  probeSpacing: 2.5,
  probeCounts: [3, 3, 3],
  samples: 64,
  iterations: 0,
  environment: [0, 0, 0],
};
export function giSource(
  fixture: DiffuseGiFixture,
  name: string,
  id: number,
  center: readonly number[],
  scale: readonly number[],
): SurfaceCardSource & { readonly field: import('@forgeax/engine-geometry').MeshDistanceField } {
  const m = fixture.materials.find((m) => m.name === name);
  assert(m);
  return {
    sections: [{ indexOffset: 0, indexCount: sdfCubeIndices.length, material: { id, ...m } }],
    layout: fixture.layout,
    field: {
      ...fixture.field,
      bricks: Uint32Array.from(fixture.field.bricks),
      values: Float32Array.from(fixture.field.values),
    },
    instance: {
      instanceId: id,
      geometryId: id,
      mask: 255,
      positions: sdfCubePositions,
      indices: sdfCubeIndices,
      transform: [
        scale[0] ?? Number.NaN,
        0,
        0,
        0,
        0,
        scale[1] ?? Number.NaN,
        0,
        0,
        0,
        0,
        scale[2] ?? Number.NaN,
        0,
        center[0] ?? Number.NaN,
        center[1] ?? Number.NaN,
        center[2] ?? Number.NaN,
        1,
      ],
    },
  };
}
export async function runGi(
  fixture: DiffuseGiFixture,
  options: {
    sources?: ReturnType<typeof giSource>[];
    settings?: Partial<DiffuseGiSettings>;
    lights?: boolean | readonly import('../../render-system-extract').LightSnapshot[];
    scene?: import('../../raytracing/sdf-query').SdfMeshInstance[];
    capture?: boolean;
  } = {},
) {
  const recorder = options.capture ? attachRecorder(webgpu).unwrap() : undefined;
  const backend = recorder?.backend ?? webgpu;
  const device = (await (await backend.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const errors: string[] = [];
  webgpu
    ._internal_getRawDevice(device)
    ?.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const sources = options.sources ?? [
    giSource(fixture, 'white', 0, [0, 0, -0.5], [3, 3, 0.5]),
    giSource(fixture, 'red', 1, [-4, 0, 3], [0.5, 2, 2]),
  ];
  const s = { ...giSettings, ...options.settings };
  const gi = (
    await createDiffuseGi(device, backend.createShaderModule, {
      kernel: fixture.kernel,
      sources,
      scene: options.scene ?? sources.map((s) => ({ ...s.instance, field: s.field })),
      lights:
        options.lights === false
          ? []
          : typeof options.lights === 'object'
            ? options.lights
            : [
                {
                  kind: 'directional',
                  contactShadowLength: 0,
                  direction: vec3.create(-1, 0, 0),
                  color: vec3.create(Math.PI, Math.PI, Math.PI),
                  intensity: Math.PI,
                },
              ],
      settings: s,
    })
  ).unwrap();
  try {
    const captured = recorder?.captureFrame();
    if (recorder) (await recorder.frameBoundary()).unwrap();
    const encoder = device.createCommandEncoder({}).unwrap();
    gi.record(encoder).unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const field = await readBuffer(
      device,
      gi.buffers.field,
      s.resolution * s.resolution * GI_PIXEL_STRIDE,
    );
    const reference = await readBuffer(device, gi.buffers.reference, field.byteLength);
    const surface = await readBuffer(
      device,
      gi.buffers.surface,
      gi.cards.width * gi.cards.height * 64,
    );
    const probes = await readBuffer(
      device,
      gi.buffers.probes,
      gi.diagnostics.probeCount * s.samples * 32,
    );
    if (recorder) (await recorder.frameBoundary()).unwrap();
    const tape = captured ? (await captured).unwrap().bytes : undefined;
    expect(errors).toEqual([]);
    return { field, reference, surface, probes, tape, diagnostics: gi.diagnostics };
  } finally {
    gi.dispose();
    if (recorder) (await recorder.dispose()).unwrap();
    webgpu._internal_getRawDevice(device)?.destroy();
  }
}
export function verifyDiffuseGi(result: Awaited<ReturnType<typeof runGi>>) {
  const f = new Float32Array(result.field.buffer),
    r = new Float32Array(result.reference.buffer),
    u = new Uint32Array(result.field.buffer),
    ru = new Uint32Array(result.reference.buffer);
  const complete = Array.from({ length: 256 }, (_, i) => i).filter(
    (i) => u[i * 20 + 16] === 1 && ru[i * 20 + 16] === 1,
  );
  expect(complete.length).toBeGreaterThan(128);
  for (const i of complete) {
    expect(f[i * 20]).toBeCloseTo(0, 5);
    expect(r[i * 20]).toBeCloseTo(0, 5);
  }
  const mean = (a: Float32Array, c: number) =>
    complete.reduce((n, i) => n + (a[i * 20 + 4 + c] ?? Number.NaN), 0) / complete.length;
  expect(mean(f, 0)).toBeGreaterThan(0.005);
  expect(mean(f, 0)).toBeGreaterThan(mean(f, 1) * 4);
  expect(mean(r, 0)).toBeGreaterThan(0.005);
  expect(mean(r, 0)).toBeGreaterThan(mean(r, 1) * 4);
  return result;
}

export async function verifyGiReplay(result: Awaited<ReturnType<typeof runGi>>) {
  assert(result.tape);
  const tape = decodeTape(result.tape).unwrap(),
    model = buildFrameModel(tape);
  const device = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const replay = (
    await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
  ).unwrap();
  try {
    const fieldWork = model.works.at(-2),
      referenceWork = model.works.at(-1);
    assert(fieldWork && referenceWork);
    for (const [work, name, binding] of [
      [fieldWork, 'field', 7],
      [referenceWork, 'reference', 7],
      [fieldWork, 'surface', 4],
      [fieldWork, 'probes', 6],
    ] as const) {
      const resource = work.bindings.find((b) => b.binding === binding)?.resourceId;
      assert(resource);
      expect(
        Array.from((await replay.readResourceAtWork(resource, work.workIndex)).unwrap().bytes),
      ).toEqual(Array.from(result[name]));
    }
    const resource = fieldWork.bindings.find((b) => b.binding === 7)?.resourceId;
    assert(resource);
    const prefix = (await replay.readResourceAtWork(resource, fieldWork.workIndex - 1)).unwrap()
      .bytes;
    expect(prefix.every((v) => v === 0)).toBe(true);
    expect(result.field.some((v) => v !== 0)).toBe(true);
  } finally {
    (await replay.dispose()).unwrap();
    webgpu._internal_getRawDevice(device)?.destroy();
  }
  return model.works.length;
}

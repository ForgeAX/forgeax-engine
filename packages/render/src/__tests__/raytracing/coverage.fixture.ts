import { vec3 } from '@forgeax/engine-math';
import { RenderGraphBuilder, type RenderGraphFrame } from '@forgeax/engine-render-graph';
import type { Buffer } from '@forgeax/engine-rhi';
import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import { assert, expect } from 'vitest';
import { buildRaySurfaceScene } from '../../raytracing/attributes';
import {
  createRayPathTracer,
  RAY_COVERAGE_CANDIDATES,
  RAY_COVERAGE_ROUNDS,
  rayCoveragePoolCapacity,
} from '../../raytracing/path-tracer';
import type { RayPathFixture } from './path-tracer.commands';
import { plane, readBuffer, settings } from './path-tracer.fixture';

/** Primary and shadow holes, coplanar ordering and bounded failure share one GPU path. */
export async function verifyCoverage(
  fixture: RayPathFixture,
  evidence?: (bytes: Uint8Array) => Promise<void>,
) {
  const recorder = attachRecorder(webgpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const cutout = fixture.materials.find((m) => m.name === 'cutout');
  const white = fixture.materials.find((m) => m.name === 'white');
  assert(cutout && white);
  const texture = device
    .createTexture({ size: { width: 2, height: 1 }, format: 'rgba8unorm', usage: 6 })
    .unwrap();
  device.queue
    .writeTexture(
      { texture },
      new Uint8Array([255, 255, 255, 0, 255, 255, 255, 255]),
      { bytesPerRow: 8 },
      { width: 2, height: 1 },
    )
    .unwrap();
  const view = device.createTextureView(texture, {}).unwrap();
  const sampler = device.createSampler({ minFilter: 'nearest', magFilter: 'nearest' }).unwrap();
  const mesh = (id: number, materialId: number, z: number) => ({
    ...plane(materialId),
    instanceId: id,
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, z, 1],
  });
  const light = {
    kind: 'directional' as const,
    contactShadowLength: 0,
    direction: vec3.create(0, 0, -1),
    color: vec3.create(Math.PI, Math.PI, Math.PI),
    intensity: Math.PI,
  };
  const cases = [
    { name: 'background', meshes: [mesh(0, 0, 1)], cameraZ: 2 },
    { name: 'primary', meshes: [mesh(0, 0, 1), mesh(1, 1, 0)], cameraZ: 2 },
    { name: 'coplanar', meshes: [mesh(0, 0, 0), mesh(1, 1, 0)], cameraZ: 2 },
    { name: 'close-layer', meshes: [mesh(0, 0, 0.000001), mesh(1, 1, 0)], cameraZ: 2 },
    { name: 'cutoff-equality', meshes: [mesh(0, 0, 1), mesh(1, 1, 0)], cameraZ: 2 },
    { name: 'secondary', meshes: [mesh(0, 0, 1), mesh(1, 1, 0)], cameraZ: 0.5 },
    { name: 'secondary-control', meshes: [mesh(1, 1, 0)], cameraZ: 0.5 },
    { name: 'shadow', meshes: [mesh(0, 0, 1), mesh(1, 1, 0)], cameraZ: 0.5 },
    {
      name: 'exhaustion',
      meshes: Array.from({ length: RAY_COVERAGE_CANDIDATES + 1 }, (_, id) => mesh(id, 0, 0)),
      cameraZ: 2,
    },
    // Every pixel rejects its whole candidate budget: more than the rounds can pool.
    {
      name: 'overflow',
      meshes: Array.from({ length: RAY_COVERAGE_CANDIDATES + 1 }, (_, id) => mesh(id, 0, 0)),
      cameraZ: 2,
    },
  ];
  const pool = rayCoveragePoolCapacity(64);
  // Exhaustion needs a second round; overflow outlasts every round.
  expect(32 * RAY_COVERAGE_CANDIDATES).toBeGreaterThan(pool);
  expect(64 * RAY_COVERAGE_CANDIDATES).toBeGreaterThan(RAY_COVERAGE_ROUNDS * pool);
  const tracers = [];
  const outputs: Uint8Array[] = [];
  const overflow: number[] = [];
  const overflowCount = async (coverage: Buffer) =>
    new Uint32Array((await readBuffer(device, coverage, 16)).buffer)[3] ?? -1;
  try {
    for (const item of cases)
      tracers.push(
        (
          await createRayPathTracer(device, recorder.backend.createShaderModule, {
            kernel: fixture.kernel,
            scene: buildRaySurfaceScene(item.meshes).unwrap(),
            materials:
              item.name === 'secondary-control'
                ? [{ ...white, id: 1 }]
                : [
                    {
                      ...cutout,
                      id: 0,
                      asset: {
                        ...cutout.asset,
                        values: {
                          ...cutout.asset.values,
                          baseColor: [
                            1,
                            1,
                            1,
                            item.name === 'cutoff-equality'
                              ? 0.5
                              : item.name === 'secondary' || item.name === 'overflow'
                                ? 0
                                : 1,
                          ],
                        },
                      },
                    },
                    { ...white, id: 1 },
                  ],
            lights: item.name.startsWith('secondary') ? [] : [light],
            settings: {
              ...settings,
              maxBounces: item.name.startsWith('secondary') ? 2 : 1,
              environment: item.name.startsWith('secondary') ? [1, 1, 1] : [0, 0, 0],
              camera: { ...settings.camera, origin: [0, 0, item.cameraZ] },
            },
            resolveTexture: () => ok({ view, sampler }),
          })
        ).unwrap(),
      );
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    for (const [index, tracer] of tracers.entries()) {
      const encoder = device.createCommandEncoder({}).unwrap();
      if (cases[index]?.name === 'shadow') {
        const missing = tracer.addSampleToGraph(new RenderGraphBuilder<RenderGraphFrame>(), {
          label: 'missing-texture',
          buffers: new Map(),
          textures: new Map(),
          reset: true,
        });
        expect(missing.ok).toBe(false);
        if (!missing.ok) expect(JSON.stringify(missing.error)).toContain('material texture');
        const graph = new RenderGraphBuilder<RenderGraphFrame>();
        const imported = graph
          .importTexture(
            'coverage',
            {
              size: { width: 2, height: 1 },
              format: 'rgba8unorm',
              usage: 6,
            },
            () => texture,
          )
          .unwrap();
        let currentView = view;
        const mapped = graph.importView(imported, {}, () => currentView).unwrap();
        tracer
          .addSampleToGraph(graph, {
            label: 'masked-shadow',
            buffers: new Map(),
            textures: new Map([[view, mapped]]),
            reset: true,
          })
          .unwrap();
        const compiled = graph.compile({ device, surfaceSize: { width: 8, height: 8 } }).unwrap();
        try {
          expect(compiled.inspect().passes.filter((pass) => pass.kind === 'copy')).toHaveLength(1);
          compiled.execute({ encoder }).unwrap();
          device.queue.submit([encoder.finish().unwrap()]).unwrap();
          outputs.push(await readBuffer(device, tracer.buffers.accumulation, 64 * 80));
          overflow[index] = await overflowCount(tracer.buffers.coverage);
          currentView = device.createTextureView(texture, {}).unwrap();
          const stale = compiled.execute({ encoder: device.createCommandEncoder({}).unwrap() });
          expect(stale.ok).toBe(false);
          if (!stale.ok)
            expect(JSON.stringify(stale.error)).toContain('transport texture generation changed');
        } finally {
          await compiled.retire();
        }
        continue;
      }
      tracer.recordSample(encoder).unwrap();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      outputs.push(await readBuffer(device, tracer.buffers.accumulation, 64 * 80));
      overflow[index] = await overflowCount(tracer.buffers.coverage);
    }
    (await recorder.frameBoundary()).unwrap();
    const captured = (await pending).unwrap();
    await evidence?.(captured.bytes);
    for (let c = 0; c < cases.length; c++) {
      const output = outputs[c];
      assert(output);
      const f = new Float32Array(output.buffer),
        u = new Uint32Array(output.buffer);
      for (let i = 0; i < 64; i++) {
        const hole = i % 8 < 4;
        if (cases[c]?.name === 'overflow' || (cases[c]?.name === 'exhaustion' && hole)) {
          expect(u[i * 20 + 7]).toBe(1);
          expect(u[i * 20 + 3]).toBe(0);
        } else {
          expect(u[i * 20 + 7], `${cases[c]?.name} pixel ${i}`).toBe(0);
          expect(u[i * 20 + 3]).toBe(1);
          if (cases[c]?.name === 'background' && hole) {
            expect(Array.from(u.subarray(i * 20 + 16, i * 20 + 20))).toEqual([
              0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff,
            ]);
            expect(f[i * 20]).toBe(0);
          } else if (cases[c]?.name === 'shadow') {
            // F0=0 derives F90=0, so the lit hole carries only the diffuse term.
            if (hole) {
              expect(f[i * 20]).toBeGreaterThan(0.99);
              expect(f[i * 20]).toBeLessThan(1.01);
            } else expect(f[i * 20]).toBe(0);
          } else
            expect(u[i * 20 + 16]).toBe(
              cases[c]?.name === 'cutoff-equality' || cases[c]?.name.startsWith('secondary')
                ? 1
                : hole
                  ? 1
                  : 0,
            );
        }
      }
    }
    // Deferred rays finish exhaustion within the rounds; only true overflow is counted.
    expect(overflow).toEqual(cases.map((c) => (c.name === 'overflow' ? overflow.at(-1) : 0)));
    expect(overflow.at(-1)).toBeGreaterThan(0);
    const secondary = outputs[cases.findIndex((c) => c.name === 'secondary')];
    const control = outputs[cases.findIndex((c) => c.name === 'secondary-control')];
    assert(secondary && control);
    const a = new Float32Array(secondary.buffer),
      b = new Float32Array(control.buffer);
    for (let i = 0; i < 64; i++)
      for (let channel = 0; channel < 3; channel++)
        expect(a[i * 20 + channel]).toBeCloseTo(b[i * 20 + channel] ?? 0, 5);
    tracers.forEach((t) => {
      t.dispose();
    });
    device.destroyTexture(texture).unwrap();
    (await recorder.dispose()).unwrap();
    const model = buildFrameModel(decodeTape(captured.bytes).unwrap());
    const accumulates = model.works.filter((w) =>
      w.pipeline.shaders.some((s) => s.entryPoint === 'accumulate'),
    );
    expect(accumulates).toHaveLength(cases.length);
    const fresh = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const replay = (
      await openReplay(decodeTape(captured.bytes).unwrap(), {
        device: fresh,
        createShaderModule: webgpu.createShaderModule,
      })
    ).unwrap();
    try {
      for (let c = 0; c < accumulates.length; c++) {
        const work = accumulates[c];
        assert(work);
        const resource = work.bindings.find((b) => b.binding === 6)?.resourceId;
        assert(resource);
        expect((await replay.readResourceAtWork(resource, work.workIndex)).unwrap().bytes).toEqual(
          outputs[c],
        );
      }
    } finally {
      (await replay.dispose()).unwrap();
    }
    return {
      bytes: captured.bytes,
      digest: captured.digest,
      works: model.works.length,
      cases: cases.map((c) => c.name),
    };
  } finally {
    tracers.forEach((t) => {
      t.dispose();
    });
    (await recorder.dispose()).unwrap();
  }
}

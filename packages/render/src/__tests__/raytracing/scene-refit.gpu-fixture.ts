import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect } from 'vitest';
import { buildRaySurfaceScene, type RaySurfaceScene } from '../../raytracing/attributes';
import { createRayPathTracer, type RayPathTracer } from '../../raytracing/path-tracer';
import { RaySceneRefit } from '../../raytracing/scene-refit';
import type { RayPathFixture } from './path-tracer.commands';
import { plane, readBuffer, settings } from './path-tracer.fixture';

/** Real traversal after bounded uploads must match a fresh cold transport and falsify the old pose. */
export async function verifyRaySceneRefit(fixture: RayPathFixture) {
  const device = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const material = fixture.materials.find((entry) => entry.name === 'matte');
  assert(material);
  const original = plane();
  const scene = buildRaySurfaceScene([original]).unwrap();
  const create = async (scene: RaySurfaceScene) =>
    (
      await createRayPathTracer(device, webgpu.createShaderModule, {
        kernel: fixture.kernel,
        scene,
        materials: [{ ...material, id: 0 }],
        lights: [],
        settings,
      })
    ).unwrap();
  const sample = async (transport: RayPathTracer) => {
    const encoder = device.createCommandEncoder({}).unwrap();
    transport.reset(encoder).unwrap();
    transport.recordSample(encoder).unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    return readBuffer(device, transport.buffers.accumulation, 64 * 80);
  };
  const tracer = await create(scene);
  let cold: RayPathTracer | undefined;
  try {
    const before = await sample(tracer);
    const moved = { ...original, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 0, 0, 1] };
    const rebuilt = buildRaySurfaceScene([moved]).unwrap();
    const refit = new RaySceneRefit(scene, new Uint32Array(7 * 16));
    const patch = refit.patch(0, rebuilt, [0]);
    assert(patch);
    const edit = refit.apply([patch]);
    tracer.updateScene(scene, edit).unwrap();
    const incremental = await sample(tracer);
    cold = await create(rebuilt);
    const reference = await sample(cold);
    expect(incremental).toEqual(reference);
    expect(incremental).not.toEqual(before);
    return {
      before,
      incremental,
      reference,
      triangleRows: edit.triangles.length,
      nodeRows: edit.nodes.length,
    };
  } finally {
    cold?.dispose();
    tracer.dispose();
    webgpu._internal_getRawDevice(device)?.destroy();
  }
}

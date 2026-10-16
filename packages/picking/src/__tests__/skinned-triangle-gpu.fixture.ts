import { mat4 } from '@forgeax/engine-math';
import type { Renderer } from '@forgeax/engine-render';
import { Instances } from '@forgeax/engine-render';
import {
  buildFrameModel,
  decodeTape,
  encodeTape,
  halfToFloat,
  openReplay,
  type RecorderAttachment,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { GlobalTransform, MorphWeights } from '@forgeax/engine-scene';
import { expect } from 'vitest';
import { pickTriangle } from '../pick-triangle';
import { morphScene } from './morph-scene.fixture';
import { skinScene } from './skin-scene.fixture';

type Save = (name: string, bytes: Uint8Array) => void | Promise<void>;
export const SKIN_PICK_SIZE = 128;
const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v, null, 2));
const required = <T>(v: T | null | undefined): T => {
  if (v === undefined || v === null) throw new Error('Missing skin picking evidence');
  return v;
};
export function renderValue<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) throw result.error;
  return result.value;
}
function rgba(bytes: Uint8Array, pitch: number): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: SKIN_PICK_SIZE * SKIN_PICK_SIZE * 4 }, (_, i) =>
    halfToFloat(
      view.getUint16(
        Math.floor(i / (SKIN_PICK_SIZE * 4)) * pitch +
          (Math.floor(i / 4) % SKIN_PICK_SIZE) * 8 +
          (i % 4) * 2,
        true,
      ),
    ),
  );
}
function delta(a: readonly number[], b: readonly number[]) {
  return a.reduce((m, v, i) => Math.max(m, Math.abs(v - required(b[i]))), 0);
}

/** Actual Standard skin draw, CPU pixel queries, palette/VBO inspection and fresh-device replay. */
export async function verifySkinnedPicking(
  renderer: Renderer,
  recorder: RecorderAttachment,
  save: Save,
  screenshot?: (name: string, pixels: readonly (readonly [number, number])[]) => Promise<void>,
  deformation: 'skin' | 'morph' | 'skin-morph' | 'morph-instances' = 'skin',
  lightweight = false,
) {
  const poseFrames = lightweight ? 8 : 30;
  const querySamples = lightweight ? 20 : 100;
  const scene = deformation === 'skin' ? skinScene() : morphScene(deformation === 'skin-morph');
  const { world } = scene;
  if (deformation === 'morph-instances') {
    const instance = mat4.identity(mat4.create());
    instance[12] = -0.3;
    world
      .addComponent(scene.entity, { component: Instances, data: { transforms: instance } })
      .unwrap();
  }
  const lease = renderValue(renderer.attach(world));
  const errors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const results: unknown[] = [];
  let frames = 0;
  try {
    renderValue(
      renderer.setProfile({ ...renderer.inspect().profile, renderPath: 'forward', ssao: false }),
    );
    for (const [name, x, angle, scale] of [
      ['rest', 0, 0, 1],
      ['posed', 0.9, 0.85, 1.25],
    ] as const) {
      scene.pose(deformation === 'skin' ? x : 0, angle, scale);
      const weight = name === 'rest' ? 0 : 0.2;
      if (deformation !== 'skin')
        world.set(scene.entity, MorphWeights, { weights: new Float32Array([weight]) }).unwrap();
      for (let i = 0; i < poseFrames - 1; i++) {
        const receipt = renderValue(
          renderer.draw({
            geometryLane: 'direct',
            leases: [lease],
            camera: { lease },
            environment: { lease },
          }),
        );
        renderValue(await receipt.completed);
        frames++;
      }
      renderValue(required(renderer.requestObservation?.(['linear-hdr'])));
      const pending = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      const receipt = renderValue(
        renderer.draw({
          geometryLane: 'direct',
          leases: [lease],
          camera: { lease },
          environment: { lease },
        }),
      );
      renderValue(await receipt.completed);
      frames++;
      (await recorder.frameBoundary()).unwrap();
      const captured = (await pending).unwrap();
      await save(`${name}.rhitape`, captured.bytes);
      const observation = required(
        renderValue(
          await renderer.observe(receipt, { include: ['linear-hdr'] }),
        ).observations?.find((v) => v.domain === 'linear-hdr'),
      );
      const live = rgba(observation.bytes, observation.metadata.bytesPerRow);
      await save(`${name}.rgba16f`, observation.bytes);
      await save(`${name}-image.json`, json(observation.metadata));
      let hits = 0,
        misses = 0,
        checked = 0;
      const picks: {
        pixel: readonly [number, number];
        triangleIndex: number;
        barycentric: readonly [number, number, number];
        point: number[];
      }[] = [];
      for (let y = 4; y < SKIN_PICK_SIZE; y += 8)
        for (let px = 4; px < SKIN_PICK_SIZE; px += 8) {
          const picked = pickTriangle(
            world,
            scene.camera,
            px + 0.5,
            y + 0.5,
            SKIN_PICK_SIZE,
            SKIN_PICK_SIZE,
          );
          expect(picked.status).not.toBe('unavailable');
          // Interior hits avoid raster edge ownership and shared triangle-edge ties.
          if (picked.status === 'hit' && Math.min(...picked.hit.barycentric) < 0.03) continue;
          const visible = required(live[(y * SKIN_PICK_SIZE + px) * 4]) > 0.05;
          expect(picked.status === 'hit', `${name} pixel ${px},${y}`).toBe(visible);
          if (picked.status === 'hit') {
            expect(picked.hit.entity).toBe(scene.entity);
            if (deformation === 'morph-instances') expect(picked.hit.instanceIndex).toBe(0);
            expect(picked.hit.point[0]).toBeCloseTo(((px + 0.5) / SKIN_PICK_SIZE - 0.5) * 4, 5);
            expect(picked.hit.point[1]).toBeCloseTo((0.5 - (y + 0.5) / SKIN_PICK_SIZE) * 4, 5);
            expect(picked.hit.point[2]).toBeCloseTo(0, 5);
            hits++;
            picks.push({
              pixel: [px, y],
              triangleIndex: picked.hit.triangleIndex,
              barycentric: picked.hit.barycentric,
              point: Array.from(picked.hit.point),
            });
          } else misses++;
          checked++;
        }
      await screenshot?.(
        name,
        picks.map((p) => p.pixel),
      );
      expect(hits).toBeGreaterThan(8);
      expect(misses).toBeGreaterThan(100);
      const tape = decodeTape(captured.bytes).unwrap();
      const model = buildFrameModel(tape);
      const work = required(
        model.works.find((w) =>
          w.pipeline.shaders.some(
            (s) =>
              (s.entryPoint === 'fs_main' || s.entryPoint === 'fs_opaque') &&
              (deformation.startsWith('morph')
                ? w.vertexBuffers.length > 0
                : s.source?.includes('skinMatrix')),
          ),
        ),
      );
      const palette = deformation.startsWith('morph')
        ? undefined
        : required(work.bindings.find((b) => b.groupIndex === 2 && b.binding === 1));
      const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
      const device = (
        await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
      ).unwrap();
      const raw = required(webgpu._internal_getRawDevice(device));
      const validation: string[] = [];
      raw.addEventListener('uncapturederror', (event) => validation.push(event.error.message));
      const replay = (
        await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
      ).unwrap();
      let replayDelta = Infinity;
      const matrices: number[][] = [];
      let falsifierDelta = 0;
      try {
        const inspected = (
          await replay.inspectWork(work.workIndex, ['bindings', 'pipeline', 'pixels'])
        ).unwrap();
        const attachment = required(inspected.attachment);
        replayDelta = delta(live, rgba(attachment.bytes, SKIN_PICK_SIZE * 8));
        expect(replayDelta).toBeLessThanOrEqual(0.05);
        await save(`${name}-replay.rgba16f`, attachment.bytes);
        if (palette) {
          const resource = required(palette.resourceId);
          const bytes = (await replay.readResourceAtWork(resource, work.workIndex)).unwrap().bytes;
          const binding = required(
            tape.events
              .slice(0, work.eventIndex)
              .filter(
                (e) => e.kind === 'setBindGroup' && e.bindGroupHandleId === palette.bindGroupId,
              )
              .at(-1),
          );
          if (binding.kind !== 'setBindGroup') throw new Error('Missing skin palette binding');
          const offset = (palette.bufferOffset ?? 0) + (palette.dynamicOffset ?? 0);
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          for (const [index, joint] of [scene.root, scene.upper].entries()) {
            const jointWorld = world.get(joint, GlobalTransform).unwrap().world;
            const ibm = mat4.identity(mat4.create());
            if (index === 1) ibm[13] = -0.5;
            const expected = mat4.multiply(mat4.create(), jointWorld, ibm);
            const values = Array.from({ length: 16 }, (_, j) =>
              view.getFloat32(offset + index * 64 + j * 4, true),
            );
            expect(delta(values, Array.from(expected))).toBeLessThan(1e-6);
            matrices.push(values);
          }
          expect(model.unseededResources.some((r) => r.resourceId === resource)).toBe(false);
        }
        const vertex = required(inspected.vertexBuffers?.find((v) => v.slot === 0));
        const vbo = (
          await replay.readResourceAtWork(vertex.bufferHandleId, work.workIndex)
        ).unwrap();
        expect(vbo.bytes.byteLength).toBeGreaterThan(0);
        if (deformation !== 'skin') {
          const bytes = new DataView(vbo.bytes.buffer, vbo.bytes.byteOffset, vbo.bytes.byteLength);
          const stride =
            scene.mesh.vertices.length /
            ((scene.mesh.attributes.position as Float32Array).length / 3);
          const source = scene.mesh.attributes.position as Float32Array;
          const delta = required(scene.mesh.morphTargets?.[0]?.position);
          for (let v = 0; v < source.length / 3; v++)
            for (let axis = 0; axis < 3; axis++)
              expect(bytes.getFloat32((v * stride + axis) * 4, true)).toBeCloseTo(
                (source[v * 3 + axis] as number) + weight * (delta[v * 3 + axis] as number),
                5,
              );
        }
        await save(`${name}-vertex.bin`, vbo.bytes);
        // Depth/stencil and the swapchain are graph attachments cleared/written
        // in this frame; vertex/skin inputs must have captured initial bytes.
        for (const resourceId of [vertex.bufferHandleId]) {
          expect(model.unseededResources.some((r) => r.resourceId === resourceId)).toBe(false);
        }
      } finally {
        (await replay.dispose()).unwrap();
        raw.destroy();
      }
      // FALSIFY: deleting geometry work must break the exact live/replay pixels.
      const removed = encodeTape({
        ...tape,
        events: tape.events.map((e) => (e.kind === 'drawIndexed' ? { ...e, indexCount: 0 } : e)),
      }).unwrap();
      const controlAdapter = (await webgpu.rhi.requestAdapter()).unwrap();
      const controlDevice = (
        await controlAdapter.requestDevice(
          replayDeviceRequest(tape, controlAdapter.features, controlAdapter.limits),
        )
      ).unwrap();
      const control = (
        await openReplay(decodeTape(removed).unwrap(), {
          device: controlDevice,
          createShaderModule: webgpu.createShaderModule,
        })
      ).unwrap();
      try {
        const image = required(
          (await control.inspectWork(work.workIndex, ['pixels'])).unwrap().attachment,
        );
        falsifierDelta = delta(live, rgba(image.bytes, SKIN_PICK_SIZE * 8));
        expect(falsifierDelta).toBeGreaterThan(0.5);
      } finally {
        (await control.dispose()).unwrap();
        webgpu._internal_getRawDevice(controlDevice)?.destroy();
      }
      expect(validation).toEqual([]);
      const facts = {
        name,
        deformation,
        pose: {
          x: deformation === 'skin' ? x : 0,
          angle,
          scale,
          weight: deformation === 'skin' ? 0 : weight,
        },
        checked,
        hits,
        misses,
        replayDelta,
        falsifierDelta,
        digest: captured.digest,
        workIndex: work.workIndex,
        bindings: work.bindings,
        matrices,
        unseededResources: model.unseededResources,
        validation,
        picks,
      };
      results.push(facts);
      await save(`${name}-inspection.json`, json(facts));
    }
    const performanceSamples = [];
    for (const segments of [16, 512, 4096]) {
      const sample = skinScene(segments);
      const query = () => pickTriangle(sample.world, sample.camera, 64, 64, 128, 128);
      for (let i = 0; i < (lightweight ? 4 : 20); i++) expect(query().status).toBe('hit');
      const timings = [];
      for (let i = 0; i < querySamples; i++) {
        const start = performance.now();
        const picked = query();
        timings.push(performance.now() - start);
        expect(picked.status).toBe('hit');
      }
      timings.sort((a, b) => a - b);
      performanceSamples.push({
        triangles: segments * 2,
        vertices: (segments + 1) * 2,
        joints: 2,
        samples: querySamples,
        p50Ms: timings[Math.floor(querySamples * 0.5) - 1],
        p95Ms: timings[Math.floor(querySamples * 0.95) - 1],
      });
    }
    await save('performance.json', json(performanceSamples));
    expect(frames).toBe(poseFrames * 2);
    expect(errors).toEqual([]);
    await save('metrics.json', json({ frames, results, errors }));
  } finally {
    unsubscribe();
    lease.dispose();
  }
}

/** Opt-in ABBA diagnostic: pass timestamps are intervals, never a sum of frame latency. */
export async function measureDeformedFrames(renderer: Renderer, save: Save) {
  const scene = morphScene(true);
  const lease = renderValue(renderer.attach(scene.world));
  const rows: unknown[] = [];
  try {
    for (const weight of [0, 0.2, 0.2, 0]) {
      scene.world.set(scene.entity, MorphWeights, { weights: new Float32Array([weight]) }).unwrap();
      scene.pose(0, 0.85, 1.25);
      for (let frame = -30; frame < 60; frame++) {
        const started = performance.now();
        const receipt = renderValue(
          renderer.draw({
            geometryLane: 'direct',
            leases: [lease],
            camera: { lease },
            environment: { lease },
          }),
        );
        const cpuSubmitMs = performance.now() - started;
        renderValue(await receipt.completed);
        const observed = renderValue(await renderer.observe(receipt, { include: ['timings'] }));
        if (frame >= 0)
          rows.push({
            weight,
            frame,
            cpuSubmitMs,
            timings: observed.timings ?? null,
            receipt: { frameId: receipt.frameId },
          });
      }
    }
    await save(
      'render-performance.json',
      json({
        order: 'ABBA',
        resolution: [128, 128],
        warmupPerPhase: 30,
        samplesPerPhase: 60,
        scope:
          'Same Standard scene, backend and profile; A=neutral weights B=current Morph+Skin; CPU submission excludes queue completion/readback; GPU pass intervals retained separately, no pass-sum frame estimate.',
        rows,
        inspection: renderer.inspect(),
      }),
    );
  } finally {
    lease.dispose();
  }
}

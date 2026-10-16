import type { EntityHandle } from '@forgeax/engine-ecs';
import { createPlaneGeometry, packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { Materials, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  halfToFloat,
  openReplay,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { MorphWeights, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import { expect, it } from 'vitest';
import { error, json, save, scene } from './taa-maturity.fixture';

it
  .skipIf(process.env.TAA_MATURITY !== 'deformation')
  .each([1, 0.5].flatMap((scale) => (['morph', 'skin'] as const).map((kind) => ({ scale, kind }))))(
  'validates actual deformation velocity or explicit prior-shape rejection ($kind, $scale)',
  { timeout: 180_000, retry: 0 },
  async ({ scale, kind }) => {
    const recorder = attachRecorder(webgpu).unwrap();
    const carrier = await scene(64, 64, { rhi: recorder.backend.rhi });
    for (const e of carrier.moving) carrier.world.despawn(e).unwrap();
    const geometry = createPlaneGeometry(1, 1, 4, 4).unwrap();
    const count = (geometry.attributes.position as Float32Array).length / 3;
    const attributes =
      kind === 'skin'
        ? {
            ...geometry.attributes,
            skinIndex: new Uint16Array(count * 4),
            skinWeight: Float32Array.from({ length: count * 4 }, (_, i) => (i % 4 === 0 ? 1 : 0)),
          }
        : geometry.attributes;
    const mesh = carrier.world.allocSharedRef('MeshAsset', {
      ...geometry,
      attributes,
      vertices: packInterleavedVertexAttributes(attributes, count).unwrap().vertices,
      ...(kind === 'morph'
        ? {
            morphTargets: [
              {
                position: Float32Array.from({ length: count * 3 }, (_, i) =>
                  i % 3 === 0 ? 0.125 : 0,
                ),
              },
            ],
            morphWeights: new Float32Array([0]),
          }
        : {}),
    });
    let material = Materials.standard({ baseColor: [0.8, 0.2, 0.1, 1], roughness: 1 });
    if (kind === 'skin') {
      if (material.parent !== undefined || material.passes === undefined)
        throw Error('missing Standard passes');
      const [first, ...rest] = material.passes;
      const convert = (p: typeof first) => ({
        ...p,
        program: {
          ...p.program,
          module:
            p.program.module === 'forgeax_material::standard'
              ? 'forgeax::pbr-skin'
              : p.program.module,
        },
      });
      material = { ...material, passes: [convert(first), ...rest.map(convert)] };
    }
    const object = carrier.world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        {
          component: MeshRenderer,
          data: { materials: [carrier.world.allocSharedRef('MaterialAsset', material)] },
        },
      )
      .unwrap();
    let joint: EntityHandle | undefined;
    if (kind === 'morph')
      carrier.world
        .addComponent(object, { component: MorphWeights, data: { weights: new Float32Array([0]) } })
        .unwrap();
    else {
      joint = carrier.world.spawn({ component: Transform, data: {} }).unwrap();
      const skeleton = carrier.world.allocSharedRef('SkeletonAsset', {
        kind: 'skeleton',
        jointCount: 1,
        inverseBindMatrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
        bounds: new Float32Array([-0.5, -0.5, -0.1, 0.625, 0.5, 0.1]),
      });
      carrier.world
        .addComponent(object, {
          component: Skin,
          data: { skeleton, joints: new Uint32Array([joint]) },
        })
        .unwrap();
    }
    carrier.mode(scale === 1 ? undefined : scale);
    const samples = [];
    try {
      for (let f = 0; f < 60; f++) await carrier.draw();
      for (const changed of [false, true]) {
        if (changed) {
          if (kind === 'morph')
            carrier.world.set(object, MorphWeights, { weights: new Float32Array([1]) }).unwrap();
          else {
            if (joint === undefined) throw Error('missing joint');
            carrier.world.set(joint, Transform, { pos: [0.125, 0, 0] }).unwrap();
          }
        }
        const pending = recorder.captureFrame();
        (await recorder.frameBoundary()).unwrap();
        const { receipt } = await carrier.draw(true);
        (await recorder.frameBoundary()).unwrap();
        const captured = (await pending).unwrap();
        const label = `deformation-${kind}-${scale}-${changed ? 'changed' : 'stationary'}`;
        save(`${label}.rhitape`, captured.bytes);
        const tape = decodeTape(captured.bytes).unwrap(),
          model = buildFrameModel(tape);
        const taa = model.works.find((w) =>
          w.pipeline.shaders.some((s) => s.source?.includes('struct TaaResolveParams')),
        );
        const final = model.works
          .filter((w) => (w.attachments?.colorViewHandleIds.length ?? 0) > 0)
          .at(-1);
        if (!taa || !final) throw Error('missing deformation resolve/final work');
        const binding = taa.bindings.find((b) => b.binding === (scale === 1 ? 6 : 11));
        const events = [...tape.bootstrap.map((r) => r.create), ...tape.events];
        const view = events.find(
          (e) => e.kind === 'createTextureView' && e.resultHandleId === binding?.resourceId,
        );
        if (view?.kind !== 'createTextureView' || typeof view.sourceHandleId !== 'string')
          throw Error('missing current temporal view');
        const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
        const device = (
          await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
        ).unwrap();
        const replay = (
          await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
        ).unwrap();
        try {
          const temporal = (
            await replay.readResourceAtWork(view.sourceHandleId, taa.workIndex)
          ).unwrap();
          save(`${label}-temporal.raw`, temporal.bytes);
          if (temporal.width !== 64 || temporal.height !== 64 || temporal.format !== 'rgba16float')
            throw Error('unexpected temporal extent/format');
          const data = new DataView(
            temporal.bytes.buffer,
            temporal.bytes.byteOffset,
            temporal.bytes.byteLength,
          );
          const lanes = Array.from({ length: 4 }, (_, c) =>
            halfToFloat(data.getUint16((32 * 64 + 32) * 8 + c * 2, true)),
          );
          if (!changed) {
            expect(Math.abs(lanes[0] ?? 1)).toBeLessThan(1e-4);
            expect(lanes[3]).toBe(0);
          } else if ((lanes[3] ?? 0) >= 2) expect(Math.abs(lanes[0] ?? 1)).toBeLessThan(1e-4);
          else {
            expect(lanes[3]).toBeLessThan(1);
            expect(lanes[0]).toBeCloseTo(0.125 / 4, 4);
          }
          const image = (await replay.inspectWork(final.workIndex, ['pixels'])).unwrap().attachment;
          if (!image) throw Error('missing final image');
          const rgba = image.bytes.slice();
          if (image.format?.startsWith('bgra'))
            for (let i = 0; i < rgba.length; i += 4)
              [rgba[i], rgba[i + 2]] = [rgba[i + 2] ?? 0, rgba[i] ?? 0];
          const live = await carrier.display(receipt),
            comparison = error(live, rgba);
          expect(comparison.maximum).toBeLessThanOrEqual(0.05);
          save(`${label}-live.rgba`, live);
          samples.push({
            changed,
            lanes,
            oracleVelocityX: 0.125 / 4,
            decision: (lanes[3] ?? 0) >= 2 ? 'explicit prior-shape rejection' : 'analytic motion',
            comparison,
            provenance: temporal.provenance,
          });
        } finally {
          (await replay.dispose()).unwrap();
        }
      }
      json(`deformation-${kind}-${scale}.json`, samples);
    } finally {
      await carrier.dispose();
      (await recorder.dispose()).unwrap();
    }
  },
);

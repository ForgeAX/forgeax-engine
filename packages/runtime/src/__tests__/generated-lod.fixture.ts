import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  Camera,
  DirectionalLight,
  type FrameReceipt,
  MeshFilter,
  MeshRenderer,
  type Renderer,
} from '@forgeax/engine-render';
import {
  buildFrameModel,
  decodeTape,
  halfToFloat,
  inspectBufferRecords,
  openReplay,
  type RecorderAttachment,
  replayDeviceRequest,
  tapeDigest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import type { MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { expect } from 'vitest';
import { renderValue } from './standard-gbuffer-replay.fixture';

const hdr = (bytes: Uint8Array, rowBytes: number) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = new Float32Array(128 * 128 * 4);
  for (let y = 0; y < 128; y++)
    for (let x = 0; x < 128; x++)
      for (let c = 0; c < 4; c++)
        values[(y * 128 + x) * 4 + c] = halfToFloat(
          view.getUint16(y * rowBytes + x * 8 + c * 2, true),
        );
  return values;
};
const meanError = (a: Float32Array, b: Float32Array) => {
  let error = 0,
    pixels = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (
      Math.max(
        required(a[i]),
        required(a[i + 1]),
        required(a[i + 2]),
        required(b[i]),
        required(b[i + 1]),
        required(b[i + 2]),
      ) < 0.01
    )
      continue;
    pixels++;
    for (let c = 0; c < 3; c++) error += Math.abs(required(a[i + c]) - required(b[i + c]));
  }
  expect(pixels).toBeGreaterThan(100);
  return error / (pixels * 3);
};
/** Real source producer -> mesh binary -> HTTP -> Catalog -> Renderer -> RHI replay. */
export async function verifyGeneratedLods(
  renderer: Renderer,
  assets: AssetRegistry,
  recorder: RecorderAttachment,
  publication: {
    url: string;
    guids: string[];
    materialGuid: string;
    triangleCounts: number[];
  },
  save: (name: string, bytes: Uint8Array) => void | Promise<void>,
) {
  assets.configurePackIndex(publication.url);
  const meshes: MeshAsset[] = [];
  for (const text of publication.guids) {
    const guid = AssetGuid.parse(text);
    if (!guid.ok) throw guid.error;
    meshes.push(renderValue(await assets.loadByGuid<MeshAsset>(guid.value)));
  }
  expect(required(meshes[0]).lods).toHaveLength(2);
  expect(meshes.map((mesh) => required(mesh.indices).length / 3)).toEqual(
    publication.triangleCounts,
  );
  expect(required(meshes[1]).vertices.byteLength).toBeLessThan(
    required(meshes[0]).vertices.byteLength,
  );
  const world = new World();
  const materialId = renderValue(AssetGuid.parse(publication.materialGuid));
  const material = world.allocSharedRef(
    'MaterialAsset',
    renderValue(await assets.loadByGuid<MaterialAsset>(materialId)),
  );
  const object = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      {
        component: MeshFilter,
        data: { assetHandle: world.allocSharedRef('MeshAsset', required(meshes[0])) },
      },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 4] } },
      {
        component: Camera,
        data: {
          fov: Math.PI / 4,
          aspect: 1,
          near: 0.1,
          far: 100,
          antialias: 0,
          bloom: 0,
          tonemap: 7,
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: { direction: [-0.5, -0.8, -1], intensity: 2, castShadow: false },
    })
    .unwrap();
  const lease = renderValue(renderer.attach(world));
  const renderErrors: unknown[] = [];
  const stop = renderer.subscribe((event) => {
    if (event.kind === 'error') renderErrors.push(event.error);
  });
  const pictures: Float32Array[] = [];
  const evidence: unknown[] = [];
  try {
    for (let level = 0; level < 4; level++) {
      const mesh =
        level === 3 ? required(meshes[0]) : { ...required(meshes[level]), lods: undefined };
      world
        .set(object, MeshFilter, { assetHandle: world.allocSharedRef('MeshAsset', mesh) })
        .unwrap();
      // Outside the last crossfade band, while keeping >100 visible pixels.
      if (level === 3) world.set(camera, Transform, { pos: [0, 0, 22] }).unwrap();
      let receipt: FrameReceipt | undefined;
      for (let frame = 0; frame < 60; frame++) {
        world.update(1 / 60).unwrap();
        propagateTransforms(world).unwrap();
        let pending: ReturnType<RecorderAttachment['captureFrame']> | undefined;
        if (frame === 59) {
          renderValue(required(renderer.requestObservation)(['linear-hdr']));
          pending = recorder.captureFrame();
          renderValue(await recorder.frameBoundary());
        }
        const drawn = renderer.draw({
          ...(level === 3 ? {} : { geometryLane: 'direct' as const }),
          leases: [lease],
          camera: { lease },
          environment: { lease },
        });
        if (!drawn.ok) {
          await save(
            'failure.json',
            new TextEncoder().encode(
              JSON.stringify(
                {
                  level,
                  frame,
                  error: drawn.error,
                  events: renderErrors,
                  inspection: renderer.inspect(),
                },
                null,
                2,
              ),
            ),
          );
          throw drawn.error;
        }
        receipt = drawn.value;
        renderValue(await receipt.completed);
        if (!pending) continue;
        renderValue(await recorder.frameBoundary());
        const observed = renderValue(
          await renderer.observe(receipt, { include: ['linear-hdr', 'draws'] }),
        );
        const image = required(
          required(observed.observations).find((item) => item.domain === 'linear-hdr'),
        );
        const pixels = hdr(image.bytes, image.metadata.bytesPerRow);
        expect(pixels.every(Number.isFinite)).toBe(true);
        expect(pixels.some((value, i) => i % 4 !== 3 && value > 0.05)).toBe(true);
        pictures.push(pixels);
        await save(`lod${level}.rgba16f`, image.bytes);
        const encoded = renderValue(await pending);
        await save(`lod${level}.rhitape`, encoded.bytes);
        const tape = renderValue(decodeTape(encoded.bytes));
        const model = buildFrameModel(tape);
        const geometry = model.works.filter((work) => work.indexBuffer !== null);
        expect(geometry.length).toBeGreaterThan(0);
        if (level < 3)
          expect(
            geometry.some((work) =>
              JSON.stringify(work.drawCall).includes(
                `"indexCount":${required(mesh.indices).length}`,
              ),
            ),
          ).toBe(true);
        const colorWork = geometry
          .filter((work) =>
            work.pipeline.shaders.some((shader) =>
              ['fs_main', 'fs_opaque', 'fs_scene_index'].includes(shader.entryPoint ?? ''),
            ),
          )
          .at(-1);
        if (!colorWork) throw new Error('missing production color draw');
        const adapter = renderValue(await webgpu.rhi.requestAdapter());
        const device = renderValue(
          await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits)),
        );
        const raw = required(webgpu._internal_getRawDevice(device));
        let replayError: number;
        try {
          raw.pushErrorScope('validation');
          const replay = renderValue(
            await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule }),
          );
          try {
            const inspection = renderValue(
              await replay.inspectWork(colorWork.workIndex, ['pipeline', 'bindings', 'pixels']),
            );
            if (!inspection.attachment) throw new Error('missing replay image');
            expect(inspection.bindings?.length).toBeGreaterThan(0);
            expect(inspection.pipeline?.shaders).toEqual(colorWork.pipeline.shaders);
            expect(inspection.indexBuffer).toEqual(colorWork.indexBuffer);
            const draw = colorWork.drawCall;
            if (
              draw !== null &&
              typeof draw === 'object' &&
              'kind' in draw &&
              draw.kind === 'drawIndexedIndirect'
            ) {
              if (
                !('indirectBufferHandleId' in draw) ||
                typeof draw.indirectBufferHandleId !== 'string' ||
                !('indirectOffset' in draw) ||
                typeof draw.indirectOffset !== 'number'
              )
                throw new Error('malformed indirect draw');
              const indirect = renderValue(
                await inspectBufferRecords(
                  replay,
                  draw.indirectBufferHandleId,
                  colorWork.workIndex,
                  {
                    stride: 20,
                    fields: [
                      { name: 'indexCount', offset: 0, type: 'u32', components: 1 },
                      { name: 'instanceCount', offset: 4, type: 'u32', components: 1 },
                    ],
                  },
                  { first: 0, count: draw.indirectOffset / 20 + 1 },
                ),
              );
              const active = indirect.records.filter(
                (record) => record.fields.instanceCount?.[0] === 1,
              );
              expect(active.length).toBeGreaterThan(0);
              expect(
                active.every(
                  (record) => record.fields.indexCount?.[0] === required(meshes[2]?.indices).length,
                ),
              ).toBe(true);
              await save('lod3-indirect.json', new TextEncoder().encode(JSON.stringify(indirect)));
            }
            await save(
              `lod${level}-work.json`,
              new TextEncoder().encode(
                JSON.stringify(
                  {
                    workIndex: inspection.workIndex,
                    indexBuffer: inspection.indexBuffer,
                    vertexBuffers: inspection.vertexBuffers,
                    bindings: inspection.bindings,
                    resourceIds: inspection.resourceIds,
                    pipeline: {
                      ...inspection.pipeline,
                      shaders: inspection.pipeline?.shaders.map(({ stage, entryPoint }) => ({
                        stage,
                        entryPoint,
                      })),
                    },
                  },
                  null,
                  2,
                ),
              ),
            );
            replayError = meanError(pixels, hdr(inspection.attachment.bytes, 128 * 8));
            expect(replayError).toBeLessThanOrEqual(0.005);
            expect(await raw.popErrorScope()).toBeNull();
          } finally {
            renderValue(await replay.dispose());
          }
        } finally {
          raw.destroy();
        }
        evidence.push({
          level,
          completedFrames: 60,
          tapeDigest: tapeDigest(encoded.bytes),
          geometry: geometry.map((work) => ({
            workIndex: work.workIndex,
            drawCall: work.drawCall,
            indexBuffer: work.indexBuffer,
          })),
          replayError,
          unseededResources: model.unseededResources,
        });
      }
      if (level === 3) {
        renderValue(await renderer.observe(required(receipt), { include: [] }));
        expect(
          required(renderer.inspect().lodOcclusion).lodHistogram.some(
            (row) => row.level === 2 && row.count > 0,
          ),
        ).toBe(true);
      }
    }
    const foregroundMeanErrors = [
      meanError(required(pictures[0]), required(pictures[1])),
      meanError(required(pictures[0]), required(pictures[2])),
    ];
    expect(foregroundMeanErrors.every((error) => error <= 0.05)).toBe(true);
    await save(
      'evidence.json',
      new TextEncoder().encode(
        JSON.stringify(
          {
            publication,
            foregroundMeanErrors,
            captures: evidence,
            inspection: renderer.inspect(),
          },
          null,
          2,
        ),
      ),
    );
  } finally {
    stop();
  }
  expect(renderErrors).toEqual([]);
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing fixture value');
  return value;
}

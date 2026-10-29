import { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry, packInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import { halfFloat } from '@forgeax/engine-math';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  type Renderer,
  ShadowParticipation,
} from '@forgeax/engine-render';
import {
  buildFrameModel,
  decodeTape,
  encodeTape,
  openReplay,
  type ReplaySession,
  replayDeviceRequest,
  tapeDigest,
  type V7RhiCallEvent,
  type V7Tape,
  type WorkEntry,
  workOutputs,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { STANDARD_PIPELINE_PARAM_SCHEMA } from '@forgeax/engine-shader';
import { Skin } from '@forgeax/engine-skinning';
import { derive, type MeshAsset, type TextureAsset } from '@forgeax/engine-types';
import { expect } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { compactTape } from './compact-tape.fixture';
import { testAssets } from './helpers/runtime-assets';
import { observeReplaySubmissions } from './native-replay-work.fixture';
import { inspectReplayWorks } from './replay-inspections.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

type Save = (name: string, bytes: Uint8Array) => void | Promise<void>;
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Required displacement fixture value is missing');
  return value;
}

async function stableDisplacementReads(
  replay: ReplaySession,
  work: WorkEntry,
  shadow: { texture: string; layer: number; mip: number; finalView: string; cached: boolean },
) {
  const output = required(workOutputs(work).find((row) => row.role === 'color'));
  const reads = (
    await replay.readAtWorks([
      { ...output.request, workIndex: work.workIndex },
      {
        resourceId: shadow.texture,
        workIndex: work.workIndex,
        subresource: { arrayLayer: shadow.layer, mipLevel: shadow.mip },
      },
      ...(shadow.cached ? [{ resourceId: shadow.finalView, workIndex: work.workIndex }] : []),
    ])
  )
    .unwrap()
    .map((read) => read.unwrap());
  for (const read of reads) expect(read.provenance.selectedWorkIndex).toBe(work.workIndex);
  return reads;
}

const size = 64;
const difference = (a: number[], b: number[]) =>
  a.reduce((max, v, i) => Math.max(max, Math.abs(v - (b[i] ?? NaN))), 0);
function hdr(bytes: Uint8Array, pitch: number): number[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: size * size * 3 }, (_, i) =>
    halfFloat.f16ToF32(
      v.getUint16(
        Math.floor(i / (size * 3)) * pitch + (Math.floor(i / 3) % size) * 8 + (i % 3) * 2,
        true,
      ),
    ),
  );
}

function sceneColorWork(model: ReturnType<typeof buildFrameModel>, renderPath: string) {
  const works = model.works.filter((work) =>
    work.pipeline.shaders.some((shader) =>
      renderPath === 'forward'
        ? (shader.entryPoint === 'fs_main' || shader.entryPoint === 'fs_opaque') &&
          shader.source?.includes('displaceVertex')
        : shader.entryPoint?.startsWith('fs_standard_deferred'),
    ),
  );
  return required(renderPath === 'forward' ? works.at(-1) : works[0]);
}

function textureViews(tape: V7Tape) {
  // decodeTape validates bootstrap creation records with the same event schema.
  const creates = tape.bootstrap.map(({ create }) => create as unknown as V7RhiCallEvent);
  return [...creates, ...tape.events].filter((event) => event.kind === 'createTextureView');
}

const originLayer = (origin: GPUOrigin3D | undefined) =>
  (Array.isArray(origin) ? origin[2] : origin?.z) ?? 0;

const heights = new Uint8Array(16 * 16 * 4);
for (let y = 0; y < 16; y++)
  for (let x = 0; x < 16; x++) {
    const h = Math.round(255 * Math.max(0, 1 - Math.hypot((x - 5) / 5, (y - 8) / 7)));
    heights.set([h, 255 - h, x * 16, 255], (y * 16 + x) * 4);
  }
const heightAt = (u: number, v: number) =>
  (heights[
    (Math.min(15, Math.max(0, Math.floor(v * 16))) * 16 +
      Math.min(15, Math.max(0, Math.floor(u * 16)))) *
      4
  ] ?? 0) / 255;

// Independent Three r184 formula applied to real vertices. Expand triangles so
// the reference normals describe the displaced geometry without shader helpers.
function oracleMesh(mesh: MeshAsset, scale: number, bias: number): MeshAsset {
  const source = mesh.attributes;
  const pos = source.position as Float32Array;
  const uv = source.uv as Float32Array;
  const indices = required(mesh.indices);
  const position = new Float32Array(indices.length * 3);
  const normal = new Float32Array(indices.length * 3);
  const texcoord = new Float32Array(indices.length * 2);
  const tangent = new Float32Array(indices.length * 4);
  for (let i = 0; i < indices.length; i++) {
    const index = Number(indices[i]);
    const u = required(uv[index * 2]),
      v = required(uv[index * 2 + 1]);
    position.set(
      [
        required(pos[index * 3]),
        required(pos[index * 3 + 1]),
        required(pos[index * 3 + 2]) + heightAt(u, v) * scale + bias,
      ],
      i * 3,
    );
    texcoord.set([u, v], i * 2);
    tangent.set([1, 0, 0, 1], i * 4);
  }
  for (let i = 0; i < indices.length; i += 3) {
    const a = Array.from(position.subarray(i * 3, i * 3 + 3));
    const b = Array.from(position.subarray(i * 3 + 3, i * 3 + 6), (v, j) => v - required(a[j]));
    const c = Array.from(position.subarray(i * 3 + 6, i * 3 + 9), (v, j) => v - required(a[j]));
    const n = [
      required(b[1]) * required(c[2]) - required(b[2]) * required(c[1]),
      required(b[2]) * required(c[0]) - required(b[0]) * required(c[2]),
      required(b[0]) * required(c[1]) - required(b[1]) * required(c[0]),
    ];
    const len = Math.hypot(...n);
    for (let j = 0; j < 3; j++)
      normal.set(
        n.map((v) => v / len),
        (i + j) * 3,
      );
  }
  const attributes = { position, normal, uv: texcoord, tangent };
  return {
    ...mesh,
    attributes,
    vertices: packInterleavedVertexAttributes(attributes, indices.length).unwrap().vertices,
    indices: Uint32Array.from({ length: indices.length }, (_, i) => i),
    aabb: new Float32Array([
      -1,
      -1,
      Math.min(bias, scale + bias),
      1,
      1,
      Math.max(bias, scale + bias),
    ]),
  };
}

export async function verifyStandardDisplacement(
  renderer: Renderer,
  recorder: import('@forgeax/engine-rhi-debug').RecorderAttachment,
  save: Save,
  frameCount = testQuality.staticFrames,
) {
  const world = new World();
  const errors: unknown[] = [];
  const off = renderer.subscribe((e) => {
    if (e.kind === 'error') errors.push(e.error);
  });
  const texture = testAssets(world)
    .create({
      kind: 'texture',
      shape: { viewDimension: '2d', extent: { width: 16, height: 16 } },
      format: 'rgba8unorm',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      data: heights,
    } satisfies TextureAsset)
    .unwrap();
  const sampler = testAssets(world)
    .create({
      kind: 'sampler',
      minFilter: 'nearest',
      magFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    })
    .unwrap();
  const dense = createPlaneGeometry(2, 2, 16, 16).unwrap();
  const coarse = createPlaneGeometry(2, 2).unwrap();
  const mesh = testAssets(world).create(dense).unwrap();
  const object = world
    .spawn(
      { component: Transform, data: { quat: [0, -Math.sin(0.5), 0, Math.cos(0.5)] } },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [] } },
    )
    .unwrap();
  const receiverMesh = testAssets(world).create(createPlaneGeometry(5, 5).unwrap()).unwrap();
  const receiverMaterial = testAssets(world)
    .create(Materials.standard({ baseColor: [0.25, 0.25, 0.25, 1], roughness: 1 }))
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -0.8] } },
      { component: MeshFilter, data: { assetHandle: receiverMesh } },
      { component: MeshRenderer, data: { materials: [receiverMaterial] } },
      { component: ShadowParticipation, data: { cast: false, receive: true } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 4] } },
      {
        component: Camera,
        data: {
          projection: 1,
          left: -1.8,
          right: 1.8,
          top: 1.8,
          bottom: -1.8,
          near: 0.1,
          far: 10,
          antialias: 0,
          bloom: 0,
          tonemap: 1,
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [-0.6, -0.3, -1],
        color: [1, 1, 1],
        intensity: 2,
        castShadow: true,
        mapSize: testQuality.shadowMapSize,
        shadowDistance: 8,
        cascadeCount: 2,
      },
    })
    .unwrap();
  const lease = renderValue(renderer.attach(world));
  const profile = renderer.inspect().profile;
  const results = new Map<string, number[]>();
  const report: unknown[] = [];
  const cases = [
    { name: 'flat', scale: 0, bias: 0, mapped: false },
    { name: 'zero', scale: 0, bias: 0, mapped: true },
    { name: 'dense', scale: 0.8, bias: 0, mapped: true },
    { name: 'dense-gpu', scale: 0.8, bias: 0, mapped: true, gpu: true },
    { name: 'skin', scale: 0.8, bias: 0, mapped: true, skin: true },
    { name: 'oracle', scale: 0.8, bias: 0, mapped: false, oracle: true },
    { name: 'coarse-flat', scale: 0, bias: 0, mapped: false, coarse: true },
    { name: 'coarse', scale: 0.8, bias: 0, mapped: true, coarse: true },
    { name: 'negative', scale: -0.4, bias: 0.2, mapped: true },
    { name: 'bias', scale: 0, bias: 0.3, mapped: true },
    { name: 'uv1', scale: 0.8, bias: 0, mapped: true, uv1: true },
  ];
  try {
    for (const renderPath of ['forward', 'deferred'] as const) {
      renderValue(renderer.setProfile({ ...profile, renderPath, ssao: false }));
      for (const entry of cases) {
        let geometry = entry.oracle
          ? oracleMesh(dense, entry.scale, entry.bias)
          : entry.coarse
            ? coarse
            : dense;
        if (entry.uv1) {
          const attributes = {
            ...dense.attributes,
            uv1: Float32Array.from(dense.attributes.uv as Float32Array, (v, i) =>
              i % 2 === 0 ? 1 - v : v,
            ),
          };
          geometry = {
            ...dense,
            attributes,
            vertices: packInterleavedVertexAttributes(
              attributes,
              (dense.attributes.uv as Float32Array).length / 2,
            ).unwrap().vertices,
          };
        }
        if (entry.skin) {
          const count = (dense.attributes.position as Float32Array).length / 3;
          const attributes = {
            ...geometry.attributes,
            skinIndex: new Uint16Array(count * 4),
            skinWeight: Float32Array.from({ length: count * 4 }, (_, i) => (i % 4 === 0 ? 1 : 0)),
          };
          geometry = {
            ...geometry,
            attributes,
            vertices: packInterleavedVertexAttributes(attributes, count).unwrap().vertices,
          };
          const joint = world
            .spawn({ component: Transform, data: { quat: [0, -Math.sin(0.5), 0, Math.cos(0.5)] } })
            .unwrap();
          const skeleton = testAssets(world)
            .create({
              kind: 'skeleton',
              jointCount: 1,
              inverseBindMatrices: new Float32Array([
                1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
              ]),
              bounds: new Float32Array([-1, -1, -1, 1, 1, 1]),
            })
            .unwrap();
          world
            .addComponent(object, {
              component: Skin,
              data: { skeleton, joints: new Uint32Array([joint]) },
            })
            .unwrap();
        }
        world
          .set(object, MeshFilter, { assetHandle: testAssets(world).create(geometry).unwrap() })
          .unwrap();
        let material = Materials.standard({
          baseColor: [0.65, 0.35, 0.15, 1],
          roughness: 1,
          ...(entry.mapped
            ? {
                displacementTexture: {
                  texture,
                  sampler,
                  ...(entry.uv1 ? { coordinates: { set: 1 } } : {}),
                },
                displacementScale: entry.scale,
                displacementBias: entry.bias,
              }
            : {}),
        });
        if (entry.skin) {
          if (material.parent !== undefined)
            throw new Error('Standard fixture requires a root material');
          const [first, ...rest] = required(material.passes);
          const skinnedPass = (pass: typeof first) => ({
            ...pass,
            program: {
              ...pass.program,
              module:
                pass.program.module === 'forgeax_material::standard'
                  ? 'forgeax::pbr-skin'
                  : pass.program.module,
            },
          });
          material = { ...material, passes: [skinnedPass(first), ...rest.map(skinnedPass)] };
        }
        world
          .set(object, MeshRenderer, {
            materials: [testAssets(world).create(material).unwrap()],
          })
          .unwrap();
        let completedFrames = 0;
        const draw = async (observe = false) => {
          world.update(1 / 60).unwrap();
          propagateTransforms(world).unwrap();
          const r = await drawReadyFrame(
            renderer,
            {
              ...(entry.gpu ? {} : { geometryLane: 'direct' as const }),
              leases: [lease],
              camera: { lease },
              environment: { lease },
            },
            observe ? ['linear-hdr'] : undefined,
          );
          completedFrames++;
          return r;
        };
        const captureCase = ['flat', 'dense', 'dense-gpu', 'oracle'].includes(entry.name);
        let writerCapture: Awaited<ReturnType<typeof recorder.captureFrame>> | undefined;
        // The new case invalidates shadow content on its first frame. Capture
        // that writer separately from the final frame, which may reuse depth.
        if (captureCase) {
          expect(frameCount).toBeGreaterThanOrEqual(2);
          const capture = recorder.captureFrame();
          (await recorder.frameBoundary()).unwrap();
          await draw();
          (await recorder.frameBoundary()).unwrap();
          writerCapture = await capture;
          await save(
            `${renderPath}-${entry.name}-writer.rhitape`,
            compactTape(writerCapture.unwrap()).bytes,
          );
        }
        while (completedFrames < frameCount - 1) await draw();
        const capture = captureCase ? recorder.captureFrame() : undefined;
        if (capture) (await recorder.frameBoundary()).unwrap();
        const receipt = await draw(true);
        expect(completedFrames).toBe(frameCount);
        if (capture) (await recorder.frameBoundary()).unwrap();
        const live = renderValue(
          await renderer.observe(receipt, { include: ['linear-hdr'] }),
        ).observations?.find((o) => o.domain === 'linear-hdr');
        if (!live) throw new Error('missing displaced HDR observation');
        const pixels = hdr(live.bytes, live.metadata.bytesPerRow);
        results.set(`${renderPath}/${entry.name}`, pixels);
        await save(`${renderPath}-${entry.name}.rgba16f`, live.bytes);
        const facts: Record<string, unknown> = {
          renderPath,
          case: entry.name,
          completedFrames,
        };
        if (capture) {
          const encoded = (await capture).unwrap();
          await save(`${renderPath}-${entry.name}.rhitape`, compactTape(encoded).bytes);
          const writer = required(writerCapture).unwrap();
          const tape = decodeTape(writer.bytes).unwrap(),
            model = buildFrameModel(tape);
          const geometryWorks = model.works.filter((w) =>
            w.pipeline.shaders.some(
              (s) =>
                ['vs_main', 'vs_temporal', 'vs_scene_index'].includes(s.entryPoint ?? '') &&
                s.source?.includes('displaceVertex'),
            ),
          );
          expect(geometryWorks.length).toBeGreaterThan(1);
          if (entry.gpu)
            expect(
              geometryWorks.some((w) =>
                w.pipeline.shaders.some((s) => s.entryPoint === 'vs_scene_index'),
              ),
            ).toBe(true);
          const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
          const device = (
            await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
          ).unwrap();
          const raw = required(webgpu._internal_getRawDevice(device));
          raw.pushErrorScope('validation');
          const replay = (
            await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
          ).unwrap();
          try {
            const work = sceneColorWork(model, renderPath);
            const shadow = required(
              geometryWorks
                .filter((w) => w.pipeline.shaders.some((s) => s.entryPoint === 'fs_shadow'))
                .at(-1),
            );
            const shadowId = shadow.attachments?.depthStencilViewHandleId;
            if (!shadowId) throw new Error('missing displaced shadow depth');
            const inspected = await inspectReplayWorks(replay, [work, shadow]);
            const colorInspection = required(inspected[0]);
            if (!colorInspection.attachment) throw new Error('missing replay attachment');
            const replayPixels = hdr(colorInspection.attachment.bytes, size * 8);
            const replayDelta = difference(pixels, replayPixels);
            expect(replayDelta).toBeLessThanOrEqual(0.005);
            const shadowRead = required(required(inspected[1]).attachment);
            expect(shadowRead.format).toBe('depth32float');
            const shadowFloats = Array.from(
              new Float32Array(
                shadowRead.bytes.buffer,
                shadowRead.bytes.byteOffset,
                shadowRead.bytes.byteLength / 4,
              ),
            );
            results.set(`${renderPath}/${entry.name}/shadow`, shadowFloats);
            await save(`${renderPath}-${entry.name}-writer-shadow.depth32float`, shadowRead.bytes);
            facts.shadowWorkIndex = shadow.workIndex;
            if (entry.mapped) {
              const schema = derive(STANDARD_PIPELINE_PARAM_SCHEMA);
              const heightField = required(
                schema.resourceBindings.find((r) => r.name === 'displacementTexture'),
              );
              const heightBinding = required(
                shadow.bindings.find(
                  (b) => b.groupIndex === 1 && b.binding === heightField.binding,
                ),
              );
              if (!heightBinding.resourceId) throw new Error('missing shadow height texture');
              const heightRead = (await replay.readResource(heightBinding.resourceId)).unwrap();
              expect(Array.from(heightRead.bytes)).toEqual(Array.from(heights));
              const color = required(
                geometryWorks.find(
                  (w) =>
                    w.pipeline.shaders.some(
                      (shader) =>
                        shader.entryPoint === 'fs_main' ||
                        shader.entryPoint === 'fs_opaque' ||
                        shader.entryPoint === 'fs_gbuffer',
                    ) &&
                    w.bindings.some(
                      (binding) =>
                        binding.groupIndex === 1 &&
                        binding.binding === heightField.binding &&
                        binding.resourceId === heightBinding.resourceId,
                    ),
                ),
              );
              facts.heightColorWorkIndex = color.workIndex;
              facts.heightResourceId = heightBinding.resourceId;
              if (!entry.gpu) {
                const uniform = required(
                  color.bindings.find((b) => b.groupIndex === 1 && b.binding === 0),
                );
                if (!uniform.resourceId) throw new Error('missing displacement material UBO');
                const buffer = (
                  await replay.readResourceAtWork(uniform.resourceId, color.workIndex)
                ).unwrap();
                const bind = required(
                  tape.events
                    .slice(0, color.eventIndex)
                    .filter(
                      (event) =>
                        event.kind === 'setBindGroup' &&
                        event.bindGroupHandleId === uniform.bindGroupId,
                    )
                    .at(-1),
                );
                if (bind.kind !== 'setBindGroup')
                  throw new Error('missing material binding command');
                const materialOffset =
                  (uniform.bufferOffset ?? 0) + (bind.dynamicOffsets?.[0] ?? 0);
                facts.materialOffset = materialOffset;
                const view = new DataView(
                  buffer.bytes.buffer,
                  buffer.bytes.byteOffset,
                  buffer.bytes.byteLength,
                );
                for (const [name, expected] of [
                  ['displacementScale', entry.scale],
                  ['displacementBias', entry.bias],
                ] as const) {
                  const field = required(schema.numericMembers.find((p) => p.name === name));
                  expect(view.getFloat32(materialOffset + field.offset, true)).toBeCloseTo(
                    expected,
                    6,
                  );
                }
              }
            }
            const stableTape = decodeTape(encoded.bytes).unwrap();
            const stableModel = buildFrameModel(stableTape);
            const shadowView = required(
              textureViews(tape).find((view) => view.resultHandleId === shadowId),
            );
            const shadowTextureId = shadowView.sourceHandleId;
            const shadowLayer = shadowView.desc.baseArrayLayer ?? 0;
            const shadowSeed = required(
              stableTape.bootstrap.find((resource) => resource.handleId === shadowTextureId),
            );
            expect(shadowSeed.initialData.length).toBeGreaterThan(0);
            expect(
              stableModel.unseededResources.some(
                (resource) => resource.resourceId === shadowTextureId,
              ),
            ).toBe(false);
            const stableShadowWorks = stableModel.works.filter((work) =>
              work.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_shadow'),
            );
            let finalShadowId = shadowId;
            // The first GPU population starts static. On the later deferred
            // visit, preceding material/skin changes keep this caster dynamic
            // for longer than the fixture's four frames, so both paths are tested.
            const cachedShadow = entry.gpu && renderPath === 'forward';
            if (cachedShadow) {
              expect(stableShadowWorks).toHaveLength(0);
              // GPU casters write a retained static layer. Stable frames copy
              // that same seeded layer to the final shadow atlas before lighting.
              const copy = required(
                stableTape.events.find(
                  (event) =>
                    event.kind === 'copyTextureToTexture' &&
                    event.source.textureHandleId === shadowTextureId &&
                    originLayer(event.source.origin) === shadowLayer,
                ),
              );
              if (copy.kind !== 'copyTextureToTexture') throw new Error('missing shadow copy');
              const finalView = required(
                textureViews(stableTape).find(
                  (view) =>
                    view.sourceHandleId === copy.destination.textureHandleId &&
                    (view.desc.baseArrayLayer ?? 0) === originLayer(copy.destination.origin) &&
                    view.desc.arrayLayerCount === 1,
                ),
              );
              finalShadowId = finalView.resultHandleId;
              const stableShadowPass = required(
                stableTape.events.find(
                  (event) =>
                    event.kind === 'beginRenderPass' &&
                    event.depthStencilViewHandleId === finalShadowId,
                ),
              );
              if (stableShadowPass.kind !== 'beginRenderPass')
                throw new Error('missing retained shadow pass');
              expect(stableShadowPass.desc.depthStencilAttachment?.depthLoadOp).toBe('load');
            } else {
              // Compiled graphs may create a new view of the retained texture.
              // Compare the physical subresource, not the old view handle.
              const stableViews = textureViews(stableTape);
              const stableShadow = required(
                stableShadowWorks.find((work) =>
                  stableViews.some(
                    (view) =>
                      view.resultHandleId === work.attachments?.depthStencilViewHandleId &&
                      view.sourceHandleId === shadowTextureId &&
                      (view.desc.baseArrayLayer ?? 0) === shadowLayer &&
                      (view.desc.baseMipLevel ?? 0) === (shadowView.desc.baseMipLevel ?? 0) &&
                      view.desc.arrayLayerCount === shadowView.desc.arrayLayerCount,
                  ),
                ),
              );
              finalShadowId = required(stableShadow.attachments?.depthStencilViewHandleId);
            }
            const replayWork = observeReplaySubmissions(device);
            const stableReplay = (
              await openReplay(stableTape, {
                device,
                createShaderModule: webgpu.createShaderModule,
              })
            ).unwrap();
            try {
              const stableWork = sceneColorWork(stableModel, renderPath);
              const reads = await stableDisplacementReads(stableReplay, stableWork, {
                texture: shadowTextureId,
                layer: shadowLayer,
                mip: shadowView.desc.baseMipLevel ?? 0,
                finalView: finalShadowId,
                cached: cachedShadow === true,
              });
              replayWork.assertMaximum(13);
              const stableReplayDelta = difference(pixels, hdr(required(reads[0]).bytes, size * 8));
              expect(stableReplayDelta).toBeLessThanOrEqual(0.005);
              const retainedDepth = required(reads[1]);
              expect(retainedDepth.format).toBe('depth32float');
              const retainedFloats = Array.from(
                new Float32Array(
                  retainedDepth.bytes.buffer,
                  retainedDepth.bytes.byteOffset,
                  retainedDepth.bytes.byteLength / 4,
                ),
              );
              const retainedShadowDelta = difference(shadowFloats, retainedFloats);
              expect(retainedShadowDelta).toBe(0);
              if (cachedShadow) {
                const finalDepth = required(reads[2]);
                expect(finalDepth.bytes).toEqual(retainedDepth.bytes);
              }
              results.set(`${renderPath}/${entry.name}/shadow`, retainedFloats);
              await save(`${renderPath}-${entry.name}-shadow.depth32float`, retainedDepth.bytes);
              Object.assign(facts, {
                stableDigest: tapeDigest(encoded.bytes),
                stableWorkIndex: stableWork.workIndex,
                stableReplayDelta,
                stableShadowWorkCount: stableShadowWorks.length,
                cachedShadow: cachedShadow === true,
                shadowTextureId,
                shadowLayer,
                finalShadowId,
                shadowSeeds: shadowSeed.initialData,
                retainedShadowDelta,
              });
            } finally {
              (await stableReplay.dispose()).unwrap();
              replayWork.restore();
            }
            const validation = await raw.popErrorScope();
            expect(validation?.message).toBeUndefined();
            await save(
              `${renderPath}-${entry.name}-replay.rgba16f`,
              colorInspection.attachment.bytes,
            );
            Object.assign(facts, {
              digest: tapeDigest(writer.bytes),
              replayDelta,
              workIndex: work.workIndex,
              geometryWorks: geometryWorks.map((w) => ({
                workIndex: w.workIndex,
                eventIndex: w.eventIndex,
                shaders: w.pipeline.shaders.map((s) => s.entryPoint),
                bindings: w.bindings,
              })),
              unseededResources: model.unseededResources,
            });
          } finally {
            (await replay.dispose()).unwrap();
            raw.destroy();
          }
          if (entry.name === 'dense') {
            const removed = encodeTape(
              {
                ...tape,
                events: tape.events.map((event) =>
                  event.kind === 'drawIndexed' ? { ...event, indexCount: 0 } : event,
                ),
              },
              { compression: 'gzip' },
            ).unwrap();
            await save(`${renderPath}-missing-geometry.rhitape`, removed);
            const changed = decodeTape(removed).unwrap();
            const changedAdapter = (await webgpu.rhi.requestAdapter()).unwrap();
            const changedDevice = (
              await changedAdapter.requestDevice(
                replayDeviceRequest(changed, changedAdapter.features, changedAdapter.limits),
              )
            ).unwrap();
            const changedRaw = required(webgpu._internal_getRawDevice(changedDevice));
            const changedReplay = (
              await openReplay(changed, {
                device: changedDevice,
                createShaderModule: webgpu.createShaderModule,
              })
            ).unwrap();
            try {
              const workIndex = Number(facts.workIndex);
              const read = (await changedReplay.inspectWork(workIndex, ['pixels'])).unwrap();
              const altered = hdr(required(read.attachment).bytes, size * 8);
              const falsifierDelta = difference(pixels, altered);
              expect(falsifierDelta).toBeGreaterThan(0.02);
              facts.missingGeometryDelta = falsifierDelta;
            } finally {
              (await changedReplay.dispose()).unwrap();
              changedRaw.destroy();
            }
          }
        }
        expect(
          Math.max(...pixels),
          `${renderPath}/${entry.name} has visible lit pixels`,
        ).toBeGreaterThan(0.02);
        facts.peak = Math.max(...pixels);
        if (entry.skin) world.removeComponent(object, Skin).unwrap();
        report.push(facts);
        await save('report.json', new TextEncoder().encode(JSON.stringify(report, null, 2)));
      }
      const value = (name: string) => required(results.get(`${renderPath}/${name}`));
      expect(difference(value('flat'), value('zero'))).toBeLessThanOrEqual(0.002);
      expect(difference(value('coarse-flat'), value('coarse'))).toBeLessThanOrEqual(0.002);
      expect(difference(value('dense'), value('oracle'))).toBeLessThanOrEqual(0.05);
      expect(difference(value('dense'), value('dense-gpu'))).toBeLessThanOrEqual(0.005);
      expect(difference(value('dense'), value('skin'))).toBeLessThanOrEqual(0.05);
      expect(difference(value('flat/shadow'), value('dense/shadow'))).toBeGreaterThan(1e-5);
      expect(difference(value('dense/shadow'), value('oracle/shadow'))).toBeLessThanOrEqual(0.005);
      const isObject = (pixels: number[], offset: number) =>
        (pixels[offset] ?? 0) > (pixels[offset + 1] ?? 0) * 1.25 &&
        (pixels[offset + 1] ?? 0) > (pixels[offset + 2] ?? 0) * 1.25;
      const flatPixels = value('flat'),
        densePixels = value('dense');
      let addedSilhouettePixels = 0;
      for (let offset = 0; offset < densePixels.length; offset += 3)
        if (isObject(densePixels, offset) && !isObject(flatPixels, offset)) addedSilhouettePixels++;
      expect(addedSilhouettePixels).toBeGreaterThan(3);
      report.push({
        renderPath,
        addedSilhouettePixels,
        oracleDelta: difference(value('dense'), value('oracle')),
        gpuDelta: difference(value('dense'), value('dense-gpu')),
        shadowOracleDelta: difference(value('dense/shadow'), value('oracle/shadow')),
      });
      await save('report.json', new TextEncoder().encode(JSON.stringify(report, null, 2)));

      for (const name of ['dense', 'negative', 'bias', 'uv1'])
        expect(difference(value('flat'), value(name)), name).toBeGreaterThan(0.02);
      expect(difference(value('dense'), value('uv1'))).toBeGreaterThan(0.02);
    }
    expect(errors).toEqual([]);
  } catch (error) {
    await save(
      'failure.json',
      new TextEncoder().encode(
        JSON.stringify({ error: String(error), errors, inspection: renderer.inspect() }, null, 2),
      ),
    );
    throw error;
  } finally {
    off();
    lease.dispose();
  }
}

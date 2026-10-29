import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { halfFloat } from '@forgeax/engine-math';
import {
  Camera,
  DirectionalLight,
  Instances,
  LightProbe,
  Materials,
  MeshFilter,
  MeshRenderer,
  type Renderer,
  ScreenSpaceReflection,
  Skylight,
} from '@forgeax/engine-render';
import {
  buildFrameModel,
  decodeTape,
  encodeTape,
  openReplay,
  type RecorderAttachment,
  type ReplayReadbackResult,
  type ReplaySession,
  replayDeviceRequest,
  tapeDigest,
  type V7Tape,
  type WorkEntry,
  workOutputs,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { assert, expect } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { compactTape } from './compact-tape.fixture';
import { describeReplayWork } from './replay-inspections.fixture';

type SaveEvidence = (name: string, bytes: Uint8Array) => void | Promise<void>;
// Fixture-local admission identity; artifact reports separately retain checkout provenance.
// Supplying this host option runs the real R32Float capability probe at initialization.
export const gbufferReplayIdentity = {
  sourceHead: 'fixture:standard-gbuffer-replay',
  sourceTree: 'fixture:standard-gbuffer-replay',
  lockSha256: 'fixture:standard-gbuffer-replay',
  buildSha256: 'fixture:standard-gbuffer-replay',
} as const;
export function renderValue<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error), { cause: result.error });
  return result.value;
}
const rgba = (read: ReplayReadbackResult) => {
  expect(read.format).toBe('rgba16float');
  return Array.from(
    new Uint16Array(read.bytes.buffer, read.bytes.byteOffset, read.bytes.byteLength / 2),
    halfFloat.f16ToF32,
  );
};
const center = (values: readonly number[]) =>
  values.slice((32 * 64 + 32) * 4, (32 * 64 + 32) * 4 + 4);
const maxDifference = (a: readonly number[], b: readonly number[]) => {
  expect(a.length).toBe(b.length);
  return a.reduce((maximum, value, i) => Math.max(maximum, Math.abs(value - (b[i] ?? NaN))), 0);
};
const reflectance = (word: number) =>
  [0, 8, 16].map((shift) => (((word >>> shift) & 255) / 255) ** 2);

function effectPixelWorks(works: readonly WorkEntry[], enabled: boolean) {
  return enabled
    ? works.filter((work) =>
        work.pipeline.shaders.some((shader) =>
          ['fs_ssao_calc', 'fs_ssr_compose'].includes(shader.entryPoint ?? ''),
        ),
      )
    : [];
}

async function readGBufferStages(
  replay: ReplaySession,
  works: readonly WorkEntry[],
  geometry: WorkEntry,
  lighting: WorkEntry,
  effects: boolean,
) {
  const stages = [geometry, lighting, ...effectPixelWorks(works, effects)];
  const packedAttachments = geometry.attachments?.colorViewHandleIds.slice(1, 5) ?? [];
  const stageRequests = stages.map((work) => {
    const output = workOutputs(work).find((row) => row.role === 'color');
    assert(output, 'missing GBuffer stage output');
    return { ...output.request, workIndex: work.workIndex };
  });
  const trace = effects
    ? works.find((work) =>
        work.pipeline.shaders.some((shader) => shader.entryPoint === 'ssr_trace'),
      )
    : undefined;
  const traceOutput = trace?.bindings.find(
    (binding) => binding.groupIndex === 0 && binding.binding === 4,
  )?.resourceId;
  const traceRequests =
    trace && traceOutput ? [{ resourceId: traceOutput, workIndex: trace.workIndex }] : [];
  const results = (
    await replay.readAtWorks([
      ...stageRequests,
      ...packedAttachments.map((resourceId) => ({ resourceId, workIndex: geometry.workIndex })),
      ...traceRequests,
    ])
  ).unwrap();
  return {
    inspected: stages.map((work, index) => {
      const result = results[index];
      assert(result, 'missing GBuffer stage readback');
      return describeReplayWork(work, result.unwrap());
    }),
    packedReads: results.slice(stages.length, stages.length + packedAttachments.length),
    traced: traceRequests.length === 0 ? undefined : results.at(-1),
  };
}

async function verifyMissingLightingFalsifier(
  tape: V7Tape,
  lighting: WorkEntry,
  expected: readonly number[],
  emissive: readonly number[],
  save: SaveEvidence,
  devices: GPUDevice[],
) {
  // Remove the real lighting draw from a separately encoded tape. This must
  // change the selected post-work pixels, not return a cached live image.
  const corrupted = encodeTape(
    {
      ...tape,
      events: tape.events.map((event, index) =>
        index === lighting.eventIndex && event.kind === 'draw'
          ? { ...event, vertexCount: 0 }
          : event,
      ),
    },
    { compression: 'gzip' },
  ).unwrap();
  await save('missing-lighting.falsifier.rhitape', corrupted);
  const decoded = decodeTape(corrupted).unwrap();
  const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
  const device = (
    await adapter.requestDevice(replayDeviceRequest(decoded, adapter.features, adapter.limits))
  ).unwrap();
  const raw = webgpu._internal_getRawDevice(device);
  if (raw === undefined) throw new Error('falsifier replay device unavailable');
  devices.push(raw);
  const replay = (
    await openReplay(decoded, { device, createShaderModule: webgpu.createShaderModule })
  ).unwrap();
  try {
    const inspection = (await replay.inspectWork(lighting.workIndex, ['pixels'])).unwrap();
    if (inspection.attachment === undefined) throw new Error('missing falsifier attachment');
    const pixels = rgba(inspection.attachment);
    expect(maxDifference(pixels, emissive)).toBe(0);
    const difference = maxDifference(pixels, expected);
    expect(difference).toBeGreaterThan(0.1);
    return {
      digest: tapeDigest(corrupted),
      workIndex: lighting.workIndex,
      eventIndex: lighting.eventIndex,
      rejectedLiveDifference: difference,
    };
  } finally {
    (await replay.dispose()).unwrap();
  }
}

/** Production Renderer frames, strict v7 decode, fresh-device replay and post-work reads. */
export async function verifyStandardGBufferReplay(
  renderer: Renderer,
  assets: AssetRegistry,
  recorder: RecorderAttachment,
  save: SaveEvidence,
) {
  const world = new World({ assets });
  const original = renderer.inspect().profile;
  const errors: unknown[] = [];
  // Keep native devices until the live journey ends. Destroying a replay
  // device between captures can poison Chromium's shared adapter; sessions
  // still release their buffers/textures immediately after each inspection.
  const replayDevices: GPUDevice[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  const baseColor = [0.002, 0.02, 0.6, 0.37] as const;
  const emissive = [4, 2, 0.5] as const;
  const material = assets
    .create(
      Materials.standard({
        baseColor,
        emissive,
        emissiveIntensity: 1,
        metallic: 0,
        roughness: 0.13,
        specularColor: [0.04, 0.2, 0.8],
        ior: 1.8,
      }),
    )
    .unwrap();
  const receiver = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -6] } },
      {
        component: MeshFilter,
        data: {
          assetHandle: assets.create(createBoxGeometry(4, 4, 0.1).unwrap()).unwrap(),
        },
      },
      { component: MeshRenderer, data: { materials: [material] } },
      {
        component: Instances,
        data: {
          // Rotation plus nonuniform scale belongs to the World instance.
          // Direct and GPU-driven draws must produce the same world normal.
          transforms: new Float32Array([
            Math.SQRT1_2,
            0,
            -Math.SQRT1_2,
            0,
            0,
            0.75,
            0,
            0,
            1.5 * Math.SQRT1_2,
            0,
            1.5 * Math.SQRT1_2,
            0,
            0,
            0,
            0,
            1,
          ]),
        },
      },
    )
    .unwrap();
  const camera = world
    .spawn(
      { component: Transform, data: {} },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: 1,
          near: 0.1,
          far: 30,
          antialias: 0,
          bloom: 0,
          tonemap: 1,
        },
      },
    )
    .unwrap();
  const sun = world
    .spawn({
      component: DirectionalLight,
      data: { direction: [0, 0, -1], intensity: 3, castShadow: false },
    })
    .unwrap();
  const sky = world
    .spawn({ component: Skylight, data: { intensity: 0.4, color: [0.3, 0.4, 0.5] } })
    .unwrap();
  const sh = new Float32Array(27);
  sh.set([4, 8, 12]);
  const probe = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, -6] } },
      { component: LightProbe, data: { irradiance: sh, radius: 10 } },
    )
    .unwrap();
  const lease = renderValue(renderer.attach(world));
  const evidence: unknown[] = [];
  let litReference: number[] | undefined;
  try {
    await save('report.json', new TextEncoder().encode('[]'));
    for (const mode of ['direct', 'automatic', 'emissive-only', 'effects'] as const) {
      const effects = mode === 'effects';
      if (mode === 'emissive-only') {
        world.set(sun, DirectionalLight, { intensity: 0 }).unwrap();
        world.set(sky, Skylight, { intensity: 0 }).unwrap();
        world.set(probe, LightProbe, { irradiance: new Float32Array(27) }).unwrap();
      }
      if (effects) {
        // Keep the effects control's original geometry: the same rotation
        // moves from instance-local to entity-world for this state.
        world
          .set(receiver, Instances, {
            transforms: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
          })
          .unwrap();
        world.set(sun, DirectionalLight, { intensity: 3 }).unwrap();
        world.set(sky, Skylight, { intensity: 0.4 }).unwrap();
        world.set(probe, LightProbe, { irradiance: sh }).unwrap();
        world
          .set(receiver, Transform, { quat: [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)] })
          .unwrap();
        world
          .spawn(
            // Meet the rotated receiver within the default 0.25 m AO radius.
            // The old 2 m placement only exposed quantized-normal self-occlusion.
            { component: Transform, data: { pos: [1.4, 0, -6] } },
            {
              component: MeshFilter,
              data: {
                assetHandle: assets.create(createBoxGeometry(0.1, 4, 8).unwrap()).unwrap(),
              },
            },
            {
              component: MeshRenderer,
              data: {
                materials: [
                  assets
                    .create(
                      Materials.standard({
                        baseColor: [0.3, 0.6, 0.1, 1],
                        emissive: [0.2, 4, 0.4],
                        metallic: 0,
                        roughness: 0.8,
                      }),
                    )
                    .unwrap(),
                ],
              },
            },
          )
          .unwrap();
        world
          .addComponent(camera, {
            component: ScreenSpaceReflection,
            data: { maxDistance: 12, thickness: 0.2, maxRoughness: 0.6 },
          })
          .unwrap();
      }
      renderValue(renderer.setProfile({ ...original, renderPath: 'deferred', ssao: effects }));
      const draw = async (observe = false) => {
        world.update(1 / 60).unwrap();
        propagateTransforms(world).unwrap();
        return drawReadyFrame(
          renderer,
          {
            leases: [lease],
            camera: { lease },
            environment: { lease },
            ...(mode === 'direct' ? { geometryLane: 'direct' as const } : {}),
          },
          observe ? ['linear-hdr'] : undefined,
        );
      };
      for (let frame = 0; frame < 8; frame++) await draw();
      const capture = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      const receipt = await draw(true);
      (await recorder.frameBoundary()).unwrap();
      const encoded = compactTape((await capture).unwrap());
      await save(`${mode}.rhitape`, encoded.bytes);
      await save(
        `${mode}-inspection.json`,
        new TextEncoder().encode(JSON.stringify(renderer.inspect(), null, 2)),
      );
      const observed = renderValue(
        await renderer.observe(receipt, { include: ['linear-hdr'] }),
      ).observations?.find((item) => item.domain === 'linear-hdr');
      if (observed === undefined) throw new Error('missing live HDR observation');
      await save(`${mode}-live.rgba16f`, observed.bytes);
      const liveView = new DataView(
        observed.bytes.buffer,
        observed.bytes.byteOffset,
        observed.bytes.byteLength,
      );
      const live = Array.from({ length: 64 * 64 * 4 }, (_, i) =>
        halfFloat.f16ToF32(
          liveView.getUint16(
            Math.floor(i / 256) * observed.metadata.bytesPerRow + (i % 256) * 2,
            true,
          ),
        ),
      );
      const tape = decodeTape(encoded.bytes).unwrap();
      const model = buildFrameModel(tape);
      const geometryWorks = model.works.filter((work) =>
        work.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_gbuffer'),
      );
      const geometry = geometryWorks.at(-1);
      const lighting = model.works.find((work) =>
        work.pipeline.shaders.some((shader) =>
          shader.entryPoint?.startsWith('fs_standard_deferred'),
        ),
      );
      if (geometry === undefined || lighting === undefined || geometry.attachments === null)
        throw new Error('missing production GBuffer/lighting work');
      expect(geometry.workIndex).toBeLessThan(lighting.workIndex);
      expect(geometry.drawCall).toMatchObject({
        // Deferred SSR writes its fallback in lighting, so the G-buffer stays GPU-driven.
        kind: mode === 'direct' ? 'drawIndexed' : 'drawIndexedIndirect',
      });
      expect(geometry.attachments.colorViewHandleIds).toHaveLength(effects ? 7 : 6);
      if (effects) {
        const temporalView = model.resources.find(
          (resource) => resource.resourceId === geometry.attachments?.colorViewHandleIds[6],
        );
        expect(temporalView?.kind).toBe('texture-view');
        const temporalTexture = model.resources.find(
          (resource) =>
            resource.resourceId ===
            (temporalView?.descriptor as { sourceHandleId?: string } | undefined)?.sourceHandleId,
        );
        expect(temporalTexture?.descriptor).toMatchObject({
          desc: { label: 'standard-scene-temporal', format: 'rgba16float' },
        });
      }
      expect(geometry.attachments.colorViewHandleIds[0]).toBe(
        lighting.attachments?.colorViewHandleIds[0],
      );
      expect(
        model.resources.some((resource) =>
          JSON.stringify(resource.descriptor).includes('gbuffer-emissive-opacity'),
        ),
      ).toBe(false);
      expect(lighting.pipeline.descriptor).toMatchObject({
        desc: {
          fragment: {
            targets: [
              expect.objectContaining({
                format: 'rgba16float',
                blend: {
                  color: { operation: 'add', srcFactor: 'one', dstFactor: 'one' },
                  alpha: { operation: 'add', srcFactor: 'zero', dstFactor: 'one' },
                },
              }),
              ...(effects ? [expect.anything(), expect.anything()] : []),
            ],
          },
        },
      });
      const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
      const fresh = (
        await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
      ).unwrap();
      const raw = webgpu._internal_getRawDevice(fresh);
      if (raw === undefined) throw new Error('fresh native replay device unavailable');
      replayDevices.push(raw);
      const replayErrors: string[] = [];
      raw.addEventListener('uncapturederror', (event) => replayErrors.push(event.error.message));
      raw.pushErrorScope('validation');
      const replay = (
        await openReplay(tape, { device: fresh, createShaderModule: webgpu.createShaderModule })
      ).unwrap();
      const reads: unknown[] = [];
      try {
        const stageReads = await readGBufferStages(
          replay,
          model.works,
          geometry,
          lighting,
          effects,
        );
        const inspected = stageReads.inspected;
        const inspect = async (work: WorkEntry) => {
          const inspection = inspected.find((row) => row.workIndex === work.workIndex);
          if (inspection === undefined) throw new Error('missing GBuffer stage inspection');
          expect(inspection.eventIndex).toBe(work.eventIndex);
          const read = inspection.attachment;
          if (read === undefined) throw new Error('missing replay attachment');
          expect(read.provenance.selectedWorkIndex).toBe(work.workIndex);
          await save(`${mode}-work-${work.workIndex}.${read.format}`, read.bytes);
          reads.push({
            workIndex: work.workIndex,
            eventIndex: work.eventIndex,
            passIndex: work.passIndex,
            format: read.format,
            resourceId: read.resourceId,
            bindings: inspection.bindings,
          });
          return read;
        };
        const geometryPixels = rgba(await inspect(geometry));
        const lightingPixels = rgba(await inspect(lighting));
        expect(geometryPixels.every(Number.isFinite)).toBe(true);
        expect(lightingPixels.every(Number.isFinite)).toBe(true);
        for (let i = 0; i < 3; i++)
          expect(center(geometryPixels)[i]).toBeCloseTo(emissive[i] ?? NaN, 3);
        expect(center(geometryPixels)[3]).toBeCloseTo(0.37, 3);
        expect(lightingPixels.filter((_, i) => i % 4 === 3)).toEqual(
          geometryPixels.filter((_, i) => i % 4 === 3),
        );
        const packed: number[] = [];
        let dielectricWord: number | undefined;
        const packedAttachments = geometry.attachments.colorViewHandleIds.slice(1, 5);
        const packedReads = stageReads.packedReads;
        for (const [index, resourceId] of packedAttachments.entries()) {
          const result = packedReads[index];
          assert(result, 'missing packed GBuffer readback');
          const read = result.unwrap();
          const channels = index === 1 ? 2 : 1;
          expect(read.format).toBe(channels === 2 ? 'rg32uint' : 'r32uint');
          expect(read.bytes.byteLength).toBe(64 * 64 * 4 * channels);
          const words = new Uint32Array(
            read.bytes.buffer,
            read.bytes.byteOffset,
            read.bytes.byteLength / 4,
          );
          const offset = (32 * 64 + 32) * channels;
          packed.push(words[offset] ?? NaN);
          if (channels === 2) dielectricWord = words[offset + 1];
          await save(`${mode}-${resourceId.replace(':', '-')}.${read.format}`, read.bytes);
        }
        const [normalWord, f0Word, colorWord, contextWord] = packed;
        if (
          normalWord === undefined ||
          f0Word === undefined ||
          colorWord === undefined ||
          contextWord === undefined
        )
          throw new Error('missing packed GBuffer attachment');
        expect((normalWord >>> 24) / 255).toBeCloseTo(0.13, 2);
        // This nonmetallic material has identical mixed and dielectric F0;
        // both occlusion and dielectric F90 are one.
        expect(dielectricWord).toBe(f0Word);
        expect(f0Word >>> 24).toBe(255);
        expect(colorWord >>> 24).toBe(0);
        expect(contextWord & 0xffffff).toBeGreaterThan(0);
        const octX = (normalWord & 4095) * (2 / 4095) - 1;
        const octY = ((normalWord >>> 12) & 4095) * (2 / 4095) - 1;
        const normal = [octX, octY, 1 - Math.abs(octX) - Math.abs(octY)];
        const length = Math.hypot(...normal);
        const expectedNormal = [Math.SQRT1_2, 0, Math.SQRT1_2];
        const cosine = normal.reduce(
          (sum, value, i) => sum + (value / length) * (expectedNormal[i] ?? NaN),
          0,
        );
        expect(cosine).toBeGreaterThan(Math.cos((0.07 * Math.PI) / 180));
        const color = reflectance(colorWord);
        const f0 = reflectance(f0Word);
        for (let i = 0; i < 3; i++) {
          expect(Math.abs((color[i] ?? NaN) - (baseColor[i] ?? NaN))).toBeLessThan(1 / 255);
          expect(
            Math.abs((f0[i] ?? NaN) - ([0.04, 0.2, 0.8][i] ?? NaN) * (0.8 / 2.8) ** 2),
          ).toBeLessThan(1 / 255);
        }
        let finalPixels = lightingPixels;
        let compositionDifference: number | undefined;
        if (effects) {
          const ao = model.works.find((work) =>
            work.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_ssao_calc'),
          );
          const trace = model.works.find((work) =>
            work.pipeline.shaders.some((shader) => shader.entryPoint === 'ssr_trace'),
          );
          const compose = model.works.find((work) =>
            work.pipeline.shaders.some((shader) => shader.entryPoint === 'fs_ssr_compose'),
          );
          if (ao === undefined || trace === undefined || compose === undefined)
            throw new Error(
              `missing AO/SSR production work: ${JSON.stringify(renderer.inspect().ssr)}`,
            );
          const normalView = geometry.attachments.colorViewHandleIds[1];
          for (const work of [ao, trace, compose])
            expect(work.bindings.some((binding) => binding.resourceId === normalView)).toBe(true);
          expect(ao.workIndex).toBeGreaterThan(geometry.workIndex);
          expect(ao.workIndex).toBeLessThan(lighting.workIndex);
          const occlusion = await inspect(ao);
          // Visibility is .r; .gb carry the encoded normal the AO filter reads.
          expect(occlusion.format).toBe('rgba8unorm');
          expect(
            occlusion.bytes.filter((_, i) => i % 4 === 0).reduce((a, b) => Math.min(a, b), 255),
          ).toBeLessThan(255);
          const traceOutput = trace.bindings.find(
            (binding) => binding.groupIndex === 0 && binding.binding === 4,
          );
          if (traceOutput?.resourceId === undefined || traceOutput.resourceId === null)
            throw new Error('missing SSR trace output binding');
          const traceRead = stageReads.traced;
          assert(traceRead, 'missing SSR trace readback');
          const traced = traceRead.unwrap();
          const tracePixels = rgba(traced);
          expect(tracePixels.every(Number.isFinite)).toBe(true);
          expect(tracePixels.filter((value, i) => i % 4 === 3 && value > 0).length).toBeGreaterThan(
            0,
          );
          reads.push({
            workIndex: trace.workIndex,
            eventIndex: trace.eventIndex,
            resourceId: traceOutput.resourceId,
            positiveHits: tracePixels.filter((value, i) => i % 4 === 3 && value > 0).length,
          });
          await save(`${mode}-trace.rgba16float`, traced.bytes);
          finalPixels = rgba(await inspect(compose));
          compositionDifference = maxDifference(
            finalPixels.filter((_, i) => i % 4 !== 3),
            lightingPixels.filter((_, i) => i % 4 !== 3),
          );
          expect(compositionDifference).toBeGreaterThan(0);
          expect(finalPixels.filter((_, i) => i % 4 === 3)).toEqual(
            lightingPixels.filter((_, i) => i % 4 === 3),
          );
        } else if (mode === 'emissive-only') {
          expect(maxDifference(geometryPixels, lightingPixels)).toBe(0);
          if (litReference === undefined) throw new Error('missing lit falsifier reference');
          expect(maxDifference(lightingPixels, litReference)).toBeGreaterThan(0.1);
        } else {
          expect(maxDifference(geometryPixels, lightingPixels)).toBeGreaterThan(0.1);
          if (litReference !== undefined)
            expect(maxDifference(lightingPixels, litReference)).toBeLessThanOrEqual(0.002);
          litReference = lightingPixels;
        }
        const error = maxDifference(finalPixels, live);
        expect(error).toBeLessThanOrEqual(0.002);
        const falsifier =
          mode === 'direct'
            ? await verifyMissingLightingFalsifier(
                tape,
                lighting,
                lightingPixels,
                geometryPixels,
                save,
                replayDevices,
              )
            : undefined;
        expect(await raw.popErrorScope()).toBeNull();
        expect(replayErrors).toEqual([]);
        evidence.push({
          mode,
          digest: encoded.digest,
          bytes: encoded.bytes.byteLength,
          liveBytesPerRow: observed.metadata.bytesPerRow,
          maxLiveError: error,
          compositionDifference,
          geometryCenter: center(geometryPixels),
          lightingCenter: center(lightingPixels),
          packed,
          normal: normal.map((value) => value / length),
          falsifier,
          unseededResources: model.unseededResources,
          reads,
        });
        await save('report.json', new TextEncoder().encode(JSON.stringify(evidence, null, 2)));
      } finally {
        (await replay.dispose()).unwrap();
      }
      expect(errors, JSON.stringify(errors)).toEqual([]);
    }
    renderValue(renderer.setProfile(original));
    return evidence;
  } catch (error) {
    await save(
      'failure.json',
      new TextEncoder().encode(
        JSON.stringify({ error, errors, renderer: renderer.inspect() }, null, 2),
      ),
    );
    throw error;
  } finally {
    unsubscribe();
    lease.dispose();
    for (const device of replayDevices) device.destroy();
  }
}

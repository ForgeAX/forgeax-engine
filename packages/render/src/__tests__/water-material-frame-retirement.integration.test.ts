import type { Buffer } from '@forgeax/engine-rhi';
import { RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import {
  buildWaterMeshView,
  buildWaterWaveUploadPlan,
  cookGerstnerWaveSet,
  type WaterWaveUploadBody,
  waterBodyOwnerKey,
} from '@forgeax/engine-water';
import { createWaterMeshLayoutReceipt } from '@forgeax/engine-water/internal';
import { afterEach, expect, it, vi } from 'vitest';
import { createRenderer } from '../assembly/factory';
import type { RenderSystemInternals } from '../record/render-context';
import * as renderSystem from '../render-system';
import {
  finalizeWaterMaterialAdmissionDraws,
  ownWaterMaterialAdmissionSource,
  ownWaterMaterialOwner,
  ownWaterMeshAdmissionDraw,
  projectWaterMeshAdmissionTiles,
} from '../water/mesh-source-admission';
import * as waterInfo from '../water/water-info-feature';
import type { WaterMeshInstanceDrawUpload } from '../water/wave-material';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

afterEach(() => vi.restoreAllMocks());

it.each(
  (['complete', 'reject', 'dispose-before-reject'] as const).flatMap((settlement) =>
    [0, 2].map((targetCount) => ({ settlement, targetCount })),
  ),
)('retires every Water cohort buffer exactly once with $targetCount targets when fences $settlement', async ({
  settlement,
  targetCount,
}) => {
  const prepareRetirementWaterMesh = () => {
    const cooked = cookGerstnerWaveSet({
      kind: 'water-wave-set',
      sourceMode: 'predefined',
      waves: [{ directionXZ: [1, 0], wavelengthM: 8, amplitudeM: 0.5, steepness: 0.25 }],
      inputDigest: 'a'.repeat(64),
      depthMaskM: 4,
      maxWaveHeightM: 0.5,
      timeSource: 'scene-clock',
    }).unwrap();
    const body: WaterWaveUploadBody = {
      worldId: 0,
      worldIdentity: 'retirement-world',
      bodyGuid: 'body-a',
      bodyGeneration: 1,
      zoneGeneration: 1,
      waveSetGuid: 'wave-a',
      waveSet: cooked,
      timeSeconds: 0,
      previousTimeSeconds: 0,
      baseHeightM: 0,
      tileOriginWorldXZ: [0, 0],
      tileLengthM: 20971.52,
      heightSource: { kind: 'fixed', fixedHeightM: 0, fixedDepthM: 2, fixedVelocityXZ: [0, 0] },
      supportsWaves: true,
      usesFlatSurfaceHeight: false,
      meshEdgeOverlayEnabled: false,
    };
    const infoBody = { ...body, bodyGuid: 'body-info' };
    const infoBodyKey = waterBodyOwnerKey(
      infoBody.worldIdentity,
      infoBody.bodyGuid,
      infoBody.bodyGeneration,
      infoBody.zoneGeneration,
    );
    const waveBodies = [body, infoBody];
    const waveUploadPlan = buildWaterWaveUploadPlan(waveBodies).unwrap();
    const mesh = buildWaterMeshView(
      {
        zoneGuid: 'zone-a',
        zoneGeneration: 1,
        originXZ: [0, 0],
        extentM: [4, 4],
        tileSizeM: 4,
        tessellationFactor: 1,
        lodScale: 1,
        bodies: [
          {
            guid: infoBody.bodyGuid,
            generation: 1,
            type: 'lake',
            visible: true,
            affectsWaterMesh: true,
            priority: 0,
            materialKey: 'water',
            waveOriginXZ: [0, 0],
            baseHeightM: 0,
            maxWaveHeightM: 0.5,
            polygon: {
              outer: [
                [0, 0],
                [4, 0],
                [4, 4],
                [0, 4],
              ],
            },
          },
        ],
      },
      { viewId: 'camera:water-retirement', observerM: [2, 4, 2] },
    ).unwrap();
    return { infoBody, infoBodyKey, waveBodies, waveUploadPlan, mesh };
  };
  const { infoBody, infoBodyKey, waveBodies, waveUploadPlan, mesh } = prepareRetirementWaterMesh();
  const ownerDraw = mesh.buckets.flatMap((bucket) => bucket.ownerDraws)[0];
  if (ownerDraw === undefined) throw new Error('The fixture must publish a real WaterMesh draw');
  const meshDraw: WaterMeshInstanceDrawUpload = {
    drawKey: ownerDraw.drawKey,
    bodyGuid: infoBodyKey,
    bodyGeneration: 1,
    zoneGeneration: 1,
    viewIdentity: mesh.viewId,
    transitionTargets: [],
    bytes: ownerDraw.instanceBytes,
    coverageBytes: ownerDraw.coverageBytes,
    layout: ownerDraw.layout,
  };
  const ownedClosure = (changeBytes: boolean) => {
    const bytes = ownerDraw.instanceBytes.slice();
    if (changeBytes) bytes[0] = (bytes[0] ?? 0) ^ 1;
    const sourceDraw = ownWaterMeshAdmissionDraw(
      {
        guid: infoBody.bodyGuid,
        generation: infoBody.bodyGeneration,
        worldIdentity: infoBody.worldIdentity,
        zoneGeneration: infoBody.zoneGeneration,
      },
      mesh.viewId,
      {
        drawKey: ownerDraw.drawKey,
        materialIndex: 0,
        mesh: ownerDraw.mesh,
        localAabb: new Float32Array(6),
        instanceCount: ownerDraw.instances.length,
        bytes,
        coverageBytes: ownerDraw.coverageBytes,
        layout: createWaterMeshLayoutReceipt(bytes, ownerDraw.coverageBytes),
        transitionTargets: ownerDraw.instances.flatMap((instance, instanceIndex) =>
          instance.transitionBodyGuid === undefined ||
          instance.transitionBodyGeneration === undefined
            ? []
            : [
                {
                  instanceIndex,
                  bodyGuid: instance.transitionBodyGuid,
                  bodyGeneration: instance.transitionBodyGeneration,
                },
              ],
        ),
      },
    );
    const tiles = projectWaterMeshAdmissionTiles(
      {
        drawKey: sourceDraw.drawKey,
        bodyGuid: infoBody.bodyGuid,
        bodyGeneration: infoBody.bodyGeneration,
        worldIdentity: infoBody.worldIdentity,
        zoneGeneration: infoBody.zoneGeneration,
        viewIdentity: mesh.viewId,
        bytes: sourceDraw.bytes,
        coverageBytes: sourceDraw.coverageBytes,
        layout: sourceDraw.layout,
        transitionTargets: sourceDraw.transitionTargets,
      },
      sourceDraw,
    );
    const source = ownWaterMaterialAdmissionSource({
      waterOwner: ownWaterMaterialOwner({
        guid: infoBody.bodyGuid,
        generation: infoBody.bodyGeneration,
        worldIdentity: infoBody.worldIdentity,
        zoneGuid: 'zone-a',
        zoneGeneration: infoBody.zoneGeneration,
        viewIdentity: mesh.viewId,
        drawKey: sourceDraw.drawKey,
      }),
      waterMeshTiles: tiles,
    });
    const closure = finalizeWaterMaterialAdmissionDraws([{ renderableIndex: 0, source }]);
    if (closure === undefined)
      throw new Error('Owned Water fixture must finalize its draw closure');
    return closure;
  };
  const stableOwnedClosure = ownedClosure(false);
  const changedOwnedClosure = ownedClosure(true);
  const targets: waterInfo.WaterInfoFramePublication['targets'] = Array.from(
    { length: targetCount },
    (_, epoch) => ({
      targetName: `water-info-retirement-${epoch}`,
      targetFormat: 'rgba16float',
      bank: 0,
      epoch,
      write: false,
      sourceDigest: 'retirement',
      contentFrameGeneration: 1,
      width: 1,
      height: 1,
      layers: 1,
      graphResourceVersion: 'retirement',
    }),
  );
  let publicationTargets = targets;
  const publications = new Map<string, waterInfo.WaterInfoFramePublication>();
  vi.spyOn(waterInfo, 'waterInfoFramePublicationForRenderer').mockImplementation(
    (_feature, viewIdentity, frameGeneration, deviceGeneration) => {
      const key = JSON.stringify([viewIdentity, frameGeneration, deviceGeneration]);
      let publication = publications.get(key);
      if (publication === undefined) {
        const target = publicationTargets[0];
        publication = Object.freeze({
          viewIdentity,
          frameGeneration,
          deviceGeneration,
          graphResourceVersion: 'retirement',
          targets: publicationTargets,
          rows: new Map<string, waterInfo.WaterInfoDescriptorRow>(
            target === undefined
              ? []
              : [
                  [
                    infoBodyKey,
                    {
                      ownerKey: infoBodyKey,
                      worldId: 0,
                      worldIdentity: infoBody.worldIdentity,
                      bodyGuid: infoBody.bodyGuid,
                      bodyGeneration: 1,
                      outputGeneration: 1,
                      zoneGuid: 'zone-a',
                      zoneGeneration: 1,
                      deviceGeneration,
                      frameGeneration,
                      targetName: target.targetName,
                      targetFormat: target.targetFormat,
                      slice: 0,
                      descriptor: new Uint8Array(48),
                      context: {
                        zoneGuid: 'zone-a',
                        viewId: viewIdentity,
                        slice: 0,
                        centerXZ: [2, 2],
                        extentXZ: [4, 4],
                        waterYMinM: -1,
                        waterYMaxM: 1,
                        groundYMinM: -2,
                        maxVelocityMPerSec: 1,
                        format: target.targetFormat === 'rgba16float' ? 'rgba16f' : 'rgba32f',
                        widthPx: 1,
                        heightPx: 1,
                        blurRadius: 0,
                        zoneGeneration: 1,
                        deviceGeneration,
                        frameGeneration,
                        graphResourceVersion: target.graphResourceVersion,
                        sourceDigest: 'retirement',
                      },
                    },
                  ],
                ],
          ),
          waterInfoAvailability: new Map(),
          waveBodies,
          waveUploadPlan,
        });
        publications.set(key, publication);
      }
      return publication;
    },
  );
  let internals: RenderSystemInternals | undefined;
  const createState = renderSystem.createRendererState;
  vi.spyOn(renderSystem, 'createRendererState').mockImplementation((input) => {
    internals = input;
    return createState(input);
  });
  const host = await createRenderer(
    {
      width: 64,
      height: 64,
      getContext: () => null,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as HTMLCanvasElement,
    { rhi, features: [waterInfo.createWaterInfoFeature()] },
    { shaderManifestUrl: renderLifecycleManifestUrl({ waterWaves: true }) },
  );
  const initialized = await host.initialization;
  if (!initialized.ok) throw initialized.error;
  if (internals?.getWaterMaterialFrameBindings === undefined)
    throw new Error('Production Water frame bindings must be installed');
  const runtime = internals;
  const texture = runtime.device
    .createTexture({ size: [1, 1, 1], format: 'rgba16float', usage: 4 })
    .unwrap();
  const textureView = runtime.device.createTextureView(texture, { dimension: '2d-array' }).unwrap();
  const createBuffer = vi.spyOn(runtime.device, 'createBuffer');
  const createBindGroup = vi.spyOn(runtime.device, 'createBindGroup');
  let targetView = textureView;
  const report = vi.spyOn(runtime.errorRegistry, 'fire');
  const destroy = vi.spyOn(RhiNullDevice.prototype, 'destroyBuffer');
  const bindings = (
    frameGeneration: number,
    targetLimit = targetCount,
    waterMeshDraws: readonly WaterMeshInstanceDrawUpload[] = [],
    waterMeshDrawsOwned = false,
  ) =>
    runtime.getWaterMaterialFrameBindings?.({
      viewIdentity: 'camera:water-retirement',
      frameGeneration,
      deviceGeneration: runtime.deviceScope.generation,
      viewOriginM: [0, 0, 0],
      waterInfoTextureViews: new Map([
        ...publicationTargets
          .slice(0, targetLimit)
          .map((target) => [target.targetName, targetView] as const),
        ['advanced-ocean-height', textureView],
        ['advanced-ocean-normal', textureView],
      ]),
      waterMeshDraws,
      ...(waterMeshDrawsOwned ? { waterMeshDrawsOwned: true } : {}),
    });
  const first = bindings(1, targetCount === 0 ? 0 : 1);
  if (first === undefined) throw new Error('The first Water frame must upload real buffers');
  const buffersFor = (frames: typeof first): Buffer[] =>
    [...frames.values()].flatMap((frame) => [
      frame.bodyDataBuffer,
      frame.waveDataBuffer,
      frame.drawDataBuffer,
      frame.waterInfoDescriptorBuffer,
      frame.waterMeshInstanceBuffer,
      frame.bakedDescriptorBuffer,
      frame.bakedSamplesBuffer,
    ]);
  const buffers = [...buffersFor(first)];
  let resolve!: (value: undefined) => void;
  let reject!: (cause: unknown) => void;
  const completion = new Promise<undefined>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  vi.spyOn(runtime.device.queue, 'onSubmittedWorkDone').mockReturnValue(completion);
  expect(bindings(1, targetCount === 0 ? 0 : 1)).toBe(first);
  const assertWaterFrameTargetRebinding = () => {
    if (targetCount > 0) {
      const targetName = targets[0]?.targetName ?? '';
      const added = bindings(1, 1, [meshDraw]);
      if (added === undefined) throw new Error('A newly admitted WaterMesh draw must rebind');
      expect(added).not.toBe(first);
      expect(added.get(targetName)?.waterMeshInstanceDynamicOffsets.has(meshDraw.drawKey)).toBe(
        true,
      );
      expect(first.get(targetName)?.waterMeshInstanceDynamicOffsets.has(meshDraw.drawKey)).toBe(
        false,
      );
      expect(bindings(1, 1, [meshDraw])).toBe(added);
      buffers.push(...buffersFor(added));
      const secondDraw = { ...meshDraw, drawKey: `${meshDraw.drawKey}:second` };
      const addedAgain = bindings(1, 1, [secondDraw]);
      if (addedAgain === undefined)
        throw new Error('The next WaterMesh draw must expand the frame');
      expect(addedAgain).not.toBe(added);
      const offsets = addedAgain.get(targetName)?.waterMeshInstanceDynamicOffsets;
      expect(offsets?.has(meshDraw.drawKey)).toBe(true);
      expect(offsets?.has(secondDraw.drawKey)).toBe(true);
      expect(offsets?.get(meshDraw.drawKey)).not.toBe(offsets?.get(secondDraw.drawKey));
      expect(added.get(targetName)?.waterMeshInstanceDynamicOffsets.has(secondDraw.drawKey)).toBe(
        false,
      );
      expect(bindings(1, 1, [secondDraw])).toBe(addedAgain);
      buffers.push(...buffersFor(addedAgain));
      const bufferCreatesBeforeSubset = createBuffer.mock.calls.length;
      const bindGroupCreatesBeforeSubset = createBindGroup.mock.calls.length;
      expect(bindings(1, 1, [meshDraw])).toBe(addedAgain);
      expect(createBuffer).toHaveBeenCalledTimes(bufferCreatesBeforeSubset);
      expect(createBindGroup).toHaveBeenCalledTimes(bindGroupCreatesBeforeSubset);

      targetView = runtime.device.createTextureView(texture, { dimension: '2d-array' }).unwrap();
      const replacement = bindings(1, 1);
      if (replacement === undefined) throw new Error('A changed WaterInfo target must rebind');
      expect(replacement).not.toBe(first);
      expect(replacement.get(targets[0]?.targetName ?? '')?.waterInfoTextureView).toBe(targetView);
      expect(first.get(targets[0]?.targetName ?? '')?.waterInfoTextureView).toBe(textureView);
      buffers.push(...buffersFor(replacement));
      const expanded = bindings(1);
      if (expanded === undefined) throw new Error('Additional targets must expand the same frame');
      expect(expanded.size).toBe(targetCount + 1);
      buffers.push(...buffersFor(expanded));
      let previous = expanded;
      for (const change of [
        { targetFormat: 'rgba32float' as const },
        { graphResourceVersion: 'retirement-next' },
        { targetName: 'water-info-retirement-renamed' },
      ]) {
        publicationTargets = publicationTargets.map((target, index) =>
          index === 0 ? Object.freeze({ ...target, ...change }) : target,
        );
        publications.clear();
        const changed = bindings(1);
        if (changed === undefined) throw new Error('Changed WaterInfo publication must rebind');
        expect(changed).not.toBe(previous);
        expect(bindings(1)).toBe(changed);
        const target = publicationTargets[0];
        if (target === undefined) throw new Error('The target fixture must remain populated');
        expect(changed.get(target.targetName)).toMatchObject({
          waterInfoFormat: target.targetFormat,
          waterInfoContentGraphResourceVersion: target.graphResourceVersion,
        });
        buffers.push(...buffersFor(changed));
        previous = changed;
      }
      const ownedFirst = bindings(2, 1, stableOwnedClosure.uploads, true);
      if (ownedFirst === undefined) throw new Error('The first owned Water closure must upload');
      const bufferCreatesBeforeConflict = createBuffer.mock.calls.length;
      const bindGroupCreatesBeforeConflict = createBindGroup.mock.calls.length;
      expect(bindings(2, 1, changedOwnedClosure.uploads, true)).toBeUndefined();
      expect(createBuffer).toHaveBeenCalledTimes(bufferCreatesBeforeConflict);
      expect(createBindGroup).toHaveBeenCalledTimes(bindGroupCreatesBeforeConflict);
      expect(report.mock.calls.at(-1)?.[0]).toMatchObject({
        code: 'webgpu-runtime-error',
        detail: {
          error: {
            code: 'water-material-frame-draw-set-invalid',
            message: `WaterMesh draw ${meshDraw.drawKey} changed contents within one view frame`,
          },
        },
      });
      report.mockClear();
      expect(new Set(buffers).size).toBe(buffers.length);
    }
  };
  assertWaterFrameTargetRebinding();
  const destroyed = (buffer: Buffer) =>
    destroy.mock.calls.filter(([actual]) => actual === buffer).length;
  try {
    const second = bindings(2);
    expect(second?.size).toBe(targetCount + 1);
    expect(bindings(2)?.size).toBe(targetCount + 1);
    expect(buffers.map(destroyed)).toEqual(Array(buffers.length).fill(0));
    if (settlement === 'dispose-before-reject') {
      expect(host.dispose().ok).toBe(true);
      expect(buffers.map(destroyed)).toEqual(Array(buffers.length).fill(1));
    }
    if (settlement === 'complete') resolve(undefined);
    else reject(new Error('Water retirement fence rejected'));
    await new Promise((done) => setTimeout(done, 0));
    expect(buffers.map(destroyed)).toEqual(Array(buffers.length).fill(1));
    if (settlement !== 'complete')
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'device-operation-failed',
          detail: expect.objectContaining({ operation: 'complete-frame' }),
        }),
      );
    expect(host.dispose().ok).toBe(true);
    expect(buffers.map(destroyed)).toEqual(Array(buffers.length).fill(1));
    if (second !== undefined)
      expect(buffersFor(second).map(destroyed)).toEqual(Array((targetCount + 1) * 7).fill(1));
  } finally {
    resolve(undefined);
    host.dispose();
  }
});

import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createRuntimeAssetImportTransport, runtimeBinding } from 'virtual:forgeax/pack-runtime';
import { World } from '@forgeax/engine-ecs';
import { type FrameReceipt, LightProbe, type Renderer } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-types';
import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import {
  assertMaterialPayload,
  assertSurfacePixelFalsification,
  createSurfaceDynamicInput,
  createSurfaceHostLossInstrumentation,
  createSurfaceSplashRuntimeHost,
  createSurfaceWaterInstanceTransforms,
  parseSurfaceGuid,
  populateSurfaceWorld,
  runSurfaceAppLifecycle,
  runSurfaceMsaaEdgeOracle,
  runSurfaceOpticalOracle,
  SURFACE_CASES,
  SURFACE_CLOSURE,
  SURFACE_HEIGHT,
  SURFACE_PIXEL_EPSILON,
  SURFACE_WIDTH,
} from './surface-standard-pipeline.runtime-fixture';

const evidenceEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
const EVIDENCE_SOURCE_SHA = evidenceEnv?.VITE_FORGEAX_EVIDENCE_SOURCE_SHA ?? 'unavailable';
const EVIDENCE_BUILD_ID = evidenceEnv?.VITE_FORGEAX_EVIDENCE_BUILD_ID ?? 'unavailable';

type SurfaceReadback = {
  pixels: Uint8Array;
  width: number;
  height: number;
  bytesPerRow: number;
  format: string;
};

async function readScreenshotPixels(canvas: HTMLCanvasElement): Promise<{
  pixels: Uint8Array;
  width: number;
  height: number;
  bytesPerRow: number;
  format: string;
}> {
  let latest: Uint8Array | undefined;
  let width = canvas.width;
  let height = canvas.height;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    const shot = await page.elementLocator(canvas).screenshot({ base64: true, save: false });
    const b64 = typeof shot === 'string' ? shot : shot.base64;
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    width = bitmap.width;
    height = bitmap.height;
    const offscreen = new OffscreenCanvas(width, height);
    const context = offscreen.getContext('2d', { willReadFrequently: true });
    if (context === null) {
      bitmap.close();
      throw new Error('surface-standard: OffscreenCanvas 2D context unavailable for screenshot');
    }
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, width, height);
    bitmap.close();
    latest = new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength);
    if (latest.some((value, index) => index % 4 !== 3 && value !== 0)) break;
  }
  return {
    pixels: latest ?? new Uint8Array(width * height * 4),
    width,
    height,
    bytesPerRow: width * 4,
    format: 'rgba8unorm',
  };
}

function hasPixelSignal(readback: SurfaceReadback): boolean {
  for (let offset = 0; offset < readback.pixels.length; offset += 4) {
    if (
      (readback.pixels[offset] ?? 0) !== 0 ||
      (readback.pixels[offset + 1] ?? 0) !== 0 ||
      (readback.pixels[offset + 2] ?? 0) !== 0
    ) {
      return true;
    }
  }
  return false;
}

function samplePresentedPixel(
  readback: SurfaceReadback,
  index: number,
): readonly [number, number, number, number] {
  const startX = Math.floor((index * readback.width) / SURFACE_CASES.length);
  const endX = Math.floor(((index + 1) * readback.width) / SURFACE_CASES.length);
  const candidates: Array<readonly [number, number, number, number]> = [];
  for (let y = 0; y < readback.height; y += 8) {
    for (let x = startX; x < endX; x += 8) {
      const offset = y * readback.bytesPerRow + x * 4;
      const raw = [
        readback.pixels[offset] ?? 0,
        readback.pixels[offset + 1] ?? 0,
        readback.pixels[offset + 2] ?? 0,
        readback.pixels[offset + 3] ?? 0,
      ] as const;
      const rgb = readback.format.startsWith('bgra') ? [raw[2], raw[1], raw[0]] : raw;
      const brightness = rgb[0] + rgb[1] + rgb[2];
      // The screenshot fallback is composited over a white page. Sample the
      // median lit/non-white texel in each cell so a center point landing on
      // that compositor background cannot hide a real Surface difference.
      if (brightness > 0 && brightness < 750) {
        candidates.push([rgb[0], rgb[1], rgb[2], raw[3]]);
      }
    }
  }
  candidates.sort((left, right) => left[0] + left[1] + left[2] - (right[0] + right[1] + right[2]));
  const selected = candidates[Math.floor(candidates.length / 2)];
  if (selected !== undefined) return selected;
  const x = Math.min(
    readback.width - 1,
    Math.max(0, Math.floor(((index + 0.5) * readback.width) / SURFACE_CASES.length)),
  );
  const offset = Math.floor(readback.height / 2) * readback.bytesPerRow + x * 4;
  const raw = [
    readback.pixels[offset] ?? 0,
    readback.pixels[offset + 1] ?? 0,
    readback.pixels[offset + 2] ?? 0,
    readback.pixels[offset + 3] ?? 0,
  ] as const;
  return readback.format.startsWith('bgra') ? [raw[2], raw[1], raw[0], raw[3]] : raw;
}

async function refreshSurfaceCatalog(
  assets: { refreshCatalog(): Promise<boolean>; listCatalog(): readonly unknown[] },
  expectedGuids: readonly string[],
): Promise<readonly unknown[]> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await assets.refreshCatalog();
    const catalog = assets.listCatalog();
    const observed = new Set(
      catalog
        .filter((entry): entry is { guid: string } => {
          return (
            typeof entry === 'object' &&
            entry !== null &&
            'guid' in entry &&
            typeof entry.guid === 'string'
          );
        })
        .map((entry) => entry.guid.toLowerCase()),
    );
    if (expectedGuids.every((guid) => observed.has(guid.toLowerCase()))) return catalog;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return assets.listCatalog();
}

describe('Standard Surface runtime Browser WebGPU provenance', () => {
  let renderer: Renderer | undefined;
  let canvas: HTMLCanvasElement | undefined;

  afterEach(async () => {
    await renderer?.dispose();
    canvas?.remove();
    renderer = undefined;
    canvas = undefined;
  });

  it('loads one published tuple per GUID and renders every cell through Runtime Renderer', {
    // This isolated owner intentionally exercises two full App/device-loss
    // lifecycles after the lane journey. The dedicated 360 s process
    // budget encloses this unchanged 300 s case plus startup and cleanup.
    timeout: 300_000,
  }, async () => {
    if (runtimeBinding === undefined) {
      throw new Error('surface-standard: Pack runtime binding unavailable in Browser Vitest');
    }
    canvas = document.createElement('canvas');
    canvas.id = 'surface-standard-pipeline-test-canvas';
    canvas.width = SURFACE_WIDTH;
    canvas.height = SURFACE_HEIGHT;
    // Keep the full four-cell evidence surface inside the Browser Vitest
    // viewport. Playwright clips an oversized element screenshot to the
    // available viewport, which would otherwise turn the right two cells into
    // compositor-white pixels instead of a real Surface observation.
    const displayWidth = Math.min(SURFACE_WIDTH, Math.max(320, window.innerWidth - 32));
    const displayHeight = Math.round((displayWidth * SURFACE_HEIGHT) / SURFACE_WIDTH);
    canvas.style.width = `${displayWidth}px`;
    canvas.style.height = `${displayHeight}px`;
    document.body.append(canvas);
    const webgpuContext = canvas.getContext('webgpu');
    if (webgpuContext === null) {
      throw new Error('surface-standard: WebGPU canvas context unavailable');
    }
    const bundler = forgeaxBundlerAdapter();
    const vfxHost = createSurfaceSplashRuntimeHost();
    const hostLoss = createSurfaceHostLossInstrumentation();
    const constructed = await constructRuntimeRendererHost(
      canvas,
      { features: [vfxHost.feature], rhiInstrumentation: hostLoss.instrumentation },
      {
        ...bundler,
        importTransport: createRuntimeAssetImportTransport(runtimeBinding),
      },
    );
    expect(constructed.ok).toBe(true);
    if (!constructed.ok) throw constructed.error;
    const runtimeHost = constructed.value;
    renderer = runtimeHost.renderer;
    const assets = runtimeHost.assets;
    assets.configureRuntimeBinding(runtimeBinding);
    const catalog = (await refreshSurfaceCatalog(
      assets,
      SURFACE_CASES.map((surfaceCase) => surfaceCase.guid),
    )) as readonly {
      guid: string;
      sourceKey?: string;
      packageUrl?: string;
    }[];
    const seenGuids = new Set<string>();
    const materials: MaterialAsset[] = [];
    const publications = [];
    for (const surfaceCase of SURFACE_CASES) {
      const row = catalog.find((entry) => entry.guid.toLowerCase() === surfaceCase.guid);
      expect(row?.sourceKey).toBe(surfaceCase.sourceKey);
      expect(row?.packageUrl).toBeTruthy();
      const packageResponse = await fetch(row?.packageUrl ?? '');
      expect(packageResponse.ok).toBe(true);
      const packageBody = await packageResponse.json();
      const publication = packageBody as {
        generation?: unknown;
        digest?: unknown;
      };
      expect(Number.isSafeInteger(publication.generation)).toBe(true);
      expect(typeof publication.digest).toBe('string');
      const loaded = await assets.loadByGuid<MaterialAsset>(parseSurfaceGuid(surfaceCase.guid));
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) throw loaded.error;
      const material = assertMaterialPayload(surfaceCase, loaded.value);
      const projection = assets.getMaterialProjectionForPayload(material);
      if (surfaceCase.id.startsWith('custom-') || surfaceCase.id.startsWith('water-')) {
        expect(projection?.specializationKey).toBeTruthy();
        const programKeys =
          projection?.passes.flatMap((pass) =>
            pass.programs.map((program) => program.specializationKey),
          ) ?? [];
        expect(programKeys.length).toBeGreaterThan(0);
        for (const specializationKey of new Set(programKeys)) {
          expect(assets.getMaterialArtifact(specializationKey)).toBeDefined();
        }
      }
      materials.push(material);
      publications.push({ surfaceCase, row, publication, material });
      seenGuids.add(surfaceCase.guid);
    }
    const verifyAppLifecycle = async (queueVfxContinuationDuringLoss = false) => {
      const evidence = await runSurfaceAppLifecycle({
        renderer,
        materials,
        assets,
        vfxHost,
        hostLossSignals: hostLoss.signals,
        queueVfxContinuationDuringLoss,
      });
      expect(evidence.impactIds).toEqual([701, 702]);
      expect(evidence.emittedSplashCount).toBe(2);
      expect(
        evidence.splashIntents.every((intent) => intent.reset && intent.spawnCount === 8),
      ).toBe(true);
      expect(evidence.duplicateImpactCount).toBe(1);
      expect(evidence.cameraCoverageTransitions).toBe(2);
      expect(evidence.completedFrames).toBe(evidence.submittedFrames);
      expect(evidence.splashRendererKinds).toEqual(['billboard']);
      expect(evidence.activeVfxPlayerCount).toBe(2);
      expect(evidence.expiredVfxPlayerCount).toBe(0);
      expect(evidence.paused).toEqual(evidence.active);
      expect(evidence.resumed.frameId).toBeGreaterThan(evidence.active.frameId);
      expect(evidence.preLoss.frameId).toBeGreaterThan(evidence.resumed.frameId);
      expect(evidence.recovered.frameId).toBeGreaterThan(evidence.preLoss.frameId);
      expect(evidence.recovered.label).toBe('recovered');
      expect(evidence.deviceRecovery.newGeneration).toBeGreaterThan(
        evidence.deviceRecovery.oldGeneration,
      );
      expect(evidence.deviceRecovery.staleObservationErrorCode).toBe('frame-receipt-stale');
      expect(evidence.deviceRecovery.lateObservationErrorCode).toBe(
        queueVfxContinuationDuringLoss ? 'frame-receipt-stale' : 'device-operation-failed',
      );
      if (queueVfxContinuationDuringLoss) {
        expect(evidence.deviceRecovery.observationResourcesBeforeLoss).toBe(0);
      } else {
        expect(evidence.deviceRecovery.observationResourcesBeforeLoss).toBeGreaterThan(0);
      }
      expect(evidence.deviceRecovery.observationResourcesAfterRecovery).toBe(0);
      expect(evidence.deviceRecovery.eventAgeBeforeLoss).toBeLessThan(0.34);
      expect(evidence.deviceRecovery.eventAgeAfterRecovery).toBe(
        evidence.deviceRecovery.eventAgeBeforeLoss,
      );
      if (queueVfxContinuationDuringLoss) {
        expect(evidence.deviceRecovery.queuedContinuationsBeforeLoss).toHaveLength(2);
        expect(evidence.deviceRecovery.vfxQueueSequencesBeforeLoss).toHaveLength(2);
        expect(evidence.deviceRecovery.vfxQueueSequencesAfterRecovery).toEqual([]);
        for (const queued of evidence.deviceRecovery.queuedContinuationsBeforeLoss) {
          const player = evidence.deviceRecovery.vfxPlayersAfterRecovery.find(
            (candidate) => candidate.player === queued.player,
          );
          expect(player?.lastCommitted).toMatchObject({
            sequence: queued.sequence,
            phaseTick: queued.phaseTick,
            playCycle: queued.playCycle,
            reset: false,
          });
        }
      } else {
        expect(
          evidence.deviceRecovery.vfxPlayersAfterRecovery.map((player) => ({
            player: player.player,
            lastCommitted: player.lastCommitted,
            sessions: player.sessions,
          })),
        ).toEqual(
          evidence.deviceRecovery.vfxPlayersBeforeLoss.map((player) => ({
            player: player.player,
            lastCommitted: player.lastCommitted,
            sessions: player.sessions,
          })),
        );
        expect(evidence.deviceRecovery.vfxQueueSequencesBeforeLoss).toEqual([]);
        expect(evidence.deviceRecovery.vfxQueueSequencesAfterRecovery).toEqual([]);
      }
      expect(evidence.deviceRecovery.vfxHostGenerationAfterRecovery).toBe(
        evidence.deviceRecovery.vfxHostGenerationBeforeLoss,
      );
      expect(evidence.deviceRecovery.vfxRenderGenerationAfterRecovery).toBeGreaterThanOrEqual(
        evidence.deviceRecovery.vfxRenderGenerationBeforeLoss,
      );
      expect(evidence.coverageClipped.frameId).toBeGreaterThan(evidence.resumed.frameId);
      expect(evidence.expired.frameId).toBeGreaterThan(evidence.coverageClipped.frameId);
      expect(evidence.comparisons.activeSplash.failedPixelCount).toBeGreaterThan(0);
      expect(evidence.comparisons.preLossSplash.failedPixelCount).toBeGreaterThan(0);
      expect(evidence.comparisons.recoveredSplash.failedPixelCount).toBeGreaterThan(0);
      if (!queueVfxContinuationDuringLoss) {
        expect(evidence.comparisons.recoverySplashParity.failedPixelCount).toBe(0);
        expect(evidence.comparisons.recoverySplashParity.maxError).toBeLessThanOrEqual(0.05);
      }
      expect(evidence.comparisons.expiredSplash.failedPixelCount).toBe(0);
      expect(evidence.comparisons.activeWaterB.failedPixelCount).toBe(0);
      expect(evidence.comparisons.resumedWaterB.failedPixelCount).toBe(0);
      expect(evidence.resumedEventAge).toBeGreaterThanOrEqual(0);
      expect(evidence.expiredEventAge).toBeGreaterThan(evidence.resumedEventAge);
      // biome-ignore lint/suspicious/noConsole: App/World/Surface/VFX lifecycle evidence is the test artifact.
      console.log(
        JSON.stringify({
          kind: 'surface-water-app-lifecycle',
          backend: 'browser-webgpu',
          queueVfxContinuationDuringLoss,
          ...evidence,
        }),
      );
      return evidence;
    };
    if (import.meta.env.VITE_FORGEAX_SURFACE_APP_LIFECYCLE_ONLY === '1') {
      await verifyAppLifecycle();
      await verifyAppLifecycle(true);
      return;
    }
    const opticalEvidence = await runSurfaceOpticalOracle(renderer, assets);
    expect(opticalEvidence.observation.format).toBe('rgba16float');
    expect(opticalEvidence.observation.frameId).toBe(opticalEvidence.receipt.frameId);
    expect(opticalEvidence.records.every((record) => record.maxError <= 0.05)).toBe(true);
    // biome-ignore lint/suspicious/noConsole: linear HDR oracle evidence is the test artifact.
    console.log(
      JSON.stringify({
        kind: 'surface-water-linear-hdr-optical-oracle',
        backend: 'browser-webgpu',
        ...opticalEvidence,
        records: opticalEvidence.records.map(({ samples: _samples, ...record }) => record),
      }),
    );
    const msaaEdgeEvidence = await runSurfaceMsaaEdgeOracle(renderer, assets, {
      get width() {
        return canvas?.width ?? SURFACE_WIDTH;
      },
      get height() {
        return canvas?.height ?? SURFACE_HEIGHT;
      },
      setBackingSize(width, height) {
        if (canvas === undefined) throw new Error('surface-msaa-edge: Browser canvas unavailable');
        canvas.width = width;
        canvas.height = height;
      },
    });
    expect(msaaEdgeEvidence.witnesses).toHaveLength(5);
    expect(
      msaaEdgeEvidence.witnesses.every(
        (witness) =>
          witness.eligiblePixelCount > 0 &&
          witness.failedPixelCount === 0 &&
          witness.maxError <= 0.05,
      ),
    ).toBe(true);
    expect(
      msaaEdgeEvidence.witnesses.filter(
        (witness) => witness.resolveExpectation === 'nearest-opaque-pair',
      ),
    ).toHaveLength(2);
    expect(msaaEdgeEvidence.movementWitnessCount).toBe(15);
    expect(msaaEdgeEvidence.resizedWitnessCount).toBe(5);
    expect(msaaEdgeEvidence.fourX).toHaveLength(3);
    expect(msaaEdgeEvidence.resized.fourX.observation.width).toBeGreaterThan(SURFACE_WIDTH);
    // biome-ignore lint/suspicious/noConsole: receipt-bound edge evidence is the test artifact.
    console.log(
      JSON.stringify({
        kind: 'surface-water-msaa-edge-oracle',
        backend: 'browser-webgpu',
        ...msaaEdgeEvidence,
      }),
    );
    const world = new World();
    const { mediumMembers, probeDomains } = populateSurfaceWorld(
      world,
      materials,
      createSurfaceWaterInstanceTransforms(),
      { msaa4x: import.meta.env.VITE_FORGEAX_SURFACE_MSAA4X === '1' },
    );
    const surfaceDynamicInput = createSurfaceDynamicInput(
      materials,
      mediumMembers,
      renderer.inspect().frame.deviceGeneration,
    );
    const renderErrors: Array<{ code: string; detail?: unknown; hint?: string }> = [];
    const unsubscribeRenderErrors = renderer.subscribe((event) => {
      if (event.kind === 'error') {
        renderErrors.push({
          code: event.error.code,
          detail: event.error.detail,
          hint: event.error.hint,
        });
      }
    });
    const attached = renderer?.attach(world);
    if (attached === undefined) throw new Error('surface-standard: renderer unavailable');
    expect(attached.ok).toBe(true);
    if (!attached.ok) throw attached.error;
    // Standard material pipelines are compiled lazily on their first use. Keep
    // submitting frames until the renderer has had a chance to publish the
    // ready PSOs before inspecting the presented surface.
    let completedFrames = 0;
    let finalReceipt: FrameReceipt | undefined;
    const laneRois = new Map<number, readonly (readonly [number, number, number, number])[]>();
    const laneReceipts = new Map<
      number,
      NonNullable<ReturnType<Renderer['inspect']>['renderScene']['submission']>
    >();
    // Retain the first 50 lightweight frames and every later time/revision boundary.
    const frameIndices =
      import.meta.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1'
        ? [
            ...Array.from({ length: 50 }, (_, frame) => frame),
            50,
            74,
            99,
            100,
            124,
            149,
            150,
            249,
            250,
            299,
          ]
        : Array.from({ length: 300 }, (_, frame) => frame);
    for (const frame of frameIndices) {
      const pausedTime = 100 / 60;
      const frameTime =
        frame < 50 ? 0.5 : frame < 100 ? frame / 60 : frame < 150 ? pausedTime : (frame - 50) / 60;
      if (frame === 30) {
        world
          .set(probeDomains[0].entity, LightProbe, {
            irradiance: probeDomains[1].irradiance,
            radius: 1.0,
          })
          .unwrap();
        world
          .set(probeDomains[1].entity, LightProbe, {
            irradiance: probeDomains[0].irradiance,
            radius: 1.0,
          })
          .unwrap();
      } else if (frame === 40) {
        world
          .set(probeDomains[0].entity, LightProbe, {
            irradiance: probeDomains[0].irradiance,
            radius: 1.0,
          })
          .unwrap();
        world
          .set(probeDomains[1].entity, LightProbe, {
            irradiance: probeDomains[1].irradiance,
            radius: 1.0,
          })
          .unwrap();
      }
      renderer.setSurfaceDynamicInput({
        ...surfaceDynamicInput,
        ranges:
          frame >= 30 && frame < 250
            ? [...surfaceDynamicInput.ranges].reverse()
            : frame < 250
              ? surfaceDynamicInput.ranges
              : [],
        projectionRevision: frame < 30 ? 1 : frame < 250 ? 2 : 3,
        frameTime,
      });
      world.update(1 / 60).unwrap();
      const drawn = renderer.draw({
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
        ...(frame < 10 || (frame >= 20 && frame < 30) ? { geometryLane: 'direct' as const } : {}),
      });
      expect(drawn.ok).toBe(true);
      if (!drawn.ok) throw drawn.error;
      finalReceipt = drawn.value;
      const completion = await drawn.value.completed;
      expect(completion.ok).toBe(true);
      if (!completion.ok) throw completion.error;
      completedFrames += 1;
      if ([9, 19, 29, 39, 49].includes(frame)) {
        const laneObservation = await renderer.observe(drawn.value, { include: ['draws'] });
        expect(laneObservation.ok).toBe(true);
        if (!laneObservation.ok) throw laneObservation.error;
        const receipt = renderer.inspect().renderScene.submission;
        if (receipt === undefined) throw new Error('surface-standard: lane receipt unavailable');
        laneReceipts.set(frame, receipt);
        const laneReadback = await readScreenshotPixels(canvas);
        laneRois.set(
          frame,
          [SURFACE_CASES.length - 2, SURFACE_CASES.length - 1].map((index) =>
            samplePresentedPixel(laneReadback, index),
          ),
        );
      }
    }
    expect(completedFrames).toBe(frameIndices.length);
    if (finalReceipt === undefined) throw new Error('surface-standard: final receipt unavailable');
    const finalObservation = await renderer.observe(finalReceipt, { include: ['draws'] });
    expect(finalObservation.ok).toBe(true);
    if (!finalObservation.ok) throw finalObservation.error;
    const observed = renderer.inspect();
    expect(observed.renderScene.submission).toMatchObject({
      requestedLane: 'gpu-driven',
      actualLane: 'gpu-driven',
      status: 'completed',
      passes: [
        { pass: 'nearest-layer', memberEvidence: 'indirect-visible-readback' },
        { pass: 'color', memberEvidence: 'indirect-visible-readback' },
      ],
    });
    expect(
      observed.renderScene.submission?.passes.every(
        (pass) =>
          (pass.memberIds?.length ?? 0) === mediumMembers.length &&
          new Set(pass.memberIds).size === mediumMembers.length,
      ),
    ).toBe(true);
    expect(observed.renderScene.submission?.passes[0]?.memberIds).toEqual(
      observed.renderScene.submission?.passes[1]?.memberIds,
    );
    expect(laneReceipts.get(9)).toMatchObject({ actualLane: 'direct', status: 'completed' });
    expect(laneReceipts.get(19)).toMatchObject({
      actualLane: 'gpu-driven',
      status: 'completed',
      passes: [
        { pass: 'nearest-layer', memberEvidence: 'indirect-visible-readback' },
        { pass: 'color', memberEvidence: 'indirect-visible-readback' },
      ],
    });
    expect(laneReceipts.get(29)).toMatchObject({ actualLane: 'direct', status: 'completed' });
    const expectedMemberIds = mediumMembers
      .map((member) =>
        JSON.stringify([
          member.worldIdentity,
          member.entityKey,
          member.drawItemIndex,
          member.instanceOrdinal,
        ]),
      )
      .sort();
    const gpuReceipt = laneReceipts.get(19);
    expect([...(gpuReceipt?.passes[0]?.memberIds ?? [])].sort()).toEqual(expectedMemberIds);
    expect(
      gpuReceipt?.passes.every((pass) =>
        pass.commands.every(
          (command) =>
            (command.kind === 'draw-indirect' || command.kind === 'draw-indexed-indirect') &&
            command.programEvidence === 'producer-receipt' &&
            command.receiptIdentity !== undefined &&
            command.receiptGeneration !== undefined,
        ),
      ),
    ).toBe(true);
    const directMemberIds = [
      ...new Set(
        (laneReceipts.get(29)?.passes ?? []).flatMap((pass) =>
          pass.commands.flatMap((command) =>
            command.kind === 'draw' || command.kind === 'draw-indexed' ? command.memberIds : [],
          ),
        ),
      ),
    ].sort();
    expect(directMemberIds).toEqual(expectedMemberIds);
    expect(directMemberIds).toEqual([...(gpuReceipt?.passes[0]?.memberIds ?? [])].sort());
    const directCommands = laneReceipts
      .get(29)
      ?.passes.flatMap((pass) => pass.commands)
      .filter((command) => command.kind === 'draw' || command.kind === 'draw-indexed');
    expect(
      directCommands?.every(
        (command) =>
          command.programEvidence === 'producer-receipt' &&
          command.receiptIdentity !== undefined &&
          command.receiptGeneration !== undefined,
      ),
    ).toBe(true);
    expect(
      directCommands?.some(
        (command) =>
          command.surfaceFrameBase > 0 &&
          command.firstInstance === 0 &&
          command.memberIds.some((member) => {
            const identity = JSON.parse(member) as readonly unknown[];
            return identity[2] === 1 && identity[3] === 1;
          }),
      ),
    ).toBe(true);
    expect([9, 19, 29].map((frame) => laneReceipts.get(frame)?.frameId)).toEqual([
      msaaEdgeEvidence.resized.fourX.receipt.frameId + 10,
      msaaEdgeEvidence.resized.fourX.receipt.frameId + 20,
      msaaEdgeEvidence.resized.fourX.receipt.frameId + 30,
    ]);
    const directCold = laneRois.get(9);
    const gpu = laneRois.get(19);
    const directRestored = laneRois.get(29);
    if (directCold === undefined || gpu === undefined || directRestored === undefined) {
      throw new Error('surface-standard: Browser lane ROI unavailable');
    }
    const roiDistance = (
      left: readonly (readonly number[])[],
      right: readonly (readonly number[])[],
    ) =>
      Math.max(
        ...left.flatMap((sample, sampleIndex) =>
          sample
            .slice(0, 3)
            .map((value, channel) => Math.abs(value - (right[sampleIndex]?.[channel] ?? 0)) / 255),
        ),
      );
    expect(roiDistance(directCold, gpu)).toBeLessThanOrEqual(SURFACE_PIXEL_EPSILON);
    expect(roiDistance(gpu, directRestored)).toBeLessThanOrEqual(SURFACE_PIXEL_EPSILON);
    expect(laneRois.get(39)).not.toEqual(directRestored);
    expect(laneRois.get(49)).toEqual(directRestored);
    expect(renderErrors).toHaveLength(0);
    const probeRecords = observed.renderScene.probeBlend?.records.filter(
      (record) => record.accepted,
    );
    expect(probeRecords?.length).toBeGreaterThanOrEqual(2);
    expect(new Set(probeRecords?.map((record) => record.objectKey)).size).toBe(
      probeRecords?.length,
    );
    expect(probeRecords?.every((record) => record.generation >= 0)).toBe(true);
    expect(new Set(probeRecords?.map((record) => JSON.stringify(record.shPreblend))).size).toBe(
      probeRecords?.length,
    );
    expect(observed.perFramePassNames.some((name) => name.toLowerCase().includes('shadow'))).toBe(
      true,
    );
    expect(observed.perFramePassNames).toContain('main');
    const screenshotReadback = await readScreenshotPixels(canvas);
    expect(hasPixelSignal(screenshotReadback)).toBe(true);
    const readback = screenshotReadback;
    const records = publications.map(({ surfaceCase, row, publication, material }, index) => {
      const samples = samplePresentedPixel(readback, index);
      const program = material.passes?.[0]?.program;
      expect(samples[3]).toBeGreaterThan(0);
      expect(samples[0] + samples[1] + samples[2]).toBeGreaterThan(0);
      return {
        id: surfaceCase.id,
        materialGuid: surfaceCase.guid,
        sourceKey: row?.sourceKey,
        publicationGeneration: publication.generation,
        publicationDigest: publication.digest,
        closure: SURFACE_CLOSURE,
        rootPlan: surfaceCase.rootPlan,
        pass: surfaceCase.pass,
        actualPasses: material.passes?.map((entry) => entry.name),
        selectedEntries: material.passes?.map((entry) => ({
          name: entry.name,
          fragmentEntry: entry.program.fragmentEntry,
          lightMode: (entry.renderState?.tags as Record<string, string> | undefined)?.LightMode,
        })),
        cookIdentity: publication.digest,
        programIdentity: program?.module ?? 'unavailable',
        pipelineIdentity: `${surfaceCase.pass}:${surfaceCase.rootPlan}:${program?.module ?? 'unavailable'}`,
        sourceClosure: surfaceCase.sourceClosure,
        samples,
        frameId: observed.observation.frameId,
        backend: observed.capabilities.backendKind,
        artifact: row?.packageUrl,
        provenance: {
          sourceSha: EVIDENCE_SOURCE_SHA,
          buildId: EVIDENCE_BUILD_ID,
          frameId: observed.observation.frameId,
          artifact: row?.packageUrl,
          readbackKind: 'compositor-screenshot',
          readbackFormat: readback.format,
          readbackWidth: readback.width,
          readbackHeight: readback.height,
          clearColor: [0, 0, 0, 1],
          closure: SURFACE_CLOSURE,
          rootPlan: surfaceCase.rootPlan,
          pass: surfaceCase.pass,
          actualPasses: material.passes?.map((entry) => entry.name),
          selectedEntries: material.passes?.map((entry) => ({
            name: entry.name,
            fragmentEntry: entry.program.fragmentEntry,
            lightMode: (entry.renderState?.tags as Record<string, string> | undefined)?.LightMode,
          })),
          cookIdentity: publication.digest,
          programIdentity: program?.module ?? 'unavailable',
          pipelineIdentity: `${surfaceCase.pass}:${surfaceCase.rootPlan}:${program?.module ?? 'unavailable'}`,
          sourceClosure: surfaceCase.sourceClosure,
          lane: 'browser-webgpu',
        },
      };
    });
    expect(seenGuids).toHaveLength(6);
    expect(records).toHaveLength(6);
    assertSurfacePixelFalsification(records);
    expect(records.every((record) => record.backend === 'webgpu')).toBe(true);
    await verifyAppLifecycle();
    await verifyAppLifecycle(true);
    // biome-ignore lint/suspicious/noConsole: runtime provenance is the test artifact.
    console.log(JSON.stringify({ backend: 'browser-webgpu', lane: 'runtime', records }));
    surfaceDynamicInput.page.release().unwrap();
    expect(surfaceDynamicInput.page.writeRecord(0, {})).toMatchObject({
      ok: false,
      error: { code: 'released' },
    });
    unsubscribeRenderErrors();
  });
});

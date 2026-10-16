import { createCatalogSource } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack';
import {
  type FrameReceipt,
  type FrameReceiptObservation,
  MeshRenderer,
  type ReadonlyDynamicInputPage,
  type RenderWorldLease,
  type SurfaceDynamicInputFrame,
} from '@forgeax/engine-render';
import type {
  CatalogDelta,
  MaterialAsset,
  PackIndexEntry,
  RuntimeAssetBinding,
} from '@forgeax/engine-types';
import {
  type CatalogHotChannel,
  createCatalogClient,
} from '@forgeax/engine-vite-plugin-pack/catalog-client';
import { expect } from 'vitest';
import { loadBackendPack } from '../backend-selection';
import { createDevImportTransport } from '../dev-import-transport';
import { constructRuntimeRendererHost } from '../renderer-host';
import type { SurfaceMaterialPublicationValue } from './material-publication.server';
import {
  compareSurfaceAppLifecycleRois,
  createSurfaceAppLifecycleMask,
  readSurfaceAppLifecycleRoi,
  type SurfaceAppLifecycleRoi,
} from './surface-app-lifecycle-oracle';
import {
  createSurfaceDynamicInput,
  populateSurfaceWorld,
} from './surface-standard-pipeline.runtime-fixture';

type FrameDomainObservation = NonNullable<FrameReceiptObservation['observations']>[number];

const surfacePassNames = ['nearest-layer', 'color'] as const;
type SurfacePassName = (typeof surfacePassNames)[number];
type SurfacePassMemberIds = Readonly<Record<SurfacePassName, readonly string[]>>;

function collectSurfacePassMemberIds(
  submission:
    | {
        readonly passes: readonly {
          readonly pass: SurfacePassName;
          readonly memberIds?: readonly string[];
          readonly commands: readonly {
            readonly memberIds?: readonly string[];
          }[];
        }[];
      }
    | undefined,
): SurfacePassMemberIds {
  const result: Record<SurfacePassName, readonly string[]> = {
    'nearest-layer': [],
    color: [],
  };
  for (const pass of submission?.passes ?? []) {
    result[pass.pass] =
      pass.memberIds ?? pass.commands.flatMap((command) => command.memberIds ?? []);
  }
  return result;
}

function expectSurfaceMemberMultisetsEqual(
  direct: SurfacePassMemberIds,
  gpu: SurfacePassMemberIds,
  label: string,
): void {
  for (const pass of surfacePassNames) {
    expect(
      [...gpu[pass]].sort(),
      `${label} ${pass} GPU member IDs differ from direct command IDs`,
    ).toEqual([...direct[pass]].sort());
  }
}

const inspect = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    item instanceof Error ? { ...item, message: item.message } : item,
  );

interface CatalogSnapshot {
  readonly authority: string;
  readonly entries: readonly PackIndexEntry[];
  readonly diagnostics?: readonly unknown[];
}

function createNestedViteHotChannel(
  baseUrl: string,
  token: string,
): {
  readonly channel: CatalogHotChannel;
  readonly ready: Promise<void>;
  readonly close: () => void;
} {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', token);
  const socket = new WebSocket(url, 'vite-hmr');
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('nested Vite HMR socket timed out')), 10_000);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('nested Vite HMR socket failed'));
    });
  });
  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return;
    const message = JSON.parse(event.data) as {
      readonly type?: string;
      readonly event?: string;
      readonly data?: unknown;
    };
    if (message.type !== 'custom' || message.event === undefined) return;
    for (const listener of listeners.get(message.event) ?? []) listener(message.data);
  });
  return {
    channel: {
      on(event, listener) {
        const eventListeners = listeners.get(event) ?? new Set();
        eventListeners.add(listener);
        listeners.set(event, eventListeners);
      },
      off(event, listener) {
        listeners.get(event)?.delete(listener);
      },
    },
    ready,
    close: () => socket.close(),
  };
}

export async function verifySurfaceMaterialPublication(options: {
  readonly binding: RuntimeAssetBinding;
  readonly baseUrl?: string;
  readonly hmrToken?: string;
  readonly guid: string;
  readonly shaderManifestUrl: string;
  readonly lane?: 'direct' | 'gpu-driven';
  readonly update: (value: SurfaceMaterialPublicationValue) => Promise<void>;
}) {
  let target: GPUTexture | undefined;
  const canvas = {
    width: 64,
    height: 64,
    getContext: () => ({
      configure(config: GPUCanvasConfiguration) {
        target = config.device.createTexture({
          size: [64, 64],
          format: config.format,
          viewFormats: [config.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
      },
      unconfigure() {},
      getCurrentTexture: () => target,
    }),
    addEventListener() {},
    removeEventListener() {},
  };
  const backend = await loadBackendPack({});
  if (!backend.ok) throw backend.error;
  const constructed = await constructRuntimeRendererHost(
    canvas,
    { rhi: backend.value.rhi },
    {
      shaderManifestUrl: options.shaderManifestUrl,
      importTransport: createDevImportTransport(options.binding),
    },
  );
  if (!constructed.ok) throw constructed.error;
  const { assets, renderer } = constructed.value;
  const renderErrors: unknown[] = [];
  const stopRenderer = renderer.subscribe((event) => {
    if (event.kind === 'error') renderErrors.push(event.error);
  });
  assets.configureRuntimeBinding(options.binding);
  const readCatalog = async (): Promise<CatalogSnapshot> => {
    const response = await fetch(options.binding.catalogUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Surface Catalog HTTP ${response.status}`);
    return (await response.json()) as CatalogSnapshot;
  };
  const hot =
    options.baseUrl === undefined || options.hmrToken === undefined
      ? undefined
      : createNestedViteHotChannel(options.baseUrl, options.hmrToken);
  if (hot !== undefined) await hot.ready;
  const catalogClient = createCatalogClient(
    async () => (await readCatalog()).entries,
    hot?.channel,
  );
  assets.setCatalogSource(
    createCatalogSource({
      url: options.binding.catalogUrl,
      expectedScope: options.binding,
      subscribe: catalogClient.subscribe,
    }),
  );
  const deltas: CatalogDelta[] = [];
  const stopCatalog = assets.subscribeCatalog((delta) => deltas.push(delta));
  const world = new World();
  let lease: RenderWorldLease | undefined;
  const pages: ReadonlyDynamicInputPage[] = [];
  try {
    const initial = await assets.enumerateCatalog();
    expect(initial.ok, inspect(initial)).toBe(true);
    const baselineCatalog = await readCatalog();
    expect(baselineCatalog.authority, inspect(baselineCatalog)).toBe('authoritative');
    const baselineRow = baselineCatalog.entries.find((row) => row.guid === options.guid);
    if (baselineRow === undefined) throw new Error('Surface baseline Catalog row is absent');
    const parsed = AssetGuid.parse(options.guid);
    if (!parsed.ok) throw parsed.error;
    const load = async (): Promise<MaterialAsset> => {
      const result = await assets.loadByGuid<MaterialAsset>(parsed.value);
      if (!result.ok) throw result.error;
      return result.value;
    };
    const baseline = await load();
    const baselineProjection = assets.getMaterialProjectionForPayload(baseline);
    if (baselineProjection?.surface?.dynamicInput === undefined) {
      throw new Error('Surface baseline projection has no dynamic schema');
    }
    const { mediumMembers } = populateSurfaceWorld(world, [baseline, baseline]);
    const attached = renderer.attach(world);
    if (!attached.ok) throw attached.error;
    lease = attached.value;
    const uniqueEntities = [...new Set(mediumMembers.map((member) => member.entityKey))];
    const installMaterial = (material: MaterialAsset): void => {
      const handle = world.internSharedRef('MaterialAsset', material);
      for (const entity of uniqueEntities) {
        const slotCount =
          Math.max(
            ...mediumMembers
              .filter((member) => member.entityKey === entity)
              .map((member) => member.drawItemIndex),
          ) + 1;
        world
          .set(entity, MeshRenderer, { materials: Array.from({ length: slotCount }, () => handle) })
          .unwrap();
      }
    };
    const dynamicInputFor = (material: MaterialAsset): SurfaceDynamicInputFrame => {
      const input = createSurfaceDynamicInput(
        [material, material],
        mediumMembers,
        renderer.inspect().frame.deviceGeneration,
      );
      pages.push(input.page);
      return { ...input, frameTime: 0.9 };
    };
    const masks = [0, 1].map((cellIndex) =>
      createSurfaceAppLifecycleMask({
        width: 64,
        height: 64,
        cellIndex,
        cellCount: 2,
      }),
    );
    const publicationLane = options.lane ?? 'direct';
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
    const draw = (
      material: MaterialAsset,
      input: SurfaceDynamicInputFrame,
      armObservation: boolean,
      lane: 'direct' | 'gpu-driven' = publicationLane,
    ): FrameReceipt => {
      installMaterial(material);
      renderer.setSurfaceDynamicInput(input);
      world.update(0).unwrap();
      if (armObservation) renderer.requestObservation(['linear-hdr']).unwrap();
      const drawn = renderer.draw({
        leases: [lease as RenderWorldLease],
        camera: { lease: lease as RenderWorldLease },
        environment: { lease: lease as RenderWorldLease },
        ...(lane === 'direct' ? { geometryLane: 'direct' as const } : {}),
      });
      if (!drawn.ok) throw drawn.error;
      return drawn.value;
    };
    const awaitCompletion = async (receipt: FrameReceipt): Promise<FrameReceipt> => {
      const completed = await receipt.completed;
      if (!completed.ok) throw completed.error;
      return receipt;
    };
    const submit = (
      material: MaterialAsset,
      input: SurfaceDynamicInputFrame,
      armObservation: boolean,
    ): Promise<FrameReceipt> => awaitCompletion(draw(material, input, armObservation));
    const readObservationRois = (
      observation: FrameDomainObservation,
    ): readonly [SurfaceAppLifecycleRoi, SurfaceAppLifecycleRoi] => {
      const readback = {
        bytes: observation.bytes,
        width: observation.metadata.width,
        height: observation.metadata.height,
        bytesPerRow: observation.metadata.bytesPerRow,
        format: observation.metadata.format,
      };
      return [
        readSurfaceAppLifecycleRoi(readback, masks[0] ?? []),
        readSurfaceAppLifecycleRoi(readback, masks[1] ?? []),
      ];
    };
    const capture = async (
      material: MaterialAsset,
      input: SurfaceDynamicInputFrame,
      projection: typeof baselineProjection,
      onFirstSubmitted?: (receipt: FrameReceipt) => void,
      lane: 'direct' | 'gpu-driven' = publicationLane,
    ): Promise<{
      readonly receipt: FrameReceipt;
      readonly observation: FrameDomainObservation;
      readonly rois: readonly [SurfaceAppLifecycleRoi, SurfaceAppLifecycleRoi];
      readonly memberIdsByPass: SurfacePassMemberIds;
    }> => {
      let receipt: FrameReceipt | undefined;
      for (let frame = 0; frame < 12; frame += 1) {
        const submitted = draw(material, input, frame === 11, lane);
        if (frame === 0) onFirstSubmitted?.(submitted);
        receipt = await awaitCompletion(submitted);
      }
      if (receipt === undefined) throw new Error('Surface HMR frame receipt unavailable');
      const observed = await renderer.observe(receipt, { include: ['linear-hdr', 'draws'] });
      if (!observed.ok) throw observed.error;
      const observation = observed.value.observations?.find(
        (candidate) => candidate.domain === 'linear-hdr',
      );
      if (observation === undefined) throw new Error('Surface HMR HDR observation unavailable');
      expect(observation.metadata.frameId).toBe(receipt.frameId);
      expect(observation.metadata.deviceGeneration).toBe(receipt.deviceGeneration);
      const submission = renderer.inspect().renderScene.submission;
      expect(submission).toMatchObject({
        status: 'completed',
        frameId: receipt.frameId,
        deviceGeneration: receipt.deviceGeneration,
        graphGeneration: receipt.graphGeneration,
        requestedLane: lane,
        actualLane: lane,
      });
      expect(submission?.passes.map((pass) => pass.pass)).toEqual(['nearest-layer', 'color']);
      const commands = submission?.passes.flatMap((pass) => pass.commands) ?? [];
      expect(commands.length).toBeGreaterThan(0);
      expect(commands.every((command) => command.programEvidence === 'producer-receipt')).toBe(
        true,
      );
      const selectedArtifact = renderer.inspect().renderScene.gpuDriven.surfaceArtifact;
      if (selectedArtifact === undefined) {
        throw new Error('Surface HMR selected artifact receipt unavailable');
      }
      expect(
        projection.passes
          .flatMap((pass) => pass.programs)
          .some((program) => program.specializationKey === selectedArtifact.specializationKey),
      ).toBe(true);
      if (lane === 'gpu-driven') {
        expect(submission?.resourceGeneration).toBeGreaterThan(0);
        expect(
          submission?.passes.every(
            (pass) =>
              pass.memberEvidence === 'indirect-visible-readback' &&
              [...(pass.memberIds ?? [])].sort().join('\n') === expectedMemberIds.join('\n'),
          ),
        ).toBe(true);
        for (const pass of submission?.passes ?? []) {
          const invalidParameters = (pass.indirectParameters ?? []).filter(
            (parameter) =>
              parameter.sequence !== submission?.sequence ||
              parameter.frameId !== submission?.frameId ||
              parameter.deviceGeneration !== submission?.deviceGeneration ||
              parameter.resourceGeneration !== submission?.resourceGeneration ||
              parameter.viewIdentity !== submission?.viewIdentity ||
              parameter.pass !== pass.pass,
          );
          expect(
            invalidParameters,
            `${pass.pass} indirect words were not bound to the published submission fence: ${inspect(
              {
                submission,
                pass,
                invalidParameters,
              },
            )}`,
          ).toHaveLength(0);
        }
        expect(
          commands.every(
            (command) =>
              (command.kind === 'draw-indirect' || command.kind === 'draw-indexed-indirect') &&
              command.indirectBufferIdentity > 0 &&
              command.indirectOffset >= 0 &&
              command.pipelineIdentity > 0,
          ),
        ).toBe(true);
      } else {
        expect(
          commands.every((command) => command.kind === 'draw' || command.kind === 'draw-indexed'),
        ).toBe(true);
      }
      const memberIdsByPass = collectSurfacePassMemberIds(submission);
      for (const pass of surfacePassNames) {
        expect(
          [...memberIdsByPass[pass]].sort(),
          `${lane} ${pass} command member IDs did not cover the Surface selection`,
        ).toEqual(expectedMemberIds);
      }
      expect(
        commands.every(
          (command) =>
            command.receiptIdentity === selectedArtifact.receiptIdentity &&
            command.receiptGeneration === selectedArtifact.receiptGeneration,
        ),
        inspect({
          commands,
          selectedArtifact,
          publicationGeneration: projection.publicationGeneration,
        }),
      ).toBe(true);
      return {
        receipt,
        observation,
        rois: readObservationRois(observation),
        memberIdsByPass,
      };
    };
    const baselineInput = dynamicInputFor(baseline);
    const directBaselineFrame =
      publicationLane === 'gpu-driven'
        ? await capture(baseline, baselineInput, baselineProjection, undefined, 'direct')
        : undefined;
    const baselineFrame = await capture(baseline, baselineInput, baselineProjection);
    if (directBaselineFrame !== undefined) {
      expectSurfaceMemberMultisetsEqual(
        directBaselineFrame.memberIdsByPass,
        baselineFrame.memberIdsByPass,
        'baseline',
      );
      for (const [index, roi] of baselineFrame.rois.entries()) {
        expect(
          compareSurfaceAppLifecycleRois(directBaselineFrame.rois[index] ?? roi, roi).maxError,
        ).toBeLessThanOrEqual(0.05);
      }
    }
    const overlapOrder: string[] = [];
    const oldReceipt = draw(baseline, baselineInput, true);
    overlapOrder.push('old-submitted');
    let oldObservationSettled = false;
    overlapOrder.push('old-observation-started');
    const oldObservationPromise = renderer
      .observe(oldReceipt, { include: ['linear-hdr'] })
      .then((result) => {
        oldObservationSettled = true;
        overlapOrder.push('old-observation-settled');
        return result;
      });
    await Promise.resolve();
    const oldObservationSettledBeforePublicationUpdate = oldObservationSettled;
    const waitForCatalog = async (accept: (snapshot: CatalogSnapshot) => boolean) => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const snapshot = await readCatalog();
        if (accept(snapshot)) return snapshot;
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`Surface publication did not settle: ${inspect(await readCatalog())}`);
    };
    const waitForChangedDelta = async (
      cursor: number,
      packageUrl: string,
    ): Promise<CatalogDelta> => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const match = deltas
          .slice(cursor)
          .find(
            (delta) =>
              delta.authority !== 'degraded' &&
              delta.changed.some(
                (row) => row.guid === options.guid && row.packageUrl === packageUrl,
              ),
          );
        if (match !== undefined) return match;
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(
        `Surface HMR did not publish a fresh target-GUID changed delta: ${inspect(deltas.slice(cursor))}`,
      );
    };
    const updateAndLoad = async (value: SurfaceMaterialPublicationValue) => {
      const previous = (await readCatalog()).entries.find((row) => row.guid === options.guid);
      const cursor = deltas.length;
      await options.update(value);
      const snapshot = await waitForCatalog(
        (candidate) =>
          candidate.authority === 'authoritative' &&
          candidate.entries.some(
            (row) => row.guid === options.guid && row.packageUrl !== previous?.packageUrl,
          ),
      );
      if (hot === undefined) {
        const reconciled = await assets.reconcileCatalog();
        expect(reconciled.ok, inspect(reconciled)).toBe(true);
      }
      const row = snapshot.entries.find((candidate) => candidate.guid === options.guid);
      if (row === undefined) throw new Error('Surface changed Catalog row is absent');
      const delta = await waitForChangedDelta(cursor, row.packageUrl);
      assets.invalidate(options.guid);
      return { material: await load(), snapshot, row, delta, cursor };
    };

    const updateAndReject = async (value: 'broken' | 'incomplete') => {
      const cursor = deltas.length;
      const accepted = (await readCatalog()).entries.find((row) => row.guid === options.guid);
      await options.update(value);
      const degraded = await waitForCatalog((snapshot) => snapshot.authority === 'degraded');
      const deadline = Date.now() + 10_000;
      while (
        !deltas.slice(cursor).some((delta) => delta.authority === 'degraded') &&
        Date.now() < deadline
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
      if (hot !== undefined) {
        expect(
          deltas.slice(cursor).some((delta) => delta.authority === 'degraded'),
          `${value} did not publish a fresh degraded HMR delta`,
        ).toBe(true);
      }
      expect(degraded.entries.find((row) => row.guid === options.guid)?.packageUrl).toBe(
        accepted?.packageUrl,
      );
      expect(
        degraded.diagnostics?.length ?? 0,
        `${value} had no fresh producer error`,
      ).toBeGreaterThan(0);
      return { degraded, cursor };
    };

    overlapOrder.push('revised-publication-update-started');
    const revised = await updateAndLoad('revised');
    overlapOrder.push('revised-publication-loaded');
    const revisedProjection = assets.getMaterialProjectionForPayload(revised.material);
    if (revisedProjection?.surface?.dynamicInput === undefined) {
      throw new Error('Surface revised projection has no dynamic schema');
    }
    expect(revisedProjection.materialGuid).toBe(baselineProjection.materialGuid);
    expect(revisedProjection.publicationGeneration).toBeGreaterThan(
      baselineProjection.publicationGeneration,
    );
    expect(revisedProjection.specializationKey).not.toBe(baselineProjection.specializationKey);
    expect(revisedProjection.surface.dynamicInput).toEqual(baselineProjection.surface.dynamicInput);
    const directRevisedFrame =
      publicationLane === 'gpu-driven'
        ? await capture(revised.material, baselineInput, revisedProjection, undefined, 'direct')
        : undefined;
    let oldObservationHostPendingAtRevisedSubmit = false;
    const revisedFrame = await capture(
      revised.material,
      baselineInput,
      revisedProjection,
      (receipt) => {
        oldObservationHostPendingAtRevisedSubmit = !oldObservationSettled;
        overlapOrder.push(`revised-submitted:${receipt.frameId}`);
      },
    );
    if (directRevisedFrame !== undefined) {
      expectSurfaceMemberMultisetsEqual(
        directRevisedFrame.memberIdsByPass,
        revisedFrame.memberIdsByPass,
        'revised',
      );
    }
    expect(
      revisedFrame.rois.some(
        (roi, index) =>
          compareSurfaceAppLifecycleRois(baselineFrame.rois[index] ?? roi, roi).maxError > 0.05,
      ),
      'revised Surface publication did not change the fixed HDR ROI',
    ).toBe(true);
    const lateOldObservation = await oldObservationPromise;
    expect(lateOldObservation.ok, inspect(lateOldObservation)).toBe(true);
    let oldObservation: FrameDomainObservation | undefined;
    if (lateOldObservation.ok) {
      oldObservation = lateOldObservation.value.observations?.find(
        (candidate) => candidate.domain === 'linear-hdr',
      );
      expect(oldObservation?.metadata.frameId).toBe(oldReceipt.frameId);
      expect(oldObservation?.metadata.deviceGeneration).toBe(oldReceipt.deviceGeneration);
      expect(oldObservation?.metadata.graphGeneration).toBe(oldReceipt.graphGeneration);
      expect(oldObservation?.metadata.frameId).not.toBe(revisedFrame.receipt.frameId);
      expect(oldObservation?.metadata.readbackIdentity).not.toBe(
        revisedFrame.observation.metadata.readbackIdentity,
      );
      if (oldObservation !== undefined) {
        for (const [index, roi] of readObservationRois(oldObservation).entries()) {
          expect(
            compareSurfaceAppLifecycleRois(baselineFrame.rois[index] ?? roi, roi).maxError,
          ).toBeLessThanOrEqual(0.05);
        }
      }
    }
    expect(overlapOrder.indexOf('old-submitted')).toBeLessThan(
      overlapOrder.indexOf('old-observation-started'),
    );
    expect(overlapOrder.indexOf('old-observation-started')).toBeLessThan(
      overlapOrder.indexOf('revised-publication-update-started'),
    );
    expect(overlapOrder.indexOf('revised-publication-loaded')).toBeLessThan(
      overlapOrder.findIndex((event) => event.startsWith('revised-submitted:')),
    );

    await updateAndReject('broken');
    expect(assets.getMaterialProjectionForPayload(revised.material)).toBe(revisedProjection);
    const directBrokenLkg =
      publicationLane === 'gpu-driven'
        ? await capture(revised.material, baselineInput, revisedProjection, undefined, 'direct')
        : undefined;
    const brokenLkg = await capture(revised.material, baselineInput, revisedProjection);
    if (directBrokenLkg !== undefined) {
      expectSurfaceMemberMultisetsEqual(
        directBrokenLkg.memberIdsByPass,
        brokenLkg.memberIdsByPass,
        'LKG',
      );
    }
    for (const [index, roi] of brokenLkg.rois.entries()) {
      expect(
        compareSurfaceAppLifecycleRois(revisedFrame.rois[index] ?? roi, roi).maxError,
      ).toBeLessThanOrEqual(0.05);
    }

    const recovered = await updateAndLoad('recovered');
    const recoveredProjection = assets.getMaterialProjectionForPayload(recovered.material);
    if (recoveredProjection?.surface?.dynamicInput === undefined) {
      throw new Error('Surface recovered projection has no dynamic schema');
    }
    expect(recoveredProjection.publicationGeneration).toBeGreaterThan(
      revisedProjection.publicationGeneration,
    );
    const recoveredFrame = await capture(recovered.material, baselineInput, recoveredProjection);
    await updateAndReject('incomplete');
    expect(assets.getMaterialProjectionForPayload(recovered.material)).toBe(recoveredProjection);
    const incompleteLkg = await capture(recovered.material, baselineInput, recoveredProjection);
    for (const [index, roi] of incompleteLkg.rois.entries()) {
      expect(
        compareSurfaceAppLifecycleRois(recoveredFrame.rois[index] ?? roi, roi).maxError,
      ).toBeLessThanOrEqual(0.05);
    }

    const schema = await updateAndLoad('schema');
    const schemaProjection = assets.getMaterialProjectionForPayload(schema.material);
    if (schemaProjection?.surface?.dynamicInput === undefined) {
      throw new Error('Surface schema projection has no dynamic schema');
    }
    expect(schemaProjection.publicationGeneration).toBeGreaterThan(
      recoveredProjection.publicationGeneration,
    );
    expect(schemaProjection.specializationKey).not.toBe(revisedProjection.specializationKey);
    expect(schemaProjection.surface.dynamicInput.fields.map((field) => field.name)).toEqual([
      'position',
      'time',
      'eventId',
      'strength',
    ]);
    expect(revisedProjection.surface.dynamicInput.fields.map((field) => field.name)).toEqual([
      'position',
      'time',
      'eventId',
    ]);
    expect(schema.material.surface?.module).toBe('game::surface_hmr');
    const errorCursor = renderErrors.length;
    const submissionBeforeStaleDraw = renderer.inspect().renderScene.submission;
    let staleDrawError: unknown;
    let staleReceipt: FrameReceipt | undefined;
    try {
      staleReceipt = await submit(schema.material, baselineInput, false);
    } catch (error) {
      staleDrawError = error;
    }
    const staleEvidence = [...renderErrors.slice(errorCursor), staleDrawError]
      .map(inspect)
      .join('\n');
    expect(staleEvidence).toContain(
      'the submitted Surface dynamic page matches the cooked MaterialProgramAbi layout',
    );
    const staleSubmission = renderer.inspect().renderScene.submission;
    if (staleReceipt === undefined) {
      expect(staleSubmission?.sequence).toBe(submissionBeforeStaleDraw?.sequence);
    } else {
      expect(staleSubmission?.frameId).toBe(staleReceipt.frameId);
      expect(
        staleSubmission?.passes.flatMap((pass) => pass.commands) ?? [],
        'old dynamic page published a completed Surface command for the new schema',
      ).toHaveLength(0);
    }
    const schemaInput = dynamicInputFor(schema.material);
    const schemaFrame = await capture(schema.material, schemaInput, schemaProjection);
    expect(schemaFrame.rois).toHaveLength(2);
    return {
      baseline: baselineProjection,
      revised: revisedProjection,
      recovered: recoveredProjection,
      schema: schemaProjection,
      frames: {
        baseline: baselineFrame.receipt,
        revised: revisedFrame.receipt,
        recovered: recoveredFrame.receipt,
        schema: schemaFrame.receipt,
      },
      overlap: {
        order: Object.freeze([...overlapOrder]),
        oldObservationSettledBeforePublicationUpdate,
        oldObservationHostPendingAtRevisedSubmit,
        physicalGpuPendingOverlap: 'not-observable' as const,
        old: {
          frameId: oldReceipt.frameId,
          deviceGeneration: oldReceipt.deviceGeneration,
          graphGeneration: oldReceipt.graphGeneration,
          textureIdentity: oldObservation?.metadata.textureIdentity,
          readbackIdentity: oldObservation?.metadata.readbackIdentity,
        },
        revised: {
          frameId: revisedFrame.receipt.frameId,
          deviceGeneration: revisedFrame.receipt.deviceGeneration,
          graphGeneration: revisedFrame.receipt.graphGeneration,
          textureIdentity: revisedFrame.observation.metadata.textureIdentity,
          readbackIdentity: revisedFrame.observation.metadata.readbackIdentity,
        },
      },
      lane: publicationLane,
      directBaselineFrameId: directBaselineFrame?.receipt.frameId,
      memberIds: {
        baselineDirect: directBaselineFrame?.memberIdsByPass,
        baselineGpu: baselineFrame.memberIdsByPass,
        revisedDirect: directRevisedFrame?.memberIdsByPass,
        revisedGpu: revisedFrame.memberIdsByPass,
        lkgDirect: directBrokenLkg?.memberIdsByPass,
        lkgGpu: brokenLkg.memberIdsByPass,
      },
      hmrDeltaCount: deltas.length,
    };
  } finally {
    stopCatalog();
    assets.clearCatalogSource();
    hot?.close();
    for (const page of pages) page.release();
    lease?.dispose();
    stopRenderer();
    renderer.dispose();
    target?.destroy();
  }
}

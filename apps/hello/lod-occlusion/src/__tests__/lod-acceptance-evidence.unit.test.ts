import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { meshAssetContribution } from '@forgeax/engine-geometry';
import type { MeshAsset } from '@forgeax/engine-types';
import { materialContribution } from '@forgeax/engine-render';
import { describe, expect, it, vi } from 'vitest';
import { loadLodProducerInputs } from '../../scripts/load-lod-producer-inputs.mjs';
import {
  loadLodProducerAssets,
  createLodPhaseProgress,
  createSerialFrameQueue,
  observeCompletedReceipt,
  selectedLod,
  summarizeHiddenObservation,
  summarizeLodObservation,
  verifyLodProducerManifestBytes,
} from '../../scripts/lod-acceptance-evidence.mjs';

const receipt = { frameId: 17, deviceGeneration: 3 };
const submit = { frameId: 17, build: 'fixture-build', deviceGeneration: 3 };
const cameraIds = [10, 20];
const rootMeshHandle = 17;

function row(cameraEntity: number, level: number, generation: number) {
  return {
    root: { guid: `asset-handle:${rootMeshHandle}`, sourceKey: 'fixture-scene-source' },
    view: {
      attachmentId: 'attachment-1',
      cameraEntity,
      viewRole: 'main',
      viewGeneration: generation,
    },
    slot: { primitiveSlot: 0, slotGeneration: 1 },
    generation: 17,
    count: { candidates: 1, visible: 1, occluded: 0 },
    lodHistogram: [{ level, count: 1 }],
    samples: [{ primitiveSlot: 0, level, visible: true }],
  };
}

function countRows(rows: readonly ReturnType<typeof row>[]) {
  return rows.reduce(
    (count, current) => ({
      candidates: count.candidates + current.count.candidates,
      visible: count.visible + current.count.visible,
      occluded: count.occluded + current.count.occluded,
    }),
    { candidates: 0, visible: 0, occluded: 0 },
  );
}

function histogramRows(rows: readonly ReturnType<typeof row>[]) {
  const histogram = new Map<number, number>();
  for (const current of rows) {
    for (const entry of current.lodHistogram) {
      histogram.set(entry.level, (histogram.get(entry.level) ?? 0) + entry.count);
    }
  }
  return [...histogram.entries()]
    .sort(([left], [right]) => left - right)
    .map(([level, count]) => ({ level, count }));
}

function lodInspection(
  cameraEntity: number,
  viewGeneration: number,
  rows: readonly ReturnType<typeof row>[],
  observationSubmit: typeof submit,
  inspectionCount = countRows(rows),
) {
  const first = rows[0];
  if (!first) throw new Error('expected a per-view LOD row');
  return {
    schema: 'forgeax::lod-occlusion-inspection::v3',
    submit: observationSubmit,
    ...first,
    view: {
      attachmentId: 'attachment-1',
      cameraEntity,
      viewRole: 'main',
      viewGeneration,
    },
    count: inspectionCount,
    lodHistogram: histogramRows(rows),
    worlds: [
      {
        attachmentId: 'attachment-1',
        attribution: { status: 'same-submit', submit: observationSubmit },
        rows,
      },
    ],
  };
}

function receiptObservation(
  rows: readonly ReturnType<typeof row>[],
  generations: Readonly<Record<number, number>> = { 10: 4, 20: 9 },
  observationReceipt = receipt,
  inspectionCounts: Readonly<
    Record<number, { candidates: number; visible: number; occluded: number }>
  > = {},
) {
  const observationSubmit = { ...submit, ...observationReceipt };
  return {
    frameId: observationReceipt.frameId,
    deviceGeneration: observationReceipt.deviceGeneration,
    include: ['lod-occlusion'],
    lodOcclusion: {
      status: 'complete',
      views: cameraIds.map((cameraEntity) => {
        const viewRows = rows.filter((candidate) => candidate.view.cameraEntity === cameraEntity);
        const viewGeneration = generations[cameraEntity] ?? 0;
        return {
          viewKey: `view-${cameraEntity}`,
          entityKey: cameraEntity,
          attachmentId: 'attachment-1',
          viewGeneration,
          graphGeneration: cameraEntity * 100 + viewGeneration,
          state: 'rendered',
          lodOcclusion: lodInspection(
            cameraEntity,
            viewGeneration,
            viewRows,
            observationSubmit,
            inspectionCounts[cameraEntity],
          ),
        };
      }),
    },
  };
}

function nativeMesh(value: NonNullable<MeshAsset['lods']>[number]['mesh']) {
  if (typeof value !== 'number') throw new Error('Source LOD was not adopted as a runtime handle');
  return value;
}

describe('LOD receipt evidence', () => {
  it('accepts hidden frames only from empty completed draws and the exact rendered World roster', () => {
    const visible = receiptObservation([row(10, 0, 4), row(20, 2, 9)]);
    const observation = {
      ...visible,
      lodOcclusion: {
        status: 'unavailable',
        reason: 'lod-readback-unavailable',
        views: visible.lodOcclusion.views,
      },
      include: ['lod-occlusion', 'draws'],
      draws: { status: 'complete', draws: [] as unknown[] },
    };
    const evidence = summarizeHiddenObservation(
      structuredClone(observation),
      receipt,
      cameraIds,
      'attachment-1',
    );
    expect(evidence.draws).toEqual({ status: 'complete', draws: [] });
    expect(evidence.cameraViews.map((view) => view.cameraEntity)).toEqual(cameraIds);
    expect(evidence).not.toHaveProperty('aggregate');
    for (const reason of ['superseded', 'lease-detached', 'graph-generation-mismatch']) {
      expect(() =>
        summarizeHiddenObservation(
          { ...observation, lodOcclusion: { ...observation.lodOcclusion, reason } },
          receipt,
          cameraIds,
          'attachment-1',
        ),
      ).toThrow('empty-scene LOD');
    }
    expect(() =>
      summarizeHiddenObservation(
        observation,
        { ...receipt, frameId: 18 },
        cameraIds,
        'attachment-1',
      ),
    ).toThrow('completed FrameReceipt');
    expect(() =>
      summarizeHiddenObservation(observation, receipt, cameraIds, 'other-world'),
    ).toThrow('World');
    observation.draws.draws.push({ worldIdentity: 'attachment-1', entityKey: 3 });
    expect(() =>
      summarizeHiddenObservation(observation, receipt, cameraIds, 'attachment-1'),
    ).toThrow('empty completed draw');
    observation.draws = {
      status: 'unavailable',
      reason: 'unsupported-lane',
      draws: [],
    } as unknown as typeof observation.draws;
    expect(() =>
      summarizeHiddenObservation(observation, receipt, cameraIds, 'attachment-1'),
    ).toThrow('empty completed draw');
    observation.draws = { status: 'complete', draws: [] };
    const firstView = observation.lodOcclusion.views[0];
    if (!firstView) throw new Error('hidden fixture view missing');
    firstView.state = 'held';
    expect(() =>
      summarizeHiddenObservation(observation, receipt, cameraIds, 'attachment-1'),
    ).toThrow('rendered');
  });

  it('rejects a stale mesh binding even when the receipt and both CameraViews still match', () => {
    const observation = receiptObservation([row(10, 0, 4), row(20, 2, 9)]);
    expect(() =>
      summarizeLodObservation(observation, receipt, cameraIds, rootMeshHandle + 1),
    ).toThrow('different root MeshAsset');
    const secondView = observation.lodOcclusion.views[1];
    const secondRow = secondView?.lodOcclusion.worlds[0]?.rows[0];
    if (!secondRow) throw new Error('second-view fixture row missing');
    secondRow.root = { ...secondRow.root, guid: 'asset-handle:999' };
    expect(() => summarizeLodObservation(observation, receipt, cameraIds, rootMeshHandle)).toThrow(
      'row belongs to a different root MeshAsset',
    );
  });

  it('uses outer graph generations without requiring a nested graphGeneration', () => {
    const observation = receiptObservation([row(10, 0, 4), row(20, 2, 9)]);
    const views = observation.lodOcclusion.views;
    expect(views.map((view) => view.graphGeneration)).toEqual([1004, 2009]);
    expect(views.every((view) => !('graphGeneration' in view.lodOcclusion))).toBe(true);

    const evidence = summarizeLodObservation(observation, receipt, cameraIds, rootMeshHandle);

    expect(evidence.submit).toEqual(submit);
    expect(evidence.attachmentId).toBe('attachment-1');
    expect(evidence.aggregate).toEqual({
      candidates: 2,
      visible: 2,
      occluded: 0,
      lodHistogram: [
        { level: 0, count: 1 },
        { level: 2, count: 1 },
      ],
    });
    expect(
      evidence.cameraViews.map((camera) => [camera.viewGeneration, selectedLod(camera)]),
    ).toEqual([
      [4, 0],
      [9, 2],
    ]);
    expect(evidence.cameraViews.map((camera) => camera.graphGeneration)).toEqual([1004, 2009]);
    expect(Object.isFrozen(evidence.cameraViews[0])).toBe(true);
  });

  it('rejects a World row whose CameraView generation differs from its receipt view', () => {
    expect(() =>
      summarizeLodObservation(
        receiptObservation([row(10, 0, 4), row(10, 1, 9), row(20, 2, 9)]),
        receipt,
        cameraIds,
        rootMeshHandle,
      ),
    ).toThrow('mixed or invalid source identity');
  });

  it('closes on a missing or unknown view and on an observation from another receipt', () => {
    const missing = receiptObservation([row(10, 0, 4), row(20, 2, 9)]);
    missing.lodOcclusion.views.pop();
    expect(() => summarizeLodObservation(missing, receipt, cameraIds, rootMeshHandle)).toThrow(
      'complete CameraView roster',
    );
    const unknown = receiptObservation([row(10, 0, 4), row(20, 2, 9)]);
    const unknownView = unknown.lodOcclusion.views[1];
    if (!unknownView) throw new Error('expected second CameraView fixture');
    unknownView.entityKey = 30;
    expect(() => summarizeLodObservation(unknown, receipt, cameraIds, rootMeshHandle)).toThrow(
      'unknown CameraView 30',
    );
    expect(() =>
      summarizeLodObservation(
        receiptObservation([row(10, 0, 4), row(20, 2, 9)]),
        {
          ...receipt,
          frameId: 18,
        },
        cameraIds,
        rootMeshHandle,
      ),
    ).toThrow('does not match the completed FrameReceipt');
  });

  it('requires the requested receipt snapshot and same-submit World attribution', () => {
    const notRequested = receiptObservation([row(10, 0, 4), row(20, 2, 9)]);
    notRequested.include = [];
    expect(() => summarizeLodObservation(notRequested, receipt, cameraIds, rootMeshHandle)).toThrow(
      'did not request lod-occlusion',
    );

    const projectionOnly = receiptObservation([row(10, 0, 4), row(20, 2, 9)]);
    const world = projectionOnly.lodOcclusion.views[0]?.lodOcclusion.worlds[0];
    if (!world) throw new Error('expected one World fixture');
    world.attribution.status = 'unavailable';
    expect(() =>
      summarizeLodObservation(projectionOnly, receipt, cameraIds, rootMeshHandle),
    ).toThrow('World attribution is not same-submit');
  });

  it('keeps the closed unavailable union fail-closed and requires its roster', () => {
    const unavailable: Record<string, unknown> = receiptObservation([row(10, 0, 4), row(20, 2, 9)]);
    const completeLod = unavailable.lodOcclusion as { views: unknown[] };
    unavailable.lodOcclusion = {
      status: 'unavailable',
      reason: 'held-view',
      views: completeLod.views,
    };
    expect(() => summarizeLodObservation(unavailable, receipt, cameraIds, rootMeshHandle)).toThrow(
      'receipt LOD snapshot is unavailable: held-view',
    );

    const noRoster: Record<string, unknown> = receiptObservation([row(10, 0, 4), row(20, 2, 9)]);
    noRoster.lodOcclusion = { status: 'unavailable', reason: 'not-captured' };
    expect(() => summarizeLodObservation(noRoster, receipt, cameraIds, rootMeshHandle)).toThrow(
      'missing its view roster',
    );
  });

  it('rejects zero inspection totals when same-submit views contain visible World rows', () => {
    const inconsistent = receiptObservation([row(10, 0, 4), row(20, 2, 9)], undefined, receipt, {
      10: { candidates: 1, visible: 0, occluded: 0 },
      20: { candidates: 1, visible: 0, occluded: 0 },
    });
    expect(() => summarizeLodObservation(inconsistent, receipt, cameraIds, rootMeshHandle)).toThrow(
      'inspection totals do not match same-submit World rows',
    );
  });

  it('closes on missing LOD facts, held views, and the public byte and sample bounds', () => {
    const missing = receiptObservation([row(10, 0, 4), row(20, 2, 9)]);
    const missingView = missing.lodOcclusion.views[1];
    if (!missingView) throw new Error('expected second CameraView fixture');
    delete (missingView as Record<string, unknown>).lodOcclusion;
    expect(() => summarizeLodObservation(missing, receipt, cameraIds, rootMeshHandle)).toThrow(
      'CameraView 20 LOD inspection must be an object',
    );

    const held = receiptObservation([row(10, 0, 4), row(20, 2, 9)]);
    const heldView = held.lodOcclusion.views[1];
    if (!heldView) throw new Error('expected second CameraView fixture');
    heldView.state = 'held';
    expect(() => summarizeLodObservation(held, receipt, cameraIds, rootMeshHandle)).toThrow(
      'was not rendered for this receipt',
    );

    const tooManySamples = receiptObservation([row(10, 0, 4), row(20, 2, 9)]);
    const sampleView = tooManySamples.lodOcclusion.views[0];
    if (!sampleView) throw new Error('expected first CameraView fixture');
    sampleView.lodOcclusion.samples = Array.from({ length: 65 }, (_, primitiveSlot) => ({
      primitiveSlot,
      level: 0,
      visible: true,
    }));
    expect(() =>
      summarizeLodObservation(tooManySamples, receipt, cameraIds, rootMeshHandle),
    ).toThrow('64 sample limit');

    const tooLarge = receiptObservation([row(10, 0, 4), row(20, 2, 9)]);
    const largeView = tooLarge.lodOcclusion.views[0];
    if (!largeView) throw new Error('expected first CameraView fixture');
    largeView.lodOcclusion.submit.build = 'b'.repeat(17 * 1024);
    expect(() => summarizeLodObservation(tooLarge, receipt, cameraIds, rootMeshHandle)).toThrow(
      'receipt LOD snapshot exceeds 16 KiB',
    );
  });
});

describe('LOD phase progress', () => {
  it('counts completion separately and accepts only unique increasing current-phase receipts', () => {
    const progress = createLodPhaseProgress();
    const phase = progress.beginPhase('fallback', 2);
    const firstEvidence = summarizeLodObservation(
      receiptObservation([row(10, 0, 4), row(20, 2, 9)]),
      receipt,
      cameraIds,
      rootMeshHandle,
    );
    const first = progress.markCompleted(phase, receipt);
    expect(progress.snapshot()).toMatchObject({
      phaseCompletedFrames: 1,
      phaseAcceptedFrames: 0,
      totalCompletedFrames: 1,
      totalAcceptedFrames: 0,
    });
    expect(progress.accept(phase, first, firstEvidence)).toBe(true);

    const duplicate = progress.markCompleted(phase, receipt);
    expect(duplicate.uniqueIncreasing).toBe(false);
    expect(progress.accept(phase, duplicate, firstEvidence)).toBe(false);

    const secondReceipt = { frameId: 18, deviceGeneration: 3 };
    const second = progress.markCompleted(phase, secondReceipt);
    const secondEvidence = summarizeLodObservation(
      receiptObservation([row(10, 0, 4), row(20, 2, 9)], undefined, secondReceipt),
      secondReceipt,
      cameraIds,
      rootMeshHandle,
    );
    expect(progress.accept(phase, second, secondEvidence)).toBe(true);
    expect(progress.snapshot()).toMatchObject({
      phaseCompletedFrames: 3,
      phaseAcceptedFrames: 2,
      totalCompletedFrames: 3,
      totalAcceptedFrames: 2,
    });

    const nextPhase = progress.beginPhase('resident', 1);
    const oldPhaseFrame = progress.markCompleted(phase, { frameId: 19, deviceGeneration: 3 });
    expect(oldPhaseFrame.currentPhase).toBe(false);
    expect(progress.accept(phase, oldPhaseFrame, secondEvidence)).toBe(false);
    expect(progress.snapshot()).toMatchObject({
      phase: 'resident',
      phaseCompletedFrames: 0,
      phaseAcceptedFrames: 0,
      totalCompletedFrames: 4,
      totalAcceptedFrames: 2,
    });
    expect(nextPhase.epoch).toBeGreaterThan(phase.epoch);
  });
});

describe('serial receipt scheduling', () => {
  it('drains completion and observation before the next draw or phase transition', async () => {
    const queue = createSerialFrameQueue();
    const trace: string[] = [];
    let releaseCompletion!: () => void;
    let releaseObservation!: () => void;
    const completion = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    const observation = new Promise<void>((resolve) => {
      releaseObservation = resolve;
    });

    const receiptWithCompletion = {
      frameId: 21,
      deviceGeneration: 3,
      presentation: 'ready' as const,
      completed: completion.then(() => ({ ok: true as const })),
    };
    const first = queue.enqueue(async () => {
      trace.push('draw-1');
      const result = await observeCompletedReceipt(
        receiptWithCompletion,
        async (exactReceipt) => {
          expect(exactReceipt).toBe(receiptWithCompletion);
          trace.push('observe-1');
          await observation;
          trace.push('observed-1');
          return { ok: true as const, value: { frameId: exactReceipt.frameId } };
        },
        (exactReceipt) => {
          expect(exactReceipt).toBe(receiptWithCompletion);
          trace.push('completed-1');
          return true;
        },
      );
      expect(result.status).toBe('observed');
    });
    const second = queue.enqueue(() => trace.push('draw-2'));
    const phaseSwitch = queue.drain().then(() => trace.push('phase-switch'));
    await Promise.resolve();
    expect(trace).toEqual(['draw-1']);

    releaseCompletion();
    await Promise.resolve();
    await Promise.resolve();
    expect(trace).toEqual(['draw-1', 'completed-1', 'observe-1']);

    releaseObservation();
    await Promise.all([first, second, phaseSwitch]);
    expect(trace).toEqual([
      'draw-1',
      'completed-1',
      'observe-1',
      'observed-1',
      'draw-2',
      'phase-switch',
    ]);
  });

  it('does not observe or count a receipt whose completion failed', async () => {
    const error = { code: 'device-lost' };
    const receiptWithFailedCompletion = {
      frameId: 22,
      deviceGeneration: 3,
      presentation: 'ready' as const,
      completed: Promise.resolve({ ok: false as const, error }),
    };
    let observed = false;
    const progress = createLodPhaseProgress();
    const phase = progress.beginPhase('failed-completion', 1);
    const result = await observeCompletedReceipt(
      receiptWithFailedCompletion,
      async () => {
        observed = true;
        return { ok: true as const, value: {} };
      },
      (exactReceipt) => progress.markCompleted(phase, exactReceipt),
    );
    expect(result).toEqual({
      status: 'completion-failed',
      receipt: receiptWithFailedCompletion,
      error,
    });
    expect(observed).toBe(false);
    expect(progress.snapshot()).toMatchObject({
      phaseCompletedFrames: 0,
      phaseAcceptedFrames: 0,
      totalCompletedFrames: 0,
      totalAcceptedFrames: 0,
    });
  });

  it('records a successful completion but does not accept a failed observation', async () => {
    const progress = createLodPhaseProgress();
    const phase = progress.beginPhase('observation-failure', 1);
    const receiptWithCompletedWork = {
      frameId: 23,
      deviceGeneration: 3,
      presentation: 'ready' as const,
      completed: Promise.resolve({ ok: true as const }),
    };
    const result = await observeCompletedReceipt(
      receiptWithCompletedWork,
      async () => ({ ok: false as const, error: { code: 'observation-unavailable' } }),
      (receipt) => progress.markCompleted(phase, receipt),
    );
    expect(result.status).toBe('observation-failed');
    expect(progress.snapshot()).toMatchObject({
      phaseCompletedFrames: 1,
      phaseAcceptedFrames: 0,
      totalCompletedFrames: 1,
      totalAcceptedFrames: 0,
    });
  });
});

describe('selected E03 producer manifest', () => {
  it.runIf(Boolean(process.env.FORGEAX_E03_INPUTS_DIR))(
    'catalogs the real producer manifest in two stages without replacing the root or World',
    async () => {
      const inputRoot = resolve(process.env.FORGEAX_E03_INPUTS_DIR as string);
      const {
        verified,
        identity: producerIdentity,
        roles: expectedRoles,
      } = await loadLodProducerInputs(inputRoot, {
        ...(process.env.E03_SHADER_MANIFEST
          ? { shaderManifest: process.env.E03_SHADER_MANIFEST }
          : {}),
      });
      const manifestBytes = new Uint8Array(await readFile(resolve(inputRoot, 'manifest.json')));
      expect(verified.sha256).toBe(producerIdentity.manifestSha256);
      expect(verified.manifest.provenance.producerHead).toBe(producerIdentity.producerHead);
      await expect(
        verifyLodProducerManifestBytes(manifestBytes, expectedRoles, {
          ...producerIdentity,
          producerHead: '0'.repeat(40),
        }),
      ).rejects.toThrow('producer commit');
      await expect(
        verifyLodProducerManifestBytes(manifestBytes, expectedRoles, {
          ...producerIdentity,
          manifestSha256: '0'.repeat(64),
        }),
      ).rejects.toThrow('SHA256 mismatch');
      await expect(
        verifyLodProducerManifestBytes(
          manifestBytes.subarray(0, manifestBytes.length - 1),
          expectedRoles,
          producerIdentity,
        ),
      ).rejects.toThrow('SHA256 mismatch');
      await expect(
        verifyLodProducerManifestBytes(
          manifestBytes,
          { ...expectedRoles, lowest: expectedRoles.root },
          producerIdentity,
        ),
      ).rejects.toThrow('GUID does not match');

      const assets = new AssetRegistry({ shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }) });
      assets.installDecoder(meshAssetContribution.kind, meshAssetContribution.decoder);
      assets.installDecoder(materialContribution.kind, materialContribution.decoder);
      const staged = await loadLodProducerAssets(
        assets,
        verified.manifest,
        async (path) => new Uint8Array(await readFile(resolve(inputRoot, path))),
        expectedRoles,
      );
      const handle = staged.root;
      const root = assets.read(handle).unwrap();
      expect(root.vertices).toBeInstanceOf(Float32Array);
      expect(root.lods).toHaveLength(1);
      expect(assets.source(nativeMesh(root.lods![0]!.mesh)).unwrap()?.guid).toBe(expectedRoles.middle);
      const held = assets.snapshot(handle).unwrap();
      const world = new World({ assets });
      const identity = world.identity;
      await staged.admitLowest();
      const current = assets.snapshot(handle).unwrap();
      const updated = assets.read(handle).unwrap();
      expect(updated.lods).toHaveLength(2);
      expect(assets.source(nativeMesh(updated.lods![1]!.mesh)).unwrap()?.guid).toBe(expectedRoles.lowest);
      expect(assets.read(nativeMesh(updated.lods![1]!.mesh)).unwrap().vertices).toBeInstanceOf(Float32Array);
      expect(current.version(handle).unwrap()).toBeGreaterThan(held.version(handle).unwrap());
      expect(world.identity).toBe(identity);
      expect(assets.validate(handle).ok).toBe(true);
      current.dispose();
      held.dispose();
      assets.release(handle).unwrap();
    },
  );
  it.runIf(Boolean(process.env.FORGEAX_E03_INPUTS_DIR))(
    'rejects mismatched source, Meta, module and shader bytes at the actual input loader',
    async () => {
      const inputRoot = resolve(process.env.FORGEAX_E03_INPUTS_DIR as string);
      const selected = await loadLodProducerInputs(inputRoot);
      const original = await readFile(resolve(inputRoot, 'manifest.json'), 'utf8');
      const directory = await mkdtemp(resolve(tmpdir(), 'forgeax-e03-inputs-'));
      try {
        await symlink(resolve(inputRoot, 'shaders'), resolve(directory, 'shaders'), 'dir');
        await writeFile(resolve(directory, 'manifest.json'), original);
        await expect(
          loadLodProducerInputs(directory, { producerHead: '0'.repeat(40) }),
        ).rejects.toThrow('producer commit');
        for (const source of ['source', 'meta'] as const) {
          const changed = JSON.parse(original);
          changed.provenance[source].sha256 = '0'.repeat(64);
          await writeFile(resolve(directory, 'manifest.json'), JSON.stringify(changed));
          await expect(loadLodProducerInputs(directory)).rejects.toThrow('source or Meta SHA256');
        }
        const changedModule = JSON.parse(original);
        changedModule.provenance.modules[0].sha256 = '0'.repeat(64);
        await writeFile(resolve(directory, 'manifest.json'), JSON.stringify(changedModule));
        await expect(loadLodProducerInputs(directory)).rejects.toThrow('public module SHA256');
        await writeFile(resolve(directory, 'manifest.json'), original);
        const alteredShader = resolve(directory, 'altered-shader.json');
        await writeFile(
          alteredShader,
          selected.shaderBytes.subarray(0, selected.shaderBytes.length - 1),
        );
        await expect(
          loadLodProducerInputs(directory, { shaderManifest: alteredShader }),
        ).rejects.toThrow('built app shader manifest differs');
        await rm(resolve(directory, 'shaders'));
        await expect(loadLodProducerInputs(directory)).rejects.toThrow('ENOENT');
        await mkdir(resolve(directory, 'shaders'));
        await writeFile(
          resolve(directory, 'shaders/manifest.json'),
          selected.shaderBytes.subarray(0, selected.shaderBytes.length - 1),
        );
        await expect(loadLodProducerInputs(directory)).rejects.toThrow(
          'shader publication does not match',
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.runIf(Boolean(process.env.FORGEAX_E03_INPUTS_DIR))(
    'rejects missing or altered asset and binary bytes before catalog admission',
    async () => {
      const inputRoot = resolve(process.env.FORGEAX_E03_INPUTS_DIR as string);
      const { verified, roles } = await loadLodProducerInputs(inputRoot);
      const root = verified.manifest.assets.find((asset) => asset.guid === roles.root);
      if (!root?.artifacts.body) throw new Error('producer root body is missing');
      for (const path of [root.path, root.artifacts.body.path]) {
        for (const corruption of ['missing', 'truncated', 'altered']) {
          const assets = new AssetRegistry({ shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }) });
          const load = vi.spyOn(assets, 'load');
          await expect(
            loadLodProducerAssets(
              assets,
              verified.manifest,
              async (requested) => {
                const bytes = new Uint8Array(await readFile(resolve(inputRoot, requested)));
                if (requested !== path) return bytes;
                if (corruption === 'missing')
                  return new Uint8Array(await readFile(resolve(inputRoot, 'absent-file')));
                if (corruption === 'truncated') return bytes.subarray(0, bytes.length - 1);
                bytes[0] = (bytes[0] ?? 0) ^ 1;
                return bytes;
              },
              roles,
            ),
          ).rejects.toThrow(corruption === 'missing' ? 'ENOENT' : /length|SHA256/);
          expect(load).not.toHaveBeenCalled();
        }
      }
    },
  );
});

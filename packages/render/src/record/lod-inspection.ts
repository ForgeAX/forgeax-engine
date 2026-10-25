import type { AssetHandle } from '@forgeax/engine-types';
import type { GpuDrivenLodSelectionInspection } from '../gpu-driven/view-gpu';
import { selectGpuLodLane } from '../gpu-driven/view-gpu';
import type { LodOcclusionInspection } from '../inspection-types';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { CameraSnapshot } from '../render-contract';
import { type LodOcclusionInspectionCell, resolveInspectionBuild } from '../render-system';
import type { ExtractedFrame, RenderableSnapshot } from '../render-system-extract';
import { createLodWorldInspections, lodWorldAttachments } from '../render-system-projections';
import { type FrameList, lodCandidateCountOf } from '../scene/frame-list';
import type { PersistentRenderScene } from '../scene/render-scene';
import { inspectLodOcclusion } from '../scene/visibility/inspection';
import type { SurfaceSubmissionObservationOwner } from '../surface/submission-observation';
import { cpuLodLevel, lodLevelHistogram } from './cpu-lod';
import { worldEntityKey } from './frame-snapshot';
import type { RenderSystemInternals } from './render-context';

type LodSelection = Pick<
  GpuDrivenLodSelectionInspection,
  'candidateCount' | 'visible' | 'occluded' | 'lodHistogram' | 'worldSelections'
> & { readonly submit?: { readonly frameId: number; readonly deviceGeneration: number } };

interface LodVisibility {
  readonly worldKeys: readonly number[];
  readonly projection: { readonly renderables: FrameList<RenderableSnapshot> };
}

const resolvedCell = (inspection: LodOcclusionInspection): LodOcclusionInspectionCell => ({
  view: inspection.view,
  submit: inspection.submit,
  value: () => inspection,
});

/**
 * The LOD/occlusion inspection of the last recorded frame: the CPU projection
 * published at record time and its join with the same-submit GPU selector
 * counters when they are read back.
 */
export class LodInspectionOwner {
  cell: LodOcclusionInspectionCell | undefined;
  // The GPU selector returns stable numeric World keys with its same-submit
  // counters. Keep the attachment join from that submit, rather than using
  // the current worlds[] position when the asynchronous readback completes.
  private worldAttachments: ReadonlyMap<number, string> = new Map();
  private candidateCount:
    | { readonly renderables: FrameList<RenderableSnapshot>; readonly count: number }
    | undefined;
  private filtered:
    | {
        readonly submissionRenderables: FrameList<RenderableSnapshot>;
        readonly lodCandidateCount: number;
        readonly values: FrameList<RenderableSnapshot>;
      }
    | undefined;

  constructor(
    private readonly internals: RenderSystemInternals,
    private readonly scene: PersistentRenderScene,
  ) {}

  private inspectionRenderablesOf(
    submissionRenderables: FrameList<RenderableSnapshot>,
    lodCandidateCount: number,
  ): FrameList<RenderableSnapshot> {
    const cached = this.filtered;
    if (
      cached?.submissionRenderables === submissionRenderables &&
      cached.lodCandidateCount === lodCandidateCount
    )
      return cached.values;
    const values =
      lodCandidateCount > 0
        ? submissionRenderables.filter((renderable) => (renderable.lods?.length ?? 0) > 0)
        : submissionRenderables;
    this.filtered = { submissionRenderables, lodCandidateCount, values };
    return values;
  }

  /**
   * Publish the CPU-side LOD/occlusion inspection bound to the caller's frame
   * receipt id; returns the frame's LOD candidate count. The GPU lane replaces
   * this projection with its selector counters; the CPU lane reports the same
   * hard selection its classic draws use.
   */
  inspectFrame(
    camera: CameraSnapshot | undefined,
    frame: ExtractedFrame,
    visibility: LodVisibility,
    scopes: readonly RenderResourceScope[],
    cameraOwner: number,
    frameId: number,
  ): number {
    if (camera === undefined) {
      this.cell = undefined;
      this.worldAttachments = new Map();
      return 0;
    }
    const internals = this.internals;
    const renderables = frame.renderables;
    const submissionRenderables = visibility.projection.renderables;
    if (this.candidateCount?.renderables !== renderables)
      this.candidateCount = { renderables, count: lodCandidateCountOf(renderables) };
    const lodCandidateCount = this.candidateCount.count;
    const cpuLodLane = selectGpuLodLane(internals.device.caps) === 'cpu';
    // CPU-lane levels read current GPU residency, so fix them at submit time.
    // Only LOD candidates can select a non-zero level.
    const cpuLevels = new Map<RenderableSnapshot, number>();
    if (cpuLodLane && lodCandidateCount > 0)
      for (const renderable of renderables) {
        if ((renderable.lods?.length ?? 0) === 0) continue;
        cpuLevels.set(
          renderable,
          cpuLodLevel(
            renderable,
            internals.gpuStore.getMeshGpuHandles(
              renderable.assetHandle as AssetHandle<'mesh'>,
              scopes[renderable.worldId] ?? renderable.worldId,
            ),
            camera,
          ),
        );
      }
    const levelOf = (renderable: RenderableSnapshot): number => cpuLevels.get(renderable) ?? 0;
    this.worldAttachments = lodWorldAttachments(scopes, visibility.worldKeys);
    const view = {
      attachmentId: scopes[camera.worldId ?? cameraOwner]?.identity ?? 'none',
      cameraEntity: camera.entityKey ?? 0,
      viewRole: 'main' as const,
      viewGeneration: camera.historyVersion ?? 0,
    };
    const submit = {
      frameId,
      build: resolveInspectionBuild(internals),
      deviceGeneration: internals.deviceScope.generation,
    };
    const slotGeneration = this.scene.topologyRevision();
    // Samples name at most 64 leading rows (and LOD rows) per World. Detach
    // their slots now; the live table follows later scene edits.
    const sampleSlots = new Map<number, { readonly slot: number; readonly generation: number }>();
    const sampledRows: number[] = scopes.map(() => 0);
    const sampledLods: number[] = scopes.map(() => (lodCandidateCount > 0 ? 0 : 64));
    let open = scopes.length * (lodCandidateCount > 0 ? 2 : 1);
    for (const renderable of renderables) {
      if (open === 0) break;
      const rows = sampledRows[renderable.worldId];
      const lods = sampledLods[renderable.worldId];
      if (rows === undefined || lods === undefined) continue;
      const lod = lods < 64 && (renderable.lods?.length ?? 0) > 0;
      if (rows >= 64 && !lod) continue;
      if (rows < 64) {
        sampledRows[renderable.worldId] = rows + 1;
        if (rows + 1 === 64) open -= 1;
      }
      if (lod) {
        sampledLods[renderable.worldId] = lods + 1;
        if (lods + 1 === 64) open -= 1;
      }
      const key = worldEntityKey(
        visibility.worldKeys[renderable.worldId] ?? renderable.worldId,
        renderable.entityKey,
      );
      const slot = this.scene.compositionSlot(renderable.worldId, renderable.entityKey);
      if (slot !== undefined) sampleSlots.set(key, slot);
    }
    // The full projection walks every renderable and forces the deferred CPU
    // frustum test of GPU-culled rows; only an explicit inspection pays it.
    let body: LodOcclusionInspection | undefined;
    const build = (): LodOcclusionInspection => {
      const inspectionRenderables = this.inspectionRenderablesOf(
        submissionRenderables,
        lodCandidateCount,
      );
      const inspectionLevels = inspectionRenderables.map(levelOf);
      const firstRenderable = renderables.at(0);
      return inspectLodOcclusion({
        root: {
          guid:
            firstRenderable === undefined ? 'none' : `asset-handle:${firstRenderable.assetHandle}`,
          sourceKey: `render-frame:${frameId}`,
        },
        view,
        slot: { primitiveSlot: 0, slotGeneration },
        generation: frameId,
        count: {
          candidates:
            lodCandidateCount > 0
              ? lodCandidateCount
              : renderables.length + frame.frustumStats.culled,
          visible: inspectionRenderables.length,
          occluded: 0,
        },
        lodHistogram: lodLevelHistogram(inspectionLevels),
        samples: inspectionRenderables.slice(0, 64).map((_, index) => ({
          primitiveSlot: index,
          level: inspectionLevels[index] ?? 0,
          visible: true,
        })),
        submit,
        worlds: createLodWorldInspections(
          scopes,
          renderables,
          submissionRenderables,
          camera,
          frameId,
          visibility.worldKeys,
          sampleSlots,
          levelOf,
        ),
      });
    };
    this.cell = { view, submit, value: () => (body ??= build()) };
    return lodCandidateCount;
  }

  /**
   * Join same-submit GPU selector counters with the captured CPU inspection.
   * The GPU readback histogram is the selector fact, while final submitted
   * counts are owned by the persistent visibility projection.
   */
  private applySelection(
    selection: LodSelection,
    inspection: LodOcclusionInspection,
    targetWorldAttachments: ReadonlyMap<number, string>,
  ): LodOcclusionInspection | undefined {
    let worlds = inspection.worlds;
    const worldSelections = selection.worldSelections;
    if (worldSelections !== undefined && worldSelections.length > 0) {
      if (worldSelections.some((selected) => !targetWorldAttachments.has(selected.worldKey)))
        return undefined;
      const selectionsByAttachment = new Map<string, (typeof worldSelections)[number][]>();
      for (const selected of worldSelections) {
        const attachmentId = targetWorldAttachments.get(selected.worldKey);
        if (attachmentId === undefined) return undefined;
        const rows = selectionsByAttachment.get(attachmentId);
        if (rows === undefined) selectionsByAttachment.set(attachmentId, [selected]);
        else rows.push(selected);
      }
      worlds = Object.freeze(
        worlds.map((world) => {
          const selected = selectionsByAttachment.get(world.attachmentId);
          const baseRow = world.rows[0];
          // A World with only plain meshes has no LOD selection row; it keeps
          // its projection-only receipt. The same-submit GPU row owns the
          // denominator, which may include selector-only candidates.
          if (selected === undefined || baseRow === undefined) return world;
          return Object.freeze({
            ...world,
            attribution: Object.freeze({
              status: 'same-submit' as const,
              submit: inspection.submit,
            }),
            rows: Object.freeze(
              selected.map((row) => ({
                ...baseRow,
                slot: { primitiveSlot: row.primitiveSlot, slotGeneration: row.slotGeneration },
                count: {
                  candidates: row.candidateCount,
                  visible: row.visible,
                  occluded: row.occluded,
                },
                lodHistogram: row.lodHistogram,
              })),
            ),
          });
        }),
      );
    }
    const observed = inspectLodOcclusion({
      ...inspection,
      count: {
        ...inspection.count,
        candidates: selection.candidateCount,
        visible: selection.visible,
        occluded: selection.occluded,
      },
      lodHistogram: selection.lodHistogram,
      // Per-primitive samples are omitted until the GPU readback carries
      // stable primitive identities; the histogram is the producer fact.
      samples: [],
      worlds,
    });
    this.cell = resolvedCell(observed);
    return observed;
  }

  async observe(
    production: { readLodSelection(): Promise<GpuDrivenLodSelectionInspection | undefined> },
    surface: SurfaceSubmissionObservationOwner,
    receipt?: { readonly frameId: number; readonly deviceGeneration: number },
  ): Promise<LodOcclusionInspection | undefined> {
    const capturedCell = this.cell;
    const capturedInspection = capturedCell?.value();
    const capturedWorldAttachments = this.worldAttachments;
    if (capturedInspection === undefined) return undefined;
    const sameSubmit = (submit: { readonly frameId: number; readonly deviceGeneration: number }) =>
      submit.frameId === capturedInspection.submit.frameId &&
      submit.deviceGeneration === capturedInspection.submit.deviceGeneration;
    const matchesReceipt = (submit: {
      readonly frameId: number;
      readonly deviceGeneration: number;
    }) =>
      receipt === undefined ||
      (submit.frameId === receipt.frameId && submit.deviceGeneration === receipt.deviceGeneration);
    if (!matchesReceipt(capturedInspection.submit)) return undefined;
    const selection = await production.readLodSelection();
    if (
      this.cell !== capturedCell ||
      this.worldAttachments !== capturedWorldAttachments ||
      selection === undefined
    )
      return undefined;
    if (selection.submit !== undefined && !sameSubmit(selection.submit)) return undefined;
    if (
      receipt !== undefined &&
      (selection.submit === undefined || !matchesReceipt(selection.submit))
    )
      return undefined;
    const inspection = this.applySelection(selection, capturedInspection, capturedWorldAttachments);
    if (
      inspection === undefined ||
      this.cell?.value() !== inspection ||
      !sameSubmit(inspection.submit) ||
      inspection.view.cameraEntity !== capturedInspection.view.cameraEntity ||
      inspection.view.viewGeneration !== capturedInspection.view.viewGeneration ||
      inspection.view.attachmentId !== capturedInspection.view.attachmentId
    )
      return undefined;
    if (
      selection.surfaceReadback !== undefined &&
      selection.surfaceActualMemberIds !== undefined &&
      selection.surfaceIndirectParameters !== undefined
    ) {
      surface.publishGpuMembers(
        {
          recording: selection.surfaceReadback,
          memberIds: selection.surfaceActualMemberIds,
          indirectParameters: selection.surfaceIndirectParameters,
        },
        receipt ?? capturedInspection.submit,
      );
    }
    return inspection;
  }
}

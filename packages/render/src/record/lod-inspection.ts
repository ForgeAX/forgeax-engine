import type { AssetHandle } from '@forgeax/engine-types';
import type { GpuDrivenLodSelectionInspection } from '../gpu-driven/view-gpu';
import { selectGpuLodLane } from '../gpu-driven/view-gpu';
import type { LodOcclusionInspection } from '../inspection-types';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { CameraSnapshot } from '../render-contract';
import { type LodOcclusionInspectionCell, resolveInspectionBuild } from '../render-system';
import type { ExtractedFrame, RenderableSnapshot } from '../render-system-extract';

type LodSampleSlotLookup = (
  entity: number,
) => { readonly slot: number; readonly generation: number } | undefined;

import { type FrameList, lodCandidateCountOf, RetainedFrameProjection } from '../scene/frame-list';
import type { PersistentRenderScene } from '../scene/render-scene';
import { SceneSlotFrame } from '../scene/scene-slots';
import { inspectLodOcclusion } from '../scene/visibility/inspection';
import type { SurfaceSubmissionObservationOwner } from '../surface/submission-observation';
import { recordContext } from '../world/view-record-context';
import { cpuLodLevel, lodLevelHistogram } from './cpu-lod';
import type { RenderSystemInternals } from './render-context';

type LodSelection = Pick<
  GpuDrivenLodSelectionInspection,
  'candidateCount' | 'visible' | 'occluded' | 'lodHistogram'
> & { readonly submit?: { readonly frameId: number; readonly deviceGeneration: number } };

interface LodVisibility {
  readonly projection: { readonly renderables: FrameList<RenderableSnapshot> };
}

const resolvedCell = (inspection: LodOcclusionInspection): LodOcclusionInspectionCell => ({
  view: inspection.view,
  submit: inspection.submit,
  value: () => inspection,
});

const ZERO_LOD_LEVEL = (_renderable: RenderableSnapshot): number => 0;
function sampledSlotLookup(
  slots: ReadonlyMap<number, { readonly slot: number; readonly generation: number }>,
): LodSampleSlotLookup {
  return (entityKey) => slots.get(entityKey);
}

/** Only this admitted row projection proves a fixed identity lookup. */
function capturedSlotRoot(renderables: FrameList<RenderableSnapshot>): SceneSlotFrame | undefined {
  return renderables instanceof RetainedFrameProjection &&
    renderables.facts !== undefined &&
    renderables.source instanceof SceneSlotFrame
    ? renderables.source
    : undefined;
}

function hasLod(renderable: RenderableSnapshot): boolean {
  return (renderable.lods?.length ?? 0) > 0;
}

function captureSampleSlot(
  slots: Map<number, { readonly slot: number; readonly generation: number }>,
  scene: PersistentRenderScene,
  renderable: RenderableSnapshot,
): void {
  const key = renderable.entityKey;
  const slot = scene.compositionSlot(renderable.entityKey);
  if (slot !== undefined) slots.set(key, slot);
}

/** Observe borrowed rows once for their current count and detached diagnostic samples. */
function captureSampleSlots(
  renderables: FrameList<RenderableSnapshot>,
  knownCount: number | undefined,
  scene: PersistentRenderScene,
): { readonly candidateCount: number; readonly lookup: LodSampleSlotLookup } {
  const sampleSlots = new Map<number, { readonly slot: number; readonly generation: number }>();
  let sampledRows = 0;
  let sampledLods = knownCount === 0 ? 64 : 0;
  let open = knownCount === 0 ? 1 : 2;
  let candidateCount = knownCount ?? 0;
  for (const renderable of renderables) {
    if (knownCount !== undefined && open === 0) break;
    const rows = sampledRows;
    const lods = sampledLods;
    const lodCandidate = (knownCount === undefined || lods < 64) && hasLod(renderable);
    if (knownCount === undefined && lodCandidate) candidateCount++;
    const lod = lods < 64 && lodCandidate;
    if (rows >= 64 && !lod) continue;
    if (rows < 64) {
      sampledRows = rows + 1;
      if (rows + 1 === 64) open--;
    }
    if (lod) {
      sampledLods = lods + 1;
      if (lods + 1 === 64) open--;
    }
    captureSampleSlot(sampleSlots, scene, renderable);
  }
  return { candidateCount, lookup: sampledSlotLookup(sampleSlots) };
}

/**
 * The LOD/occlusion inspection of the last recorded frame: the CPU projection
 * published at record time and its join with the same-submit GPU selector
 * counters when they are read back.
 */
export class LodInspectionOwner {
  cell: LodOcclusionInspectionCell | undefined;
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
    const owned =
      submissionRenderables instanceof RetainedFrameProjection &&
      submissionRenderables.facts !== undefined;
    const cached = owned ? this.filtered : undefined;
    if (
      cached?.submissionRenderables === submissionRenderables &&
      cached.lodCandidateCount === lodCandidateCount
    )
      return cached.values;
    const values =
      lodCandidateCount > 0 ? submissionRenderables.filter(hasLod) : submissionRenderables;
    this.filtered = owned ? { submissionRenderables, lodCandidateCount, values } : undefined;
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
    sourceScope: RenderResourceScope,
    frameId: number,
  ): number {
    if (camera === undefined) {
      this.cell = undefined;
      return 0;
    }
    const internals = this.internals;
    const renderables = frame.renderables;
    const submissionRenderables = visibility.projection.renderables;
    const root = capturedSlotRoot(renderables);
    let lodCandidateCount: number;
    let sampleSlots: LodSampleSlotLookup;
    if (root !== undefined) {
      lodCandidateCount = lodCandidateCountOf(renderables);
      sampleSlots = root.lookup;
    } else {
      const sampled = captureSampleSlots(
        renderables,
        renderables instanceof RetainedFrameProjection
          ? renderables.facts?.lodCandidateCount
          : undefined,
        this.scene,
      );
      lodCandidateCount = sampled.candidateCount;
      sampleSlots = sampled.lookup;
    }
    const cpuLodLane = selectGpuLodLane(internals.device.caps) === 'cpu';
    // CPU-lane levels read current GPU residency, so fix them at submit time.
    // Only LOD candidates can select a non-zero level.
    let levelOf = ZERO_LOD_LEVEL;
    if (cpuLodLane && lodCandidateCount > 0) {
      const cpuLevels = new Map<RenderableSnapshot, number>();
      for (const renderable of renderables) {
        if (!hasLod(renderable)) continue;
        cpuLevels.set(
          renderable,
          cpuLodLevel(
            renderable,
            internals.gpuStore.getMeshGpuHandles(
              renderable.assetHandle as AssetHandle<'mesh'>,
              sourceScope,
            ),
            camera,
          ),
        );
      }
      levelOf = (renderable: RenderableSnapshot): number => cpuLevels.get(renderable) ?? 0;
    }
    const view = {
      attachmentId: sourceScope?.identity ?? 'none',
      cameraEntity: camera.entityKey ?? 0,
      viewRole: 'main' as const,
      viewGeneration: camera.historyVersion ?? 0,
    };
    const submit = {
      frameId,
      build: resolveInspectionBuild(internals),
      deviceGeneration: recordContext(internals).deviceScope.generation,
    };
    const slotGeneration = this.scene.topologyRevision();
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
      const firstSample = inspectionRenderables.at(0);
      const sampledSlot =
        firstSample === undefined ? undefined : sampleSlots(firstSample.entityKey);
      return inspectLodOcclusion({
        root: {
          guid:
            firstRenderable === undefined ? 'none' : `asset-handle:${firstRenderable.assetHandle}`,
          sourceKey: `render-frame:${frameId}`,
        },
        view,
        slot:
          sampledSlot === undefined
            ? { primitiveSlot: 0, slotGeneration }
            : { primitiveSlot: sampledSlot.slot, slotGeneration: sampledSlot.generation },
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
        samples: inspectionRenderables.slice(0, 64).flatMap((renderable, index) => {
          const slot = sampleSlots(renderable.entityKey);
          return slot === undefined
            ? []
            : [
                {
                  primitiveSlot: slot.slot,
                  level: inspectionLevels[index] ?? 0,
                  visible: true,
                },
              ];
        }),
        submit,
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
  ): LodOcclusionInspection | undefined {
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
      attribution:
        selection.submit === undefined
          ? {
              status: 'unavailable',
              reason: 'projection-only',
            }
          : { status: 'same-submit', submit: inspection.submit },
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
    if (this.cell !== capturedCell || selection === undefined) return undefined;
    if (selection.submit !== undefined && !sameSubmit(selection.submit)) return undefined;
    if (
      receipt !== undefined &&
      (selection.submit === undefined || !matchesReceipt(selection.submit))
    )
      return undefined;
    const inspection = this.applySelection(selection, capturedInspection);
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

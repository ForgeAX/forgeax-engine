import type { World } from '@forgeax/engine-ecs';
import {
  appendedObservationBytes,
  MAX_INSPECTION_SAMPLES,
  MAX_RECEIPT_OBSERVATION_BYTES,
} from '../observation-budget';
import type { DrawObservation, MaterialDrawObservation } from '../render-contract';
import type { ValidatedRenderable } from './frame-snapshot';
import { type RenderableDrawReceipt, selectSubmittedMaterialProgram } from './gpu-draw-receipts';
import type { RenderSystemInternals } from './render-context';

/** One bounded staging list owned by the actual record callback, committed at submit. */
export function createDrawObservation(
  internals: Pick<RenderSystemInternals, 'device' | 'resolvePipelineReference'>,
) {
  const draws: MaterialDrawObservation[] = [];
  let bytes = 2;
  let reason: Extract<DrawObservation, { status: 'unavailable' }>['reason'] | undefined;
  return {
    get collecting(): boolean {
      return reason === undefined;
    },
    /** A GPU-lane draw without a per-row receipt; its lineage is never observable. */
    recordGpuLane(): void {
      reason ??= 'unsupported-lane';
    },
    record(
      entry: Pick<ValidatedRenderable, 'source'>,
      submeshIndex: number | undefined,
      receipt: RenderableDrawReceipt | undefined,
      world: Pick<World, 'identity'> | undefined,
    ) {
      if (reason !== undefined) return;
      if (receipt?.lane === 'gpu' || receipt?.unsupportedLineage === true) {
        reason = 'unsupported-lane';
        return;
      }
      const material = receipt?.material;
      const publication = material?.materialPublication;
      const program = selectSubmittedMaterialProgram(
        publication?.programs,
        receipt?.passIndex !== undefined,
        receipt?.passIndex ?? 0,
        receipt?.programKey,
      );
      if (
        material === undefined ||
        publication === undefined ||
        program === undefined ||
        world === undefined ||
        submeshIndex === undefined
      ) {
        reason = 'source-unavailable';
        return;
      }
      const pipeline =
        receipt?.pipeline === undefined
          ? undefined
          : internals.resolvePipelineReference?.(internals.device, receipt.pipeline);
      if (pipeline === undefined) {
        reason = 'capture-unavailable';
        return;
      }
      if (draws.length >= MAX_INSPECTION_SAMPLES) {
        reason = 'snapshot-too-large';
        return;
      }
      const row: MaterialDrawObservation = Object.freeze({
        worldIdentity: world.identity,
        entityKey: entry.source.entityKey,
        submeshIndex,
        materialHandle: material.materialHandle ?? 0,
        ...(material.sourceAssets === undefined
          ? {}
          : { sourceRevision: material.sourceAssets.revision }),
        publication: publication.identity,
        program,
        pipeline,
      });
      bytes = appendedObservationBytes(bytes, row);
      if (bytes > MAX_RECEIPT_OBSERVATION_BYTES) {
        draws.length = 0;
        reason = 'snapshot-too-large';
      } else draws.push(row);
    },
    commit(ready: boolean): DrawObservation {
      if (!ready) reason ??= 'presentation-pending';
      return reason === undefined
        ? Object.freeze({ status: 'complete', draws: Object.freeze([...draws]) })
        : unavailableDrawObservation(reason);
    },
  };
}

export function unavailableDrawObservation(
  reason: Extract<DrawObservation, { status: 'unavailable' }>['reason'],
): DrawObservation {
  return Object.freeze({ status: 'unavailable', reason, draws: Object.freeze([] as const) });
}

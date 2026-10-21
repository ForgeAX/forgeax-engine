import type { World } from '@forgeax/engine-ecs';
import { MAX_INSPECTION_SAMPLES, MAX_RECEIPT_OBSERVATION_BYTES } from '../observation-budget';
import type { DrawObservation, MaterialDrawObservation } from '../render-contract';
import type { ValidatedRenderable } from './frame-snapshot';
import type { RenderableDrawReceipt } from './gpu-draw-receipts';
import type { RenderSystemInternals } from './render-context';

/** One bounded staging list owned by the actual record callback, committed at submit. */
export function createDrawObservation(
  internals: Pick<RenderSystemInternals, 'device' | 'resolvePipelineReference'>,
) {
  const draws: MaterialDrawObservation[] = [];
  let reason: Extract<DrawObservation, { status: 'unavailable' }>['reason'] | undefined;
  return {
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
      const candidates =
        publication?.programs.filter((p) => p.specializationKey === receipt?.programKey) ?? [];
      const program =
        receipt?.passIndex === undefined
          ? candidates.length === 1
            ? candidates[0]
            : undefined
          : publication?.programs[receipt.passIndex];
      if (
        material === undefined ||
        publication === undefined ||
        program === undefined ||
        program.specializationKey !== receipt?.programKey ||
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
        publication: publication.identity,
        program,
        pipeline,
      });
      draws.push(row);
      if (
        new TextEncoder().encode(JSON.stringify(draws)).byteLength > MAX_RECEIPT_OBSERVATION_BYTES
      ) {
        draws.length = 0;
        reason = 'snapshot-too-large';
      }
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

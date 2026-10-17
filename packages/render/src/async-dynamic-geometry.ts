import type { World } from '@forgeax/engine-ecs';
import { err, type Handle, type Result } from '@forgeax/engine-types';
import {
  type DynamicGeometryCandidate,
  DynamicGeometryError,
  type DynamicGeometryPrepareInput,
  MeshResidencyError,
  type PreparedMeshResidency,
} from './dynamic-geometry';
import type { Renderer } from './render-contract';

/** Source mutation stays synchronous; physical preparation may cross a realm. */
export interface AsyncDynamicGeometryHost
  extends Pick<
    Renderer,
    | 'acceptDynamicGeometry'
    | 'acceptDynamicGeometryCandidates'
    | 'dynamicGeometryReceipt'
    | 'isDynamicGeometryCurrent'
    | 'cancelDynamicGeometry'
    | 'retireDynamicGeometry'
  > {
  currentGeneration(): number | undefined;
  /** Same token preserves currentness answers for the same immutable candidate
   * roster in this World. Undefined requires individual live checks. */
  dynamicGeometryCurrentness?(world: World): object | undefined;
  prepareDynamicGeometry(
    input: DynamicGeometryPrepareInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result<DynamicGeometryCandidate, DynamicGeometryError>>;
  prepareDynamicGeometryCandidates(
    inputs: readonly DynamicGeometryPrepareInput[],
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result<readonly DynamicGeometryCandidate[], DynamicGeometryError>>;
  prepareMeshResidency(
    world: World,
    meshHandle: Handle<'MeshAsset', 'shared'>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result<PreparedMeshResidency, MeshResidencyError>>;
}

/** Adapt an actual local Renderer without changing its synchronous admission owner. */
export function createAsyncDynamicGeometryHost(renderer: Renderer): AsyncDynamicGeometryHost {
  return {
    currentGeneration: () =>
      renderer.state() === 'alive' ? renderer.inspect().frame.deviceGeneration : undefined,
    async prepareDynamicGeometry(input, options) {
      if (options?.signal?.aborted)
        return err(
          new DynamicGeometryError(
            'dynamic-geometry-candidate-state',
            'preparation has not been cancelled',
            'discard the cancelled preparation',
          ),
        );
      const prepared = renderer.prepareDynamicGeometry(input);
      if (!prepared.ok) return prepared;
      const pipelines = await renderer.prepareDynamicGeometryPipelines([prepared.value], options);
      if (!pipelines.ok) {
        const cancelled = renderer.cancelDynamicGeometry(prepared.value);
        return cancelled.ok ? pipelines : cancelled;
      }
      return prepared;
    },
    async prepareDynamicGeometryCandidates(inputs, options) {
      if (options?.signal?.aborted)
        return err(
          new DynamicGeometryError(
            'dynamic-geometry-candidate-state',
            'preparation has not been cancelled',
            'discard the cancelled preparation',
          ),
        );
      const prepared = renderer.prepareDynamicGeometryCandidates(inputs);
      if (!prepared.ok) return prepared;
      const pipelines = await renderer.prepareDynamicGeometryPipelines(prepared.value, options);
      if (!pipelines.ok) {
        let cancellationFailure: DynamicGeometryError | undefined;
        for (const candidate of prepared.value) {
          const cancelled = renderer.cancelDynamicGeometry(candidate);
          if (!cancelled.ok) cancellationFailure ??= cancelled.error;
        }
        return cancellationFailure === undefined ? pipelines : err(cancellationFailure);
      }
      return prepared;
    },
    async prepareMeshResidency(world, meshHandle, options) {
      if (options?.signal?.aborted)
        return err(
          new MeshResidencyError(
            'mesh-residency-gpu-not-ready',
            'preparation has not been cancelled',
            'discard the cancelled preparation',
          ),
        );
      return renderer.prepareMeshResidency(world, meshHandle);
    },
    acceptDynamicGeometry: (candidate, ordering) =>
      renderer.acceptDynamicGeometry(candidate, ordering),
    acceptDynamicGeometryCandidates: (candidates, ordering) =>
      renderer.acceptDynamicGeometryCandidates(candidates, ordering),
    isDynamicGeometryCurrent: (candidate) => renderer.isDynamicGeometryCurrent(candidate),
    dynamicGeometryReceipt: (candidate) => renderer.dynamicGeometryReceipt(candidate),
    cancelDynamicGeometry: (candidate) => renderer.cancelDynamicGeometry(candidate),
    retireDynamicGeometry: (candidate) => renderer.retireDynamicGeometry(candidate),
  };
}

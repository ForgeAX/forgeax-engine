import type { MeshGpuHandles } from '../device/gpu-residency';
import type { BatchExecution } from './batch-execution';
import type { GpuDrivenBatch } from './batch-topology';
import { capturedPreparedMaterialArtifactKey } from './prepared-draw';
import type { PreparedBatchRows } from './production-raster-prepare';

/** Identity facts that let retained batch preparation and plan assembly skip unchanged work. */
export function batchExecutionKey(
  sourceBatch: GpuDrivenBatch,
  execution: Extract<BatchExecution, { readonly route: 'gpu' }>,
) {
  return {
    preparedIdentity: capturedPreparedMaterialArtifactKey(execution.prepared) ?? '',
    pipelineClass: execution.prepared.identity.material,
    resourceIdentity: sourceBatch.key.materialResourceClass,
    admission:
      Number(execution.material.paramSnapshot?.alphaCutoff ?? 0) > 0 ||
      Number(execution.material.paramSnapshot?.alphaHash ?? 0) > 0.5
        ? ('alpha-mask' as const)
        : ('opaque' as const),
    materialPass:
      execution.material.deferredPass === true ? ('deferred' as const) : ('forward-only' as const),
  };
}

export interface PreparedAssemblyInputs {
  readonly batchExecutions: object;
  readonly materials: object | undefined;
  readonly meshes: readonly [object, unknown];
  /** Distinct resident meshes and the content epoch each row captured. */
  readonly meshEpochs: readonly (readonly [MeshGpuHandles, unknown])[];
  /** Distinct author-mutable Pass states and their observed serialization. */
  readonly states: readonly (readonly [object, string])[];
}

export function preparedAssemblyInputs(
  batchExecutions: object,
  materials: object | undefined,
  meshes: readonly [object, unknown],
  batchRows: readonly PreparedBatchRows[],
  serializedStates: ReadonlyMap<object, string>,
): PreparedAssemblyInputs {
  const resident = new Map<MeshGpuHandles, unknown>();
  for (const rows of batchRows)
    if (rows.mesh !== undefined) resident.set(rows.mesh, rows.meshContentEpoch);
  return {
    batchExecutions,
    materials,
    meshes,
    meshEpochs: [...resident],
    states: [...serializedStates],
  };
}

export function samePreparedAssemblyInputs(
  inputs: PreparedAssemblyInputs | undefined,
  batchExecutions: object,
  materials: object | undefined,
  meshes: readonly [object, unknown],
): boolean {
  if (
    inputs === undefined ||
    inputs.batchExecutions !== batchExecutions ||
    inputs.materials !== materials ||
    inputs.meshes[0] !== meshes[0] ||
    inputs.meshes[1] !== meshes[1]
  )
    return false;
  for (const [mesh, epoch] of inputs.meshEpochs) if (mesh.contentEpoch !== epoch) return false;
  for (const [state, serialized] of inputs.states)
    if (JSON.stringify(state) !== serialized) return false;
  return true;
}

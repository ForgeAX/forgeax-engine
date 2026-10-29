import type { MeshGpuHandles } from '../device/gpu-residency';
import type { GpuSceneResourceFrame, GpuSceneResourcePins } from '../gpu-scene';
import { renderStateSignature } from '../material-render-state';
import type { BatchExecution } from './batch-execution';
import type { GpuDrivenBatch } from './batch-topology';
import { capturedPreparedMaterialArtifactKey } from './prepared-draw';
import { type PreparedBatchRows, samePreparedBatchLod } from './production-raster-prepare';

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
  /** Versions the assembly resolved; a later resource frame re-pins them instead of re-joining rows. */
  readonly pins?: GpuSceneResourcePins | undefined;
  /**
   * Producer-owned rows are immutable publications; only their resident LOD
   * ranges remain live. Raw rows never cross a resource frame without a re-join.
   */
  readonly fixedRows?: boolean;
  readonly lodRows?: readonly PreparedBatchRows[];
  readonly meshes: readonly [object, unknown];
  /** Distinct resident meshes and the content epoch each row captured. */
  readonly meshEpochs: readonly (readonly [MeshGpuHandles, unknown])[];
  /** Distinct author-mutable Pass states and their observed serialization. */
  readonly states: readonly (readonly [object, string])[];
}

export function preparedAssemblyInputs(
  batchExecutions: object,
  materials: GpuSceneResourceFrame | undefined,
  meshes: readonly [object, unknown],
  batchRows: readonly PreparedBatchRows[],
  serializedStates: ReadonlyMap<object, string>,
  fixedRows = false,
): PreparedAssemblyInputs {
  const resident = new Map<MeshGpuHandles, unknown>();
  const lodRows: PreparedBatchRows[] = [];
  for (const rows of batchRows) {
    if (rows.mesh !== undefined) resident.set(rows.mesh, rows.meshContentEpoch);
    if (rows.lod !== undefined || rows.source.lod !== undefined) lodRows.push(rows);
  }
  return {
    fixedRows,
    lodRows,
    batchExecutions,
    materials,
    pins: materials?.pins?.(),
    meshes,
    meshEpochs: [...resident],
    states: [...serializedStates],
  };
}

export function samePreparedAssemblyInputs(
  inputs: PreparedAssemblyInputs | undefined,
  batchExecutions: object,
  materials: GpuSceneResourceFrame | undefined,
  meshes: readonly [object, unknown],
): boolean {
  if (
    inputs === undefined ||
    inputs.batchExecutions !== batchExecutions ||
    inputs.meshes[0] !== meshes[0] ||
    inputs.meshes[1] !== meshes[1]
  )
    return false;
  for (const entry of inputs.meshEpochs) if (entry[0].contentEpoch !== entry[1]) return false;
  for (const entry of inputs.states) if (renderStateSignature(entry[0]) !== entry[1]) return false;
  if (inputs.materials === materials) return true;
  if (inputs.fixedRows !== true) return false;
  for (const rows of inputs.lodRows ?? [])
    if (!samePreparedBatchLod(rows.lod, rows.source, rows.mesh)) return false;
  // A new resource frame proves every retained address by re-pinning its versions.
  // This is the last check: adoption pins versions in the current frame.
  return inputs.pins !== undefined && materials?.adoptPins?.(inputs.pins) === true;
}

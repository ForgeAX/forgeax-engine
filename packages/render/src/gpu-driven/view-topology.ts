import type { GpuScene } from '../gpu-scene';
import type { GpuInputReadFrame, GpuTaskHeader } from '../gpu-scene-inputs';
import type { GpuDrivenBatch, SubmissionPlan } from './batch-topology';
import { hasFixedTaskHeaders } from './fixed-task-plan';

/** Active ordinal/counter semantics stay unchanged; static columns live in Inputs. */
export const GPU_VIEW_BATCH_CONTROL_BYTES = 8;
export interface EncodedViewTopology {
  readonly batchBytes: Uint8Array;
  readonly rows: readonly GpuDrivenBatch[];
  readonly headers: readonly GpuTaskHeader[];
  /** Lookup only; Inputs still reobserves columns and validates the live capability. */
  readonly headerById: ReadonlyMap<number, GpuTaskHeader>;
  readonly direct: boolean;
}
const encoded = new WeakMap<GpuScene, WeakMap<SubmissionPlan, EncodedViewTopology>>();

/** Observe one row's explicit or Scene-resolved resource addresses once. */
function taskAddresses(batch: GpuDrivenBatch, scene: GpuScene) {
  const binding = batch.binding;
  const materialAddress = batch.materialAddress;
  const geometryAddress = batch.geometryAddress;
  return {
    direct: materialAddress !== undefined && geometryAddress !== undefined,
    material:
      materialAddress ??
      (binding === undefined ? 0 : (scene.materialIndexForResource(binding.material) ?? 0)),
    geometry:
      geometryAddress ??
      (binding === undefined ? 0 : (scene.geometryIndexForResource(binding.assetHandle) ?? 0)),
  };
}

export function encodedViewTopology(
  plan: SubmissionPlan,
  scene: GpuScene,
  inputs: GpuInputReadFrame,
  previous?: EncodedViewTopology,
): EncodedViewTopology {
  const fixed = hasFixedTaskHeaders(plan);
  const batches = plan.batches;
  let owner = encoded.get(scene);
  const prior = fixed ? (owner?.get(plan) ?? previous) : previous;
  if (
    fixed &&
    owner?.get(plan) === prior &&
    prior?.direct &&
    prior.headers.every((header, index) => {
      const batch = prior.rows[index];
      return batch !== undefined && inputs.reuseHeader(header, batch);
    })
  )
    return prior;
  const words = new Uint32Array(Math.max(1, batches.length) * 2);
  const rows: GpuDrivenBatch[] = [];
  const headers: GpuTaskHeader[] = [];
  const headerById = new Map<number, GpuTaskHeader>();
  let work = 0;
  let index = 0;
  let direct = true;
  for (const batch of batches) {
    const candidates = batch.candidates;
    const batchId = batch.batchId;
    const addresses = taskAddresses(batch, scene);
    direct &&= addresses.direct;
    const header = inputs.header({
      plan,
      index,
      batch,
      candidates,
      materialAddress: addresses.material,
      geometryAddress: addresses.geometry,
      previous: prior?.headerById.get(batchId),
    });
    words[index * 2] = work;
    words[index * 2 + 1] = header.address;
    rows.push(batch);
    headers.push(header);
    headerById.set(batchId, header);
    work += header.candidateCount;
    index++;
  }
  const batchBytes = new Uint8Array(words.buffer);
  if (
    prior !== undefined &&
    prior.headers.length === headers.length &&
    headers.every((header, at) => header === prior.headers[at]) &&
    batchBytes.length === prior.batchBytes.length &&
    batchBytes.every((value, at) => value === prior.batchBytes[at])
  )
    return prior;
  const value = { batchBytes, rows, headers, headerById, direct };
  if (fixed) {
    if (owner === undefined) {
      owner = new WeakMap();
      encoded.set(scene, owner);
    }
    owner.set(plan, value);
  }
  return value;
}

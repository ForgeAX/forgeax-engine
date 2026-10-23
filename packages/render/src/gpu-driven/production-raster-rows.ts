import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { GpuDrivenPreparationError } from '../errors/gpu-driven';
import type { GpuSceneResourceFrame } from '../gpu-scene';
import type { MeshGeometry } from '../scene/mesh-frame';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import type { BatchExecution } from './batch-execution';
import { capturedGpuDrivenBatchKey } from './batch-key';
import { MemberCandidates } from './batch-members';
import type { GpuDrivenBatch, GpuDrivenBatchBinding } from './batch-topology';
import type { BatchExecutions } from './material-artifacts';
import {
  type BatchPreparation,
  type PreparedBatchRows,
  prepareBatchRows,
  sameMaterialArtifact,
  samePreparedBatchLod,
} from './production-raster-prepare';
import { batchExecutionKey } from './retained-batch-inputs';

type RetainedRow = BatchPreparation['batches'] extends Map<number, infer Row> ? Row : never;
type ActiveExecution = Exclude<BatchExecution, { readonly route: 'none' }>;
type ExecutionKey = ReturnType<typeof batchExecutionKey>;

/** Execution facts one row was validated against; they are retained with it. */
interface RowExecutionFacts {
  readonly execution: ActiveExecution;
  readonly materialAddress: number;
  readonly geometryAddress: number | undefined;
  readonly geometry: MeshGeometry | undefined;
  readonly renderState: string | undefined;
}

/** Identity facts both address-proven retention tiers compare. */
function sameRetainedRow(
  retained: RetainedRow,
  sourceBatch: GpuDrivenBatch,
  execution: ActiveExecution,
  renderState: string,
  mesh: MeshGpuHandles | undefined,
): boolean {
  return (
    retained.source === sourceBatch &&
    retained.execution === execution &&
    retained.renderState === renderState &&
    capturedGpuDrivenBatchKey(sourceBatch) !== undefined &&
    retained.value.mesh === mesh &&
    retained.value.meshContentEpoch === mesh?.contentEpoch &&
    samePreparedBatchLod(retained.value.lod, sourceBatch, mesh)
  );
}

function sameCachedSource(cached: RetainedRow, sourceBatch: GpuDrivenBatch, signature: string) {
  return (
    cached.value.source.candidates === sourceBatch.candidates &&
    cached.value.source.generation === sourceBatch.generation &&
    cached.value.source.contentEpoch === sourceBatch.contentEpoch &&
    cached.signature === signature
  );
}

function sameCachedExecutionKey(
  cached: RetainedRow,
  executionKey: ExecutionKey | undefined,
  capturedKey: string | undefined,
): boolean {
  if (executionKey === undefined) return true;
  const key = cached.value.source.key;
  return (
    capturedGpuDrivenBatchKey(cached.source) === capturedKey &&
    key.preparedIdentity === executionKey.preparedIdentity &&
    key.pipelineClass === executionKey.pipelineClass &&
    key.admission === executionKey.admission &&
    key.materialPass === executionKey.materialPass
  );
}

function sameCachedMesh(
  cached: RetainedRow,
  batch: GpuDrivenBatch,
  mesh: MeshGpuHandles | undefined,
): boolean {
  return (
    cached.value.mesh === mesh &&
    cached.value.meshContentEpoch === mesh?.contentEpoch &&
    samePreparedBatchLod(cached.value.lod, batch, mesh)
  );
}

/** A GPU row carries its logical resources and execution key; others copy the source. */
function materializeBatch(
  sourceBatch: GpuDrivenBatch,
  { execution, materialAddress, geometryAddress }: RowExecutionFacts,
  executionKey: ExecutionKey | undefined,
): GpuDrivenBatch {
  if (execution.route !== 'gpu') return Object.freeze({ ...sourceBatch });
  return Object.freeze({
    ...sourceBatch,
    materialAddress,
    logicalResources: true as const,
    ...(geometryAddress === undefined ? {} : { geometryAddress }),
    prepared: execution.prepared,
    key: Object.freeze({
      ...sourceBatch.key,
      ...(executionKey ?? batchExecutionKey(sourceBatch, execution)),
    }),
  });
}

/** resourceIdentity is already in the captured key; serialize only the live facts. */
function liveFactSignature({ execution, materialAddress, geometryAddress }: RowExecutionFacts) {
  return JSON.stringify([
    execution.route,
    materialAddress,
    geometryAddress,
    execution.pass.renderState,
    execution.material.materialHandle,
    execution.material.standardTextureMask,
  ]);
}

function batchSignature(
  { execution, materialAddress, geometryAddress }: RowExecutionFacts,
  batch: GpuDrivenBatch,
): string {
  const gpu = execution.route === 'gpu';
  return JSON.stringify([
    execution.route,
    materialAddress,
    geometryAddress,
    batch.key,
    gpu ? execution.pass.renderState : null,
    gpu ? execution.material.materialHandle : null,
    gpu ? execution.material.standardTextureMask : null,
  ]);
}

/** Retain the observed fields, not the mutable publication wrapper. */
function retainedArtifact(
  artifact: MaterialShaderArtifact | undefined,
): MaterialShaderArtifact | undefined {
  if (artifact === undefined) return undefined;
  return {
    ...artifact,
    ...(artifact.receipt === undefined ? {} : { receipt: { ...artifact.receipt } }),
  };
}

/**
 * One assembly of a pass's prepared batch rows. Each source batch keeps its
 * retained row when its identities still prove it; only new or changed rows
 * are re-joined against the material and geometry tables.
 */
export class BatchRowAssembly {
  sameRows = true;
  fixedMembership = true;
  rebuiltBatches = 0;
  missingArtifact: GpuDrivenPreparationError | undefined;
  readonly serializedStates = new Map<object, string>();
  private readonly previous: BatchPreparation['cached'];
  /**
   * Re-pinning the last assembly's versions proves every retained address in
   * this frame, so an edited plan re-joins only its new or changed rows.
   */
  private readonly pinsAdopted: boolean;

  constructor(
    private readonly preparation: BatchPreparation,
    private readonly pass: 'forward' | 'shadow',
    private readonly scene: PersistentGpuDrivenState,
    private readonly materials: GpuSceneResourceFrame | undefined,
    private readonly batchExecutions: ReadonlyMap<GpuDrivenBatchBinding, BatchExecutions>,
    private readonly meshByBinding: ReadonlyMap<GpuDrivenBatchBinding, MeshGpuHandles>,
    private readonly sameInputs: boolean,
  ) {
    this.previous = preparation.cached;
    const inputs = this.previous?.inputs;
    this.pinsAdopted =
      sameInputs &&
      inputs?.fixedRows === true &&
      inputs.pins !== undefined &&
      materials !== undefined &&
      inputs.materials !== materials &&
      materials.adoptPins?.(inputs.pins) === true;
  }

  assemble(): PreparedBatchRows[] {
    const rows: PreparedBatchRows[] = [];
    for (const sourceBatch of this.scene.plan.batches) {
      const row = this.row(sourceBatch, rows.length);
      if (row !== undefined) rows.push(row);
    }
    return rows;
  }

  private row(sourceBatch: GpuDrivenBatch, index: number): PreparedBatchRows | undefined {
    const nativeMembership = MemberCandidates.is(sourceBatch.candidates);
    this.fixedMembership &&= nativeMembership;
    const binding = sourceBatch.binding;
    const execution =
      binding === undefined ? undefined : this.batchExecutions.get(binding)?.[this.pass];
    if (binding === undefined || execution === undefined)
      throw new GpuDrivenPreparationError('missing-material-receipt', {
        reason: 'material-receipt-missing',
        owner: 'material',
        expected: 'shared material execution for every geometry batch',
      });
    // An absent Pass contributes no work to this view. Direct execution
    // remains in the plan so its real fallback still owns those rows.
    if (execution.route === 'none') return undefined;
    const geometry = this.sceneGeometry(binding, execution);
    const mesh = this.meshByBinding.get(binding);
    const retained = this.preparation.batches.get(sourceBatch.batchId);
    const renderState = this.serializedRenderState(execution);
    const sameRetained =
      nativeMembership &&
      renderState !== undefined &&
      retained !== undefined &&
      sameRetainedRow(retained, sourceBatch, execution, renderState, mesh);
    if (
      sameRetained &&
      this.pinsAdopted &&
      retained.geometry === geometry &&
      retained.materialAddress !== undefined
    ) {
      this.sameRows &&= retained.value === this.previous?.batchRows[index];
      return retained.value;
    }
    const materialAddress = this.materialAddressFor(binding, execution);
    const geometryAddress = this.geometryAddressFor(binding, execution, geometry);
    // Signature, execution key and artifact all derive from these captured identities.
    if (
      sameRetained &&
      this.sameInputs &&
      retained.materialAddress === materialAddress &&
      retained.geometryAddress === geometryAddress
    ) {
      this.sameRows &&= retained.value === this.previous?.batchRows[index];
      if (retained.geometry !== geometry)
        this.preparation.batches.set(sourceBatch.batchId, { ...retained, geometry });
      return retained.value;
    }
    return this.signedRow(
      sourceBatch,
      index,
      nativeMembership,
      { execution, materialAddress, geometryAddress, geometry, renderState },
      mesh,
    );
  }

  /** Scene geometry whose pinned version proves a GPU row's geometry address. */
  private sceneGeometry(
    binding: GpuDrivenBatchBinding,
    execution: ActiveExecution,
  ): MeshGeometry | undefined {
    if (execution.route !== 'gpu') return undefined;
    return this.scene.meshes?.get(binding.worldId, binding.assetHandle);
  }

  /** Shared Pass state is serialized once per assembly, still observing in-place edits. */
  private serializedRenderState(execution: ActiveExecution): string | undefined {
    if (execution.route !== 'gpu') return undefined;
    const state = execution.pass.renderState;
    if (state === undefined) return 'undefined';
    let serialized = this.serializedStates.get(state);
    if (serialized === undefined) {
      serialized = JSON.stringify(state);
      this.serializedStates.set(state, serialized);
    }
    return serialized;
  }

  private materialAddressFor(binding: GpuDrivenBatchBinding, execution: ActiveExecution): number {
    const materialAddress = this.materials?.logicalForResource(
      binding.material,
      execution.material,
    );
    if (materialAddress === undefined)
      throw new GpuDrivenPreparationError('resource-not-ready', {
        reason: 'material-resource-missing',
        owner: 'material',
        expected: 'resident shared material row for the accepted batch',
      });
    return materialAddress;
  }

  private geometryAddressFor(
    binding: GpuDrivenBatchBinding,
    execution: ActiveExecution,
    geometry: MeshGeometry | undefined,
  ): number | undefined {
    const geometryAddress =
      execution.route === 'gpu'
        ? this.materials?.logicalForGeometry(binding.worldId, binding.assetHandle, geometry)
        : undefined;
    if (
      geometry !== undefined &&
      binding.geometry.deformation === 'rigid' &&
      geometryAddress === undefined
    )
      throw new GpuDrivenPreparationError('stale-generation', {
        reason: 'generation-stale',
        owner: 'geometry',
        expected: 'resident shared geometry for the accepted frame',
      });
    return geometryAddress;
  }

  /** Rows whose identities changed compare their signature, then rebase or rebuild. */
  private signedRow(
    sourceBatch: GpuDrivenBatch,
    index: number,
    nativeMembership: boolean,
    facts: RowExecutionFacts,
    mesh: MeshGpuHandles | undefined,
  ): PreparedBatchRows {
    const { execution } = facts;
    const capturedKey = capturedGpuDrivenBatchKey(sourceBatch);
    const executionKey =
      capturedKey !== undefined && execution.route === 'gpu'
        ? batchExecutionKey(sourceBatch, execution)
        : undefined;
    let batch =
      executionKey === undefined ? materializeBatch(sourceBatch, facts, executionKey) : undefined;
    const signature = batch === undefined ? liveFactSignature(facts) : batchSignature(facts, batch);
    const currentBatch = batch ?? sourceBatch;
    const cached = this.preparation.batches.get(currentBatch.batchId);
    const artifact = execution.route === 'gpu' ? execution.artifact : undefined;
    this.noteMissingArtifact(execution, currentBatch, batch);
    if (
      this.sameInputs &&
      nativeMembership &&
      cached !== undefined &&
      sameCachedSource(cached, sourceBatch, signature) &&
      sameCachedExecutionKey(cached, executionKey, capturedKey) &&
      sameMaterialArtifact(cached.artifact, artifact) &&
      sameCachedMesh(cached, currentBatch, mesh)
    ) {
      if (cached.source === sourceBatch) return this.keepCachedRow(cached, index, facts);
      this.sameRows = false;
      // Only the aligned visible window moved; rows keep their facts.
      batch ??= materializeBatch(sourceBatch, facts, executionKey);
      const rebased = Object.freeze({ ...cached.value, source: batch });
      this.preparation.batches.set(currentBatch.batchId, {
        ...cached,
        source: sourceBatch,
        value: rebased,
        ...facts,
      });
      return rebased;
    }
    this.sameRows = false;
    batch ??= materializeBatch(sourceBatch, facts, executionKey);
    const value = prepareBatchRows(batch, { mesh, worldKeys: this.scene.worldKeys, execution });
    this.preparation.batches.set(currentBatch.batchId, {
      source: sourceBatch,
      signature,
      artifact: retainedArtifact(artifact),
      value,
      ...facts,
    });
    this.rebuiltBatches += 1;
    return value;
  }

  private keepCachedRow(
    cached: RetainedRow,
    index: number,
    facts: RowExecutionFacts,
  ): PreparedBatchRows {
    this.sameRows &&= cached.value === this.previous?.batchRows[index];
    if (cached.execution !== facts.execution || cached.renderState !== facts.renderState)
      this.preparation.batches.set(cached.source.batchId, { ...cached, ...facts });
    return cached.value;
  }

  /** A failed artifact publication cannot admit filtered or GPU work. */
  private noteMissingArtifact(
    execution: ActiveExecution,
    currentBatch: GpuDrivenBatch,
    batch: GpuDrivenBatch | undefined,
  ): void {
    if (this.missingArtifact !== undefined || execution.route !== 'gpu') return;
    const prepared = batch !== undefined ? batch.prepared : execution.prepared;
    if (
      execution.artifact === undefined &&
      currentBatch.candidates.length > 0 &&
      prepared?.receiptIdentity !== undefined
    ) {
      this.missingArtifact = new GpuDrivenPreparationError('missing-material-receipt', {
        reason: 'material-receipt-missing',
        owner: 'material',
        expected: `published artifact for ${prepared.identity.material} (${prepared.receiptIdentity}@${prepared.receiptGeneration})`,
      });
    }
  }
}

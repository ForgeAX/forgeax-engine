import { err, ok, type Result, RhiError } from '@forgeax/engine-rhi';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { GpuDrivenPreparationError } from '../errors/gpu-driven';
import type {
  GpuScene,
  GpuSceneResourceFrame,
  GpuSceneResourceHold,
  GpuSceneResourcePins,
} from '../gpu-scene';
import { renderStateSignature } from '../material-render-state';
import type { MeshGeometry } from '../scene/mesh-frame';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import type { BatchExecution } from './batch-execution';
import { capturedGpuDrivenBatchKey } from './batch-key';
import { MemberCandidates } from './batch-members';
import {
  type GpuDrivenBatch,
  type GpuDrivenBatchBinding,
  matchesResidentGroupBatch,
  matchesResidentGroupPlan,
  type ResidentGroupPlan,
  type SubmissionPlan,
} from './batch-topology';
import { hasCapturedTaskMembership } from './fixed-task-plan';
import type { BatchExecutions } from './material-artifacts';
import {
  type BatchPreparation,
  type PreparedBatchRows,
  prepareBatchRows,
  rebasePreparedBatchRows,
  sameMaterialArtifact,
  samePreparedBatchLod,
} from './production-raster-prepare';
import { batchExecutionKey } from './retained-batch-inputs';

type RetainedRow = BatchPreparation['batches'] extends Map<number, infer Row> ? Row : never;
type ActiveExecution = Exclude<BatchExecution, { readonly route: 'none' }>;
type ExecutionKey = ReturnType<typeof batchExecutionKey>;

export interface ResidentBatchPreparationInput {
  readonly scene: PersistentGpuDrivenState;
  readonly plan: SubmissionPlan;
  readonly index: number;
  readonly pass: 'forward' | 'shadow';
  /** An issuing topology may preserve this group's original tasks through unrelated edits. */
  readonly groupPlan?: ResidentGroupPlan;
  readonly executions: ReadonlyMap<GpuDrivenBatchBinding, BatchExecutions>;
  readonly meshes: ReadonlyMap<GpuDrivenBatchBinding, MeshGpuHandles>;
  /** Source owner evidence, rechecked around this synchronous contribution. */
  readonly isCurrent: () => boolean;
}

/** Revalidatable cache facts only; these records hold no physical resource version. */
export type ProvisionalBatchContribution =
  | { readonly kind: 'no-pass' }
  | {
      readonly kind: 'provisional';
      readonly row: PreparedBatchRows;
      readonly pins: GpuSceneResourcePins;
    };

export type ResidentBatchSetInput = Omit<ResidentBatchPreparationInput, 'index' | 'pass'> & {
  readonly contributions: readonly ProvisionalBatchContribution[];
};

/** Scene-version custody for exactly these rows, not native Mesh/Texture/PSO readiness. */
export interface HeldResidentBatchRows {
  readonly forward: readonly PreparedBatchRows[];
  readonly shadow: readonly PreparedBatchRows[];
  isCurrent(): boolean;
  release(): void;
}

interface ContributionProof {
  readonly preparation: BatchPreparation;
  readonly scene: GpuScene;
  readonly plan: SubmissionPlan;
  readonly index: number;
  readonly pass: 'forward' | 'shadow';
}
interface ContributionRecord {
  readonly value: ProvisionalBatchContribution;
  readonly proof: ContributionProof;
}
const contributionProofs = new WeakMap<ProvisionalBatchContribution, ContributionProof>();

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
  private readonly addressesProven: boolean;
  private deferred: { entry?: RetainedRow } | undefined;

  /** One contribution, one current read domain, no active aggregate publication. */
  static prepareContribution(
    preparation: BatchPreparation,
    input: ResidentBatchPreparationInput,
  ): Result<ProvisionalBatchContribution, RhiError | GpuDrivenPreparationError> {
    const scene = input.scene.scene;
    if (
      !hasCapturedTaskMembership(input.plan) ||
      !Number.isSafeInteger(input.index) ||
      input.index < 0
    )
      return err(invalidContribution());
    if (!currentContribution(input, scene)) return err(staleContribution());
    const batch = input.plan.batches.at(input.index);
    const candidates = batch?.candidates;
    if (
      batch === undefined ||
      (input.groupPlan !== undefined &&
        !matchesResidentGroupBatch(input.groupPlan, input.plan, batch)) ||
      capturedGpuDrivenBatchKey(batch) === undefined ||
      !MemberCandidates.is(candidates) ||
      batch.members !== candidates.membersFrame()
    )
      return err(invalidContribution());
    const captured = scene.captureResources();
    if (!captured.ok) return captured;
    const frame = captured.value;
    const assembly = new BatchRowAssembly(
      preparation,
      input.pass,
      input.scene,
      frame,
      input.executions,
      input.meshes,
      true,
      'contribution',
    );
    assembly.deferred = {};
    let result: Result<ProvisionalBatchContribution, RhiError | GpuDrivenPreparationError>;
    try {
      result = assembly.probeContribution(batch, frame, input, scene);
    } catch (cause) {
      if (!(cause instanceof RhiError || cause instanceof GpuDrivenPreparationError)) throw cause;
      result = err(cause);
    } finally {
      frame.release();
    }
    if (!result.ok) return result;
    const current = currentContribution(input, scene);
    if (current === undefined) return err(staleContribution());
    preparation.retireAbsent(current);
    if (assembly.deferred.entry !== undefined)
      preparation.batches.set(batch.batchId, assembly.deferred.entry);
    else if (result.value.kind === 'no-pass') preparation.batches.delete(batch.batchId);
    contributionProofs.set(result.value, {
      preparation,
      scene,
      plan: input.plan,
      index: input.index,
      pass: input.pass,
    });
    return result;
  }

  /** Existing issuance, group scope and producer guard also fence downstream row staging. */
  static isCurrentContribution(
    preparation: BatchPreparation,
    input: ResidentBatchPreparationInput,
    value: ProvisionalBatchContribution,
  ): boolean {
    const proof = contributionProofs.get(value);
    if (
      proof === undefined ||
      proof.preparation !== preparation ||
      proof.scene !== input.scene.scene ||
      proof.plan !== input.plan ||
      proof.index !== input.index ||
      proof.pass !== input.pass
    )
      return false;
    if (input.groupPlan !== undefined) {
      const batch = input.plan.batches.at(input.index);
      if (batch === undefined || !matchesResidentGroupBatch(input.groupPlan, input.plan, batch))
        return false;
    }
    return currentContribution(input, proof.scene) !== undefined;
  }

  static acceptContributions(
    preparations: Readonly<Record<'forward' | 'shadow', BatchPreparation>>,
    input: ResidentBatchSetInput,
  ): Result<HeldResidentBatchRows, RhiError | GpuDrivenPreparationError> {
    const scene = input.scene.scene;
    if (!currentContribution(input, scene)) return err(staleContribution());
    const records = qualifiedContributions(preparations, input);
    if (records === undefined) return err(invalidContribution());
    const captured = scene.captureResources();
    if (!captured.ok) return captured;
    const frame = captured.value;
    let transferred: GpuSceneResourceHold | undefined;
    let accepted = false;
    try {
      for (const { value } of records)
        if (value.kind === 'provisional' && frame.adoptPins?.(value.pins) !== true)
          return err(staleContribution());
      const assemblies = {
        forward: new BatchRowAssembly(
          preparations.forward,
          'forward',
          input.scene,
          frame,
          input.executions,
          input.meshes,
          true,
          'contribution',
        ),
        shadow: new BatchRowAssembly(
          preparations.shadow,
          'shadow',
          input.scene,
          frame,
          input.executions,
          input.meshes,
          true,
          'contribution',
        ),
      };
      assemblies.forward.deferred = {};
      assemblies.shadow.deferred = {};
      const rows = BatchRowAssembly.currentRows(assemblies, input.plan, records);
      if (!rows.ok) return rows;
      if (!currentContribution(input, scene)) return err(staleContribution());
      const sealed = frame.seal();
      if (!sealed.ok) return sealed;
      if (!currentContribution(input, scene)) return err(staleContribution());
      const held = scene.holdMaterialRoots(frame);
      if (!held.ok) return held;
      transferred = held.value;
      if (!currentContribution(input, scene) || !held.value.isCurrent())
        return err(staleContribution());
      const result = Object.freeze({
        forward: Object.freeze(rows.value.forward),
        shadow: Object.freeze(rows.value.shadow),
        isCurrent: held.value.isCurrent,
        release: () => held.value.release(),
      });
      accepted = true;
      return ok(result);
    } catch (cause) {
      if (cause instanceof RhiError || cause instanceof GpuDrivenPreparationError)
        return err(cause);
      throw cause;
    } finally {
      if (!accepted) {
        if (transferred === undefined) frame.release();
        else transferred.release();
      }
    }
  }

  private static currentRows(
    assemblies: Readonly<Record<'forward' | 'shadow', BatchRowAssembly>>,
    plan: SubmissionPlan,
    records: readonly ContributionRecord[],
  ): Result<
    Record<'forward' | 'shadow', PreparedBatchRows[]>,
    RhiError | GpuDrivenPreparationError
  > {
    const rows: Record<'forward' | 'shadow', PreparedBatchRows[]> = { forward: [], shadow: [] };
    for (const { value, proof } of records) {
      const batch = plan.batches.at(proof.index);
      if (batch === undefined) return err(staleContribution());
      const assembly = assemblies[proof.pass];
      const row = assembly.row(batch, -1);
      if (assembly.missingArtifact !== undefined) return err(assembly.missingArtifact);
      if (!matchesContribution(value, row)) return err(staleContribution());
      if (row !== undefined) rows[proof.pass].push(row);
    }
    return ok(rows);
  }

  private probeContribution(
    batch: GpuDrivenBatch,
    frame: GpuSceneResourceFrame,
    input: ResidentBatchPreparationInput,
    scene: GpuScene,
  ): Result<ProvisionalBatchContribution, RhiError | GpuDrivenPreparationError> {
    const row = this.row(batch, -1);
    if (this.missingArtifact !== undefined) return err(this.missingArtifact);
    if (!currentContribution(input, scene)) return err(staleContribution());
    const sealed = frame.seal();
    if (!sealed.ok) return sealed;
    if (!currentContribution(input, scene)) return err(staleContribution());
    if (row === undefined) return ok(Object.freeze({ kind: 'no-pass' }));
    const pins = frame.pins?.();
    if (pins === undefined)
      return err(
        new RhiError({
          code: 'internal-error',
          expected: 'resource pins from the actual GPU Scene read owner',
          hint: 'rebuild the GPU Scene resource owner before retrying resident work',
        }),
      );
    return ok(Object.freeze({ kind: 'provisional', row, pins }));
  }

  private store(id: number, row: RetainedRow): void {
    if (this.deferred === undefined) this.preparation.batches.set(id, row);
    else this.deferred.entry = row;
  }

  constructor(
    private readonly preparation: BatchPreparation,
    private readonly pass: 'forward' | 'shadow',
    private readonly scene: PersistentGpuDrivenState,
    private readonly materials: GpuSceneResourceFrame | undefined,
    private readonly batchExecutions: ReadonlyMap<GpuDrivenBatchBinding, BatchExecutions>,
    private readonly meshByBinding: ReadonlyMap<GpuDrivenBatchBinding, MeshGpuHandles>,
    private readonly sameInputs: boolean,
    readScope: 'aggregate' | 'contribution' = 'aggregate',
  ) {
    this.previous = preparation.cached;
    const inputs = this.previous?.inputs;
    this.pinsAdopted =
      readScope === 'aggregate' &&
      sameInputs &&
      inputs?.fixedRows === true &&
      inputs.pins !== undefined &&
      materials !== undefined &&
      inputs.materials !== materials &&
      materials.adoptPins?.(inputs.pins) === true;
    // An unchanged resource frame already resolved every retained address.
    this.addressesProven =
      this.pinsAdopted ||
      (readScope === 'aggregate' &&
        sameInputs &&
        inputs?.fixedRows === true &&
        materials !== undefined &&
        inputs.materials === materials);
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
    this.noteMissingArtifact(execution, sourceBatch, undefined);
    const mesh = this.meshByBinding.get(binding);
    const retained = this.preparation.batches.get(sourceBatch.batchId);
    const geometry = this.geometryForRow(
      sourceBatch,
      binding,
      execution,
      nativeMembership,
      retained,
    );
    const renderState = this.serializedRenderState(execution);
    const sameRetained =
      nativeMembership &&
      renderState !== undefined &&
      retained !== undefined &&
      sameRetainedRow(retained, sourceBatch, execution, renderState, mesh);
    if (sameRetained && this.hasAggregateAddressProof(retained, geometry)) {
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
        this.store(sourceBatch.batchId, { ...retained, geometry });
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

  private geometryForRow(
    sourceBatch: GpuDrivenBatch,
    binding: GpuDrivenBatchBinding,
    execution: ActiveExecution,
    nativeMembership: boolean,
    retained: RetainedRow | undefined,
  ): MeshGeometry | undefined {
    // An unchanged immutable Mesh frame and captured binding still name the
    // exact geometry already joined by this row. Instance/member changes do
    // not require another tree lookup; borrowed rows retain their live read.
    return this.sameInputs &&
      nativeMembership &&
      execution.route === 'gpu' &&
      retained?.execution?.route === 'gpu' &&
      retained.source.binding === binding &&
      capturedGpuDrivenBatchKey(sourceBatch) !== undefined &&
      capturedGpuDrivenBatchKey(retained.source) !== undefined &&
      this.previous?.inputs?.meshes[1] === this.scene.meshes
      ? retained.geometry
      : this.sceneGeometry(binding, execution);
  }

  private hasAggregateAddressProof(
    retained: RetainedRow,
    geometry: MeshGeometry | undefined,
  ): boolean {
    return (
      this.addressesProven &&
      this.preparation.coversCachedRow(retained.value) &&
      retained.geometry === geometry &&
      retained.materialAddress !== undefined
    );
  }

  /** Scene geometry whose pinned version proves a GPU row's geometry address. */
  private sceneGeometry(
    binding: GpuDrivenBatchBinding,
    execution: ActiveExecution,
  ): MeshGeometry | undefined {
    if (execution.route !== 'gpu') return undefined;
    return this.scene.meshes?.get(binding.assetHandle);
  }

  /** Shared Pass state is serialized once per assembly, still observing in-place edits. */
  private serializedRenderState(execution: ActiveExecution): string | undefined {
    if (execution.route !== 'gpu') return undefined;
    const state = execution.pass.renderState;
    if (state === undefined) return 'undefined';
    let serialized = this.serializedStates.get(state);
    if (serialized === undefined) {
      serialized = renderStateSignature(state);
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
        ? this.materials?.logicalForGeometry(binding.assetHandle, geometry)
        : undefined;
    // Morphed rows carry their own bounds; they hold no shared geometry row.
    if (
      geometry !== undefined &&
      binding.geometry.deformation === 'rigid' &&
      binding.morph === undefined &&
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
      const rebased = rebasePreparedBatchRows(cached.value, batch, sourceBatch);
      this.store(currentBatch.batchId, {
        ...cached,
        source: sourceBatch,
        value: rebased,
        ...facts,
      });
      return rebased;
    }
    this.sameRows = false;
    batch ??= materializeBatch(sourceBatch, facts, executionKey);
    const value = prepareBatchRows(batch, { mesh, execution }, sourceBatch);
    this.store(currentBatch.batchId, {
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
      this.store(cached.source.batchId, { ...cached, ...facts });
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

function currentContribution(
  input: Pick<ResidentBatchPreparationInput, 'scene' | 'plan' | 'groupPlan' | 'isCurrent'>,
  scene: GpuScene,
): SubmissionPlan | undefined {
  const revision = scene.syncRevision;
  if (input.isCurrent() !== true) return undefined;
  const current = input.scene.residentExecution ?? input.scene.plan;
  const matches =
    input.groupPlan === undefined
      ? current === input.plan
      : matchesResidentGroupPlan(input.groupPlan, input.plan, current);
  return matches && scene.live && scene.syncRevision === revision && input.scene.scene === scene
    ? current
    : undefined;
}

function matchesContribution(
  value: ProvisionalBatchContribution,
  row: PreparedBatchRows | undefined,
): boolean {
  return value.kind === 'no-pass' ? row === undefined : row === value.row;
}

function qualifiedContributions(
  preparations: Readonly<Record<'forward' | 'shadow', BatchPreparation>>,
  input: ResidentBatchSetInput,
): ContributionRecord[] | undefined {
  if (!hasCapturedTaskMembership(input.plan)) return undefined;
  const records: ContributionRecord[] = [];
  const last = { forward: -1, shadow: -1 };
  for (const value of input.contributions) {
    const proof = contributionProofs.get(value);
    if (
      proof === undefined ||
      proof.preparation !== preparations[proof.pass] ||
      proof.scene !== input.scene.scene ||
      proof.plan !== input.plan ||
      proof.index <= last[proof.pass]
    )
      return undefined;
    if (input.groupPlan !== undefined) {
      const batch = input.plan.batches.at(proof.index);
      if (batch === undefined || !matchesResidentGroupBatch(input.groupPlan, input.plan, batch))
        return undefined;
    }
    last[proof.pass] = proof.index;
    records.push({ value, proof });
  }
  return records;
}

function staleContribution(): GpuDrivenPreparationError {
  return new GpuDrivenPreparationError('stale-generation', {
    reason: 'generation-stale',
    owner: 'generation',
    expected: 'the same current resident contribution and source-owner guard',
  });
}

function invalidContribution(): RhiError {
  return new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'one owned native resident contribution at its current index',
    hint: 'prepare producer-owned resident tasks using the actual source-owner guard',
  });
}

import type { TextureFormat } from '@forgeax/engine-rhi';
import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import { findMaterialShaderEntry } from '@forgeax/engine-shader';
import { isTriangleTopology, type MaterialRenderState } from '@forgeax/engine-types';
import { GpuDrivenPreparationError } from '../errors/gpu-driven';
import { artifactAlphaMask, maskedInEarlyPassVariantSet } from '../material-alpha-mask';
import { reflectedRenderState, seededDepthRenderState } from '../material-render-state';
import type { MaterialResource } from '../material-resource';
import { rasterColorFormat, standardSurfaceDiscardMask } from '../material-stage-constants';
import { SKIN_UNCOVERED_GBUFFER_ENTRY } from '../pbr-pipeline';
import { PREDEPTH_FRAGMENT_ENTRY, predepthCoversMaterial } from '../predepth-coverage';
import { captureDispatchOverlays, type DispatchOverlays } from '../record/dispatch-overlays';
import type { DrawRows, ValidatedRenderable } from '../record/frame-snapshot';
import {
  geometryRenderStateForPass,
  variantSetForCoveragePass,
} from '../record/main-pass-geometry';
import type { RenderSystemInternals } from '../record/render-context';
import {
  STANDARD_OPAQUE_FRAGMENT_ENTRY,
  selectStandardForwardScreenEntry,
} from '../record/standard-opaque-entry';
import type { FramePresentationPendingReason } from '../render-contract';
import type { RenderPipelineGpuDrivenFilter } from '../render-pipeline';
import type { DispatchList, MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { CapturedSceneTransform } from '../scene/captured-transform';
import { GenerationalWeakMap } from '../scene/generational-weak-map';
import type { AcceptedMaterial, MaterialDispatchPass } from '../scene/material-dispatch';
import { MaterialFrame, selectMaterialPrograms } from '../scene/material-dispatch';
import { BatchExecutionTable } from './batch-execution-table';
import { materialBindingLayout } from './fixed-task-plan';
import { withFrameLighting } from './pbr-program';
import { capturedPreparedMaterialArtifactKey, type PreparedGpuDrivenDraw } from './prepared-draw';
import { lodCoverageMayFade } from './production-raster-lod';
import { requestMaterialAbiRasterPipeline } from './production-raster-material';
import { materialBatchClass } from './row-materials';

type MaterialPrograms = {
  readonly materialHandle: number;
  readonly forward: readonly MaterialDispatchPass[];
  readonly shadow: readonly MaterialDispatchPass[];
};

import {
  type BatchArtifactResolver,
  type BatchExecution,
  type BatchGeometryAdmission,
  type BatchPass,
  captureBatchGeometryAdmission,
  prepareBatchExecution,
} from './batch-execution';
import {
  eligibleGpuDrivenDraws,
  type GpuDrivenBatch,
  type GpuDrivenBatchBinding,
} from './batch-topology';

const NO_EXECUTION: BatchExecution = Object.freeze({ route: 'none' });

import { isVelocityRasterEntry } from './raster-selection';

export interface BatchExecutions {
  readonly forward: BatchExecution;
  readonly shadow: BatchExecution;
}

interface MaterialProgramSelection {
  logicalMaterialShaderId: string;
  sceneIndexProgramKey: string | undefined;
  materialShaderId: string;
}

/** The two addresses belong to one authored Pass. A specialization ID already selects its ABI. */
export function sceneIndexKeyForPass(
  material: MaterialSnapshot,
  pass: 'forward' | 'shadow',
  directId: string | undefined,
): string | undefined {
  if (directId === undefined) return undefined;
  for (const name in material.materialSceneIndexProgramKeys) {
    const program = material.materialSceneIndexProgramKeys[name];
    if (program?.pass === pass && material.materialProgramKeys?.[name] === directId)
      return program.specializationKey;
  }
  return undefined;
}

/** Select the direct/scene program pair published for this concrete pass. */
export function gpuDrivenMaterialProgramSelection(
  material: MaterialSnapshot,
  prepared: PreparedGpuDrivenDraw,
  pass: 'forward' | 'shadow',
  shadowEntry: { readonly materialShaderId?: string | undefined } | undefined,
  out: MaterialProgramSelection,
) {
  const logicalMaterialShaderId = material.materialShaderId ?? prepared.identity.material;
  const sceneIndexProgramKeys = material.materialSceneIndexProgramKeys;
  const shadowMaterialShaderId = pass === 'shadow' ? shadowEntry?.materialShaderId : undefined;
  const directMaterialShaderId =
    pass === 'shadow' ? shadowMaterialShaderId : logicalMaterialShaderId;
  const sceneIndexProgramKey = sceneIndexKeyForPass(material, pass, directMaterialShaderId);
  if (sceneIndexProgramKeys !== undefined && sceneIndexProgramKey === undefined) return undefined;
  const materialShaderId =
    pass === 'shadow'
      ? (sceneIndexProgramKey ?? shadowEntry?.materialShaderId ?? logicalMaterialShaderId)
      : (sceneIndexProgramKey ?? logicalMaterialShaderId);
  out.logicalMaterialShaderId = logicalMaterialShaderId;
  out.sceneIndexProgramKey = sceneIndexProgramKey;
  out.materialShaderId = materialShaderId;
  return out;
}

export interface GpuDrivenMaterialProgramIndex {
  readonly dispatch: DispatchList;
  readonly materials: MaterialFrame;
  get(
    material: MaterialResource,
  ): (MaterialPrograms & { readonly snapshot: MaterialSnapshot }) | undefined;
  readonly overlays: DispatchOverlays;
}

/** Whether a staged GPU shadow route still describes the current material programs. */
export function gpuShadowProgramsCompatible(
  previous: GpuDrivenMaterialProgramIndex | undefined,
  current: GpuDrivenMaterialProgramIndex | undefined,
): boolean {
  if (previous === undefined || current === undefined) return false;
  if (previous === current) return true;
  if (previous.materials.hasBorrowedValues || current.materials.hasBorrowedValues) return false;
  if (previous.materials === current.materials) return true;
  let compatible = true;
  current.materials.changesSince(previous.materials, (before, after) => {
    if (!compatible) return;
    if (before === undefined || after === undefined) {
      compatible = false;
      return;
    }
    if (before.snapshot === after.snapshot) return;
    // The batch owner already defines which program, binding and route facts
    // permit one GPU execution to serve different numeric material values.
    // Raw/custom programs without that proof keep the conservative CPU demand.
    const beforeClass = materialBatchClass(before.snapshot);
    compatible = beforeClass !== undefined && beforeClass === materialBatchClass(after.snapshot);
  });
  return compatible;
}

// Accepted versions are replaced as materials change; see GenerationalWeakMap.
const sharedProgramSelections = new GenerationalWeakMap<
  AcceptedMaterial,
  MaterialPrograms & { readonly snapshot: MaterialSnapshot }
>();

/** Fixed program reads and dispatch overlays have different producer lifetimes. */
class CapturedMaterialProgramIndex implements GpuDrivenMaterialProgramIndex {
  readonly #materials: MaterialFrame;
  declare readonly overlays: DispatchOverlays;

  constructor(
    readonly dispatch: DispatchList,
    readonly materials: MaterialFrame,
  ) {
    this.#materials = materials;
    let overlays: DispatchOverlays | undefined;
    Object.defineProperty(this, 'overlays', {
      enumerable: true,
      configurable: true,
      get: () => (overlays ??= captureDispatchOverlays(dispatch)),
    });
  }

  readonly get = (material: MaterialResource) => {
    const accepted = this.#materials.get(material);
    if (accepted === undefined) return undefined;
    if (accepted.programs !== undefined) return accepted.programs;
    let programs = sharedProgramSelections.get(accepted);
    if (programs !== undefined) return programs;
    programs = selectMaterialPrograms(accepted.snapshot, accepted.passes);
    sharedProgramSelections.set(accepted, programs);
    return programs;
  };

  readonly #get = this.get;

  /** A producer-owned fixed root, never a borrowed getter or a raw index signature. */
  static materialRoot(index: GpuDrivenMaterialProgramIndex | undefined): MaterialFrame | undefined {
    if (index === undefined || index === null || !(#materials in index)) return undefined;
    if (
      Object.getPrototypeOf(index) !== CapturedMaterialProgramIndex.prototype ||
      Object.getOwnPropertyDescriptor(index, 'get')?.value !== index.#get
    )
      return undefined;
    return MaterialFrame.fixedProgramRoot(index.#materials);
  }
}

/** The program index reads fixed shared material roots, without expanding dispatch members. */
export class GpuDrivenMaterialProgramProjection {
  private current: GpuDrivenMaterialProgramIndex | undefined;
  project(dispatch: DispatchList, materials: MaterialFrame): GpuDrivenMaterialProgramIndex {
    if (this.current?.dispatch === dispatch && this.current.materials === materials)
      return this.current;
    this.current = new CapturedMaterialProgramIndex(dispatch, materials);
    return this.current;
  }
  clear(): void {
    this.current = undefined;
  }
}

interface MaterialArtifactRead {
  readonly shader: string;
  readonly key: number;
  readonly request: Parameters<BatchArtifactResolver>[1];
  readonly artifact: MaterialShaderArtifact | undefined;
  /** Scalar proof only. A read never retains the collection that last consumed it. */
  verified: symbol | undefined;
}

const NO_SHADER_READS: readonly MaterialArtifactRead[] = Object.freeze([]);

/** A source address has one observation across the forward and shadow bindings of this join. */
class BatchArtifactReads {
  private stamp?: symbol;
  private selected?: Map<string, Map<number, MaterialArtifactRead>>;
  private active?: MaterialArtifactRead[];

  get reads(): readonly MaterialArtifactRead[] {
    return this.active ?? NO_SHADER_READS;
  }

  constructor(
    private readonly resolve: BatchArtifactResolver | undefined,
    private readonly clustered: boolean,
    private readonly probeBlend: boolean,
    private readonly reflectionFallback: boolean,
  ) {}

  /** Replay a whole fixed input without allocating. A changed address and all earlier
   * observations enter the new join exactly once, even for a live resolver. */
  static begin(
    previous: readonly MaterialArtifactRead[],
    resolve: BatchArtifactResolver | undefined,
    clustered: boolean,
    probeBlend: boolean,
    reflectionFallback: boolean,
  ): BatchArtifactReads | undefined {
    for (let i = 0; i < previous.length; i++) {
      const read = previous[i] as MaterialArtifactRead;
      const artifact = resolve?.(read.shader, read.request);
      if (artifact === read.artifact) continue;
      const next = new BatchArtifactReads(resolve, clustered, probeBlend, reflectionFallback);
      for (let j = 0; j <= i; j++) {
        const sampled = previous[j] as MaterialArtifactRead;
        next.variants(sampled.shader).set(sampled.key, {
          ...sampled,
          artifact: j === i ? artifact : sampled.artifact,
          verified: undefined,
        });
      }
      return next;
    }
    return undefined;
  }

  private variants(shader: string) {
    this.selected ??= new Map();
    let variants = this.selected.get(shader);
    if (variants === undefined) {
      variants = new Map();
      this.selected.set(shader, variants);
    }
    return variants;
  }

  private observe(shader: string, request: Parameters<BatchArtifactResolver>[1], key: number) {
    const variants = this.variants(shader);
    let read = variants.get(key);
    if (read === undefined) {
      const options =
        request.pass === 'forward'
          ? {
              ...request,
              clustered: this.clustered,
              probeBlend: this.probeBlend,
              reflectionFallback: this.reflectionFallback,
            }
          : { ...request };
      read = {
        shader,
        key,
        request: options,
        artifact: this.resolve?.(shader, options),
        verified: undefined,
      };
      variants.set(key, read);
    }
    // A primed address no longer used by the new route drops out of its published dependencies.
    if (read.verified === undefined) {
      this.active ??= [];
      this.active.push(read);
    }
    this.stamp ??= Symbol();
    read.verified = this.stamp;
    return read;
  }

  capture(
    shader: string,
    request: Parameters<BatchArtifactResolver>[1],
    out: MaterialArtifactRead[],
  ) {
    const read = this.observe(shader, request, artifactRequestKey(request));
    out.push(read);
    return read.artifact;
  }

  current(reads: readonly MaterialArtifactRead[]): boolean {
    for (const read of reads) if (!this.currentRead(read)) return false;
    return true;
  }

  currentRead(read: MaterialArtifactRead): boolean {
    if (this.stamp !== undefined && read.verified === this.stamp) return true;
    if (this.observe(read.shader, read.request, read.key).artifact !== read.artifact) return false;
    read.verified = this.stamp;
    return true;
  }
}

interface RetainedBatchExecution {
  admission?: BatchGeometryAdmission | undefined;
  readonly directShadow: boolean;
  readonly snapshot: MaterialSnapshot;
  readonly passes: readonly MaterialDispatchPass[];
  readonly geometry: GpuDrivenBatchBinding['geometry'];
  readonly reads: readonly MaterialArtifactRead[];
  readonly execution: BatchExecution;
}

type PassExecution = Pick<RetainedBatchExecution, 'reads' | 'execution'>;
const NO_PASS: PassExecution = { reads: NO_SHADER_READS, execution: NO_EXECUTION };

/** An issued pair carries its own shader dependencies across frame and retention replacement. */
class PublishedBatchExecutions implements BatchExecutions {
  readonly forward: BatchExecution;
  readonly shadow: BatchExecution;
  readonly #forwardReads: readonly MaterialArtifactRead[];
  readonly #shadowReads: readonly MaterialArtifactRead[];
  constructor(forward: PassExecution, shadow: PassExecution) {
    this.forward = forward.execution;
    this.shadow = shadow.execution;
    this.#forwardReads = forward.reads;
    this.#shadowReads = shadow.reads;
  }
  current(observed: BatchArtifactReads): boolean {
    return observed.current(this.#forwardReads) && observed.current(this.#shadowReads);
  }
  registerInputs(
    inputs: BatchExecutionInputs,
    row: number,
    previous?: PublishedBatchExecutions,
  ): void {
    inputs.replaceReads(
      row,
      previous === undefined ? NO_SHADER_READS : previous.#forwardReads,
      this.#forwardReads,
    );
    inputs.replaceReads(
      row,
      previous === undefined ? NO_SHADER_READS : previous.#shadowReads,
      this.#shadowReads,
    );
  }

  sameReads(other: PublishedBatchExecutions): boolean {
    return this.#forwardReads === other.#forwardReads && this.#shadowReads === other.#shadowReads;
  }
}

interface ShaderBindingReaders {
  read: MaterialArtifactRead;
  readonly rows: Set<number>;
}

/** Dependencies of the most recently accepted join. Published draw tables own their values separately. */
class BatchExecutionInputs {
  private readonly materials = new Map<MaterialResource, number | number[]>();
  private readonly shaders = new Map<string, Map<number, ShaderBindingReaders>>();
  private readonly marked: Uint8Array;
  readonly rows: Uint32Array;
  count = 0;

  private mark(row: number): void {
    if (this.marked[row] === 1) return;
    this.marked[row] = 1;
    this.rows[this.count++] = row;
  }

  finish(): void {
    for (let i = 0; i < this.count; i++) this.marked[this.rows[i] as number] = 0;
    this.count = 0;
  }

  constructor(table: BatchExecutionTable) {
    this.marked = new Uint8Array(table.size);
    this.rows = new Uint32Array(table.size);
    let row = 0;
    table.forEach((pair, binding) => {
      const prior = this.materials.get(binding.material);
      if (prior === undefined) this.materials.set(binding.material, row);
      else if (Array.isArray(prior)) prior.push(row);
      else this.materials.set(binding.material, [prior, row]);
      if (pair instanceof PublishedBatchExecutions) pair.registerInputs(this, row);
      row++;
    });
  }

  markMaterial(resource: MaterialResource): void {
    const bindings = this.materials.get(resource);
    if (Array.isArray(bindings)) for (const binding of bindings) this.mark(binding);
    else if (bindings !== undefined) this.mark(bindings);
  }

  markShaders(observed: BatchArtifactReads): void {
    for (const variants of this.shaders.values())
      for (const group of variants.values()) {
        // If every reader will select a new pass, let those reads establish current demand.
        for (const binding of group.rows) {
          if (this.marked[binding] === 1) continue;
          if (!observed.currentRead(group.read)) for (const reader of group.rows) this.mark(reader);
          break;
        }
      }
  }

  replaceReads(
    row: number,
    before: readonly MaterialArtifactRead[],
    after: readonly MaterialArtifactRead[],
  ): void {
    if (before === after) return;
    for (const old of before) {
      if (hasShaderAddress(after, old)) continue;
      const variants = this.shaders.get(old.shader);
      const group = variants?.get(old.key);
      if (!variants || !group) throw new Error('Batch shader reader lost its dependency');
      group.rows.delete(row);
      if (group.rows.size === 0) variants.delete(old.key);
      if (variants.size === 0) this.shaders.delete(old.shader);
    }
    for (const read of after) {
      let variants = this.shaders.get(read.shader);
      if (variants === undefined) {
        variants = new Map();
        this.shaders.set(read.shader, variants);
      }
      let group = variants.get(read.key);
      if (group === undefined) {
        group = { read, rows: new Set() };
        variants.set(read.key, group);
      }
      group.read = read;
      group.rows.add(row);
    }
  }
}

function hasShaderAddress(
  reads: readonly MaterialArtifactRead[],
  address: MaterialArtifactRead,
): boolean {
  for (const read of reads)
    if (read.key === address.key && read.shader === address.shader) return true;
  return false;
}

/**
 * Renderer-lifetime execution joins. An execution is a pure function of its
 * accepted snapshot, selected Pass entries, geometry and resolved artifacts, so
 * pose-only frames reuse it while every artifact it read still resolves
 * identically. Accepted wrappers are re-projected per frame; their snapshot and
 * Pass entries keep identity across parameter-free frames.
 */
export class GpuDrivenMaterialExecutionRetention {
  private readonly entries = {
    forward: new WeakMap<GpuDrivenBatchBinding, RetainedBatchExecution>(),
    shadow: new WeakMap<GpuDrivenBatchBinding, RetainedBatchExecution>(),
  };
  reused = 0;
  prepared = 0;
  /**
   * Inputs of the last complete join. A collection is a pure function of its
   * batch roster, accepted programs, frame flags and the artifacts its distinct
   * reads resolved, so identical inputs return the last join without visiting a batch.
   */
  lastInputs:
    | {
        readonly bindings: object | symbol;
        readonly programs: object | undefined;
        readonly frame: MaterialFrame | undefined;
        readonly flags: number;
        readonly reads: readonly MaterialArtifactRead[];
        readonly collected: IssuedMaterialArtifacts;
        readonly dependencies?: BatchExecutionInputs | undefined;
      }
    | undefined;
  get(
    kind: 'forward' | 'shadow',
    binding: GpuDrivenBatchBinding,
    programs: MaterialPrograms & { readonly snapshot: MaterialSnapshot },
    observed: BatchArtifactReads,
    directShadow: boolean,
  ): RetainedBatchExecution | undefined {
    const entry = this.entries[kind].get(binding);
    const passes = programs[kind];
    if (
      entry === undefined ||
      entry.directShadow !== directShadow ||
      entry.snapshot !== programs.snapshot ||
      entry.geometry !== binding.geometry ||
      entry.passes.length !== passes.length
    )
      return undefined;
    for (let index = 0; index < passes.length; index++)
      if (entry.passes[index] !== passes[index]) return undefined;
    if (!observed.current(entry.reads)) return undefined;
    this.reused++;
    return entry;
  }
  geometryAdmission(kind: 'forward' | 'shadow', binding: GpuDrivenBatchBinding) {
    return this.entries[kind].get(binding)?.admission;
  }
  set(kind: 'forward' | 'shadow', binding: GpuDrivenBatchBinding, entry: RetainedBatchExecution) {
    this.prepared++;
    const previous = this.geometryAdmission(kind, binding);
    entry.admission =
      entry.execution.route === 'gpu' && previous?.prepared === entry.execution.prepared
        ? previous
        : captureBatchGeometryAdmission(binding.geometry, entry.execution);
    this.entries[kind].set(binding, entry);
  }

  publish(
    input: NonNullable<GpuDrivenMaterialExecutionRetention['lastInputs']>,
    last: IssuedMaterialArtifacts | undefined,
  ) {
    const { collected } = input;
    const published =
      last !== undefined &&
      last.firstSkinArtifact === collected.firstSkinArtifact &&
      sameOrderedEntries(last.batchExecutions, collected.batchExecutions, sameBatchExecutions) &&
      sameOrderedEntries(last.materialArtifacts, collected.materialArtifacts, Object.is) &&
      sameOrderedEntries(last.shadowMaterialArtifacts, collected.shadowMaterialArtifacts, Object.is)
        ? last
        : collected;
    this.lastInputs = { ...input, collected: published };
    return published;
  }
}

const REQUEST_PASS_BITS = { forward: 0, shadow: 1, depth: 2 } as const;

/** The request fields that vary under the fixed scene-index address, packed to a number. */
function artifactRequestKey(request: Parameters<BatchArtifactResolver>[1]): number {
  return (
    REQUEST_PASS_BITS[request.pass] |
    (request.deformation === 'skin' ? 4 : 0) |
    (request.vertexColorAvailable ? 8 : 0) |
    (request.alphaMask ? 16 : 0) |
    (request.leanInputs ? 32 : 0) |
    (request.tangentFrame32 ? 64 : 0)
  );
}

/** Each renderer's artifact resolver owns one retention; recovery installs a new resolver. */
const resolverRetention = new WeakMap<object, GpuDrivenMaterialExecutionRetention>();

export type MaterialArtifactDemand =
  | 'forward'
  | 'shadow'
  | 'forward-and-shadow'
  | 'forward-with-direct-shadows';

/** Resolve shared geometry/material/Pass executions without inspecting batch members. */
export function collectGpuDrivenMaterialArtifacts({
  batches,
  resolve,
  canAwaitSource,
  clustered,
  reflectionFallback,
  probeBlend,
  demand,
  programs,
  retention = resolve === undefined ? undefined : resolverRetention.get(resolve),
}: {
  readonly batches: Iterable<Pick<GpuDrivenBatch, 'binding'>>;
  readonly resolve: RenderSystemInternals['getMaterialShaderArtifact'];
  readonly canAwaitSource?: (shaderId: string) => boolean;
  readonly clustered: boolean;
  readonly reflectionFallback: boolean;
  readonly probeBlend: boolean;
  readonly demand: MaterialArtifactDemand;
  readonly programs: GpuDrivenMaterialProgramIndex | undefined;
  readonly retention?: GpuDrivenMaterialExecutionRetention;
}): CollectedMaterialArtifacts {
  if (retention === undefined && resolve !== undefined) {
    retention = new GpuDrivenMaterialExecutionRetention();
    resolverRetention.set(resolve, retention);
  }
  const needsForward = demand !== 'shadow';
  const needsShadow = demand !== 'forward';
  const directShadows = demand === 'forward-with-direct-shadows';
  const flags =
    (clustered ? 1 : 0) |
    (reflectionFallback ? 2 : 0) |
    (probeBlend ? 4 : 0) |
    (needsForward ? 8 : 0) |
    (needsShadow ? 16 : 0) |
    (directShadows ? 32 : 0);
  const frame = CapturedMaterialProgramIndex.materialRoot(programs);
  const programIdentity = frame ?? programs;
  const retainedInputs = retention?.lastInputs;
  const previous =
    retainedInputs !== undefined &&
    retainedInputs.programs === programIdentity &&
    retainedInputs.flags === flags
      ? retainedInputs
      : undefined;
  const bindings = materialBindingLayout(batches) ?? batches;
  let observed: BatchArtifactReads;
  if (previous?.bindings === bindings) {
    const changed = BatchArtifactReads.begin(
      previous.reads,
      resolve,
      clustered,
      probeBlend,
      reflectionFallback,
    );
    if (changed === undefined) return previous.collected;
    observed = changed;
  } else observed = new BatchArtifactReads(resolve, clustered, probeBlend, reflectionFallback);
  // Per-binding entries below can change before a pending or failed collection finishes.
  // Only a complete publish restores their association with an accepted roster.
  if (retention !== undefined) retention.lastInputs = undefined;
  let materialArtifacts: Map<string, MaterialShaderArtifact> | undefined;
  let shadowMaterialArtifacts: Map<string, MaterialShaderArtifact> | undefined;
  let firstSkinArtifact: MaterialShaderArtifact | undefined;
  let sourcePreparationPending = false;
  const select = (
    material: MaterialSnapshot,
    entry: MaterialDispatchPass | undefined,
    kind: 'forward' | 'shadow',
  ): BatchPass | undefined => {
    if (entry?.materialShaderId === undefined) return undefined;
    const shaderId = entry.materialShaderId;
    const sceneIndexProgramKey =
      kind === 'shadow' && directShadows
        ? undefined
        : sceneIndexKeyForPass(material, kind, shaderId);
    return {
      kind,
      shaderId,
      ...(sceneIndexProgramKey === undefined ? {} : { sceneIndexProgramKey }),
      ...(entry.renderState === undefined ? {} : { renderState: entry.renderState }),
      queue: entry.queue,
      ...(entry.vertexEntry === undefined ? {} : { vertexEntry: entry.vertexEntry }),
      ...(entry.fragmentEntry === undefined ? {} : { fragmentEntry: entry.fragmentEntry }),
    };
  };
  // Only new or invalidated bindings require program lookup and pass selection.
  const prepareBinding = (binding: GpuDrivenBatchBinding): BatchExecutions => {
    const accepted = programs?.get(binding.material);
    if (accepted === undefined)
      throw new GpuDrivenPreparationError('missing-material-receipt', {
        reason: 'material-receipt-missing',
        owner: 'material',
        expected: 'a fixed material version from the scene owner',
      });
    const prepare = (kind: 'forward' | 'shadow'): PassExecution => {
      if (kind === 'shadow' && !isTriangleTopology(binding.geometry.draw.topology)) return NO_PASS;
      const directShadow = kind === 'shadow' && directShadows;
      const reused = retention?.get(kind, binding, accepted, observed, directShadow);
      if (reused !== undefined) return reused;
      let reads: MaterialArtifactRead[] | undefined;
      const execution = join(kind, (shader, request) => {
        reads ??= [];
        return observed.capture(shader, request, reads);
      });
      const pass = {
        directShadow,
        snapshot: accepted.snapshot,
        passes: accepted[kind],
        geometry: binding.geometry,
        reads: reads ?? NO_SHADER_READS,
        execution,
      };
      if (!sourcePreparationPending) retention?.set(kind, binding, pass);
      return pass;
    };
    const join = (
      kind: 'forward' | 'shadow',
      selectArtifact: BatchArtifactResolver,
    ): BatchExecution => {
      const passes = accepted[kind];
      const pass = select(accepted.snapshot, passes[0], kind);
      if (pass !== undefined && (passes.length > 1 || (kind === 'shadow' && directShadows)))
        return { route: 'direct', material: accepted.snapshot, pass };
      if (
        pass !== undefined &&
        accepted.snapshot.materialSceneIndexProgramKeys !== undefined &&
        pass.sceneIndexProgramKey === undefined
      )
        return { route: 'direct', material: accepted.snapshot, pass };
      const execution = prepareBatchExecution(
        binding.geometry,
        accepted.snapshot,
        pass,
        selectArtifact,
        retention?.geometryAdmission(kind, binding),
      );
      if (!execution.ok) {
        if (
          execution.error.code === 'missing-material-receipt' &&
          pass !== undefined &&
          canAwaitSource?.(pass.sceneIndexProgramKey ?? pass.shaderId) === true
        ) {
          sourcePreparationPending = true;
          return NO_EXECUTION;
        }
        if (execution.error.detail.recovery !== 'route-cpu-lane' || pass === undefined)
          throw execution.error;
        return { route: 'direct', material: accepted.snapshot, pass, reason: execution.error };
      }
      // A morph batch needs a vertex stage that reads the GPU Scene morph rows.
      if (
        binding.morph === true &&
        execution.value.route === 'gpu' &&
        !readsSceneMorphInputs(execution.value.artifact)
      )
        return { route: 'direct', material: accepted.snapshot, pass: execution.value.pass };
      return execution.value;
    };
    return new PublishedBatchExecutions(
      needsForward ? prepare('forward') : NO_PASS,
      needsShadow ? prepare('shadow') : NO_PASS,
    );
  };
  const currentBinding = (binding: GpuDrivenBatchBinding, prior?: BatchExecutions) =>
    prior instanceof PublishedBatchExecutions && prior.current(observed)
      ? prior
      : prepareBinding(binding);
  let forwardOwners: Map<string, GpuDrivenBatchBinding> | undefined;
  let shadowOwners: Map<string, GpuDrivenBatchBinding> | undefined;
  let firstSkinOwner: GpuDrivenBatchBinding | undefined;
  const collectArtifacts = (
    { forward, shadow }: BatchExecutions,
    binding: GpuDrivenBatchBinding,
  ) => {
    const forwardKey =
      forward.route === 'gpu' ? capturedPreparedMaterialArtifactKey(forward.prepared) : undefined;
    if (forward.route === 'gpu' && forwardKey !== undefined) {
      materialArtifacts ??= new Map();
      materialArtifacts.set(forwardKey, forward.artifact);
      forwardOwners ??= new Map();
      forwardOwners.set(forwardKey, binding);
      // Admission already proved this pass consumes paired Skin vertex inputs.
      // Selecting its task layout does not rescan immutable program contracts.
      if (firstSkinArtifact === undefined && forward.prepared.identity.deformation === 'skin') {
        firstSkinArtifact = forward.artifact;
        firstSkinOwner = binding;
      }
    }
    if (shadow.route === 'gpu') {
      const key = capturedPreparedMaterialArtifactKey(shadow.prepared);
      if (key !== undefined) {
        shadowMaterialArtifacts ??= new Map();
        shadowMaterialArtifacts.set(key, shadow.artifact);
        shadowOwners ??= new Map();
        shadowOwners.set(key, binding);
      }
    }
  };
  let batchExecutions: BatchExecutionTable;
  let publicationBaseline = retainedInputs?.collected;
  let dependencies: BatchExecutionInputs | undefined;
  // An issued layout identifies ordered bindings independently of instance windows.
  // Reconcile that roster against changed Scene leaves and live shader reads.
  if (
    typeof bindings === 'symbol' &&
    retainedInputs?.bindings === bindings &&
    retainedInputs.flags === flags &&
    retainedInputs.frame !== undefined &&
    frame !== undefined
  ) {
    const last = retainedInputs.collected;
    dependencies = retainedInputs.dependencies ?? new BatchExecutionInputs(last.batchExecutions);
    const reconciled = reconcileMaterialExecutions(
      last,
      retainedInputs.frame,
      frame,
      dependencies,
      observed,
      currentBinding,
    );
    batchExecutions = reconciled.executions;
    if (reconciled.artifactLayoutChanged) {
      publicationBaseline = undefined;
      batchExecutions.forEach(collectArtifacts);
    } else {
      const collected =
        batchExecutions === last.batchExecutions
          ? last
          : projectBatchArtifacts(last, batchExecutions);
      if (sourcePreparationPending) return { ...collected, sourcePreparationPending: true };
      if (retention !== undefined)
        retention.lastInputs = {
          bindings,
          programs: programIdentity,
          frame,
          flags,
          reads: observed.reads,
          collected,
          dependencies,
        };
      return collected;
    }
  } else {
    batchExecutions = BatchExecutionTable.collect(batches, requireBatchBinding, (binding) => {
      const current = currentBinding(binding, previous?.collected.batchExecutions.get(binding));
      collectArtifacts(current, binding);
      return current;
    });
  }
  const firstArtifact = materialArtifacts?.values().next().value;
  const collected: IssuedMaterialArtifacts = {
    materialArtifacts: materialArtifacts ?? new Map(),
    shadowMaterialArtifacts: shadowMaterialArtifacts ?? new Map(),
    firstArtifact,
    firstSkinArtifact,
    forwardOwners,
    shadowOwners,
    firstSkinOwner,
    batchExecutions,
    ...(sourcePreparationPending ? { sourcePreparationPending: true } : {}),
  };
  if (retention === undefined || sourcePreparationPending) return collected;
  return retention.publish(
    {
      bindings,
      programs: programIdentity,
      frame,
      flags,
      reads: observed.reads,
      collected,
      dependencies,
    },
    publicationBaseline,
  );
}

export interface CollectedMaterialArtifacts {
  readonly sourcePreparationPending?: true;
  readonly materialArtifacts: ReadonlyMap<string, MaterialShaderArtifact>;
  readonly shadowMaterialArtifacts: ReadonlyMap<string, MaterialShaderArtifact>;
  readonly firstArtifact: MaterialShaderArtifact | undefined;
  readonly firstSkinArtifact: MaterialShaderArtifact | undefined;
  readonly batchExecutions: ReadonlyMap<GpuDrivenBatchBinding, BatchExecutions>;
}

/** Captured pass executions depend on one material leaf and their specific shader reads. */
interface IssuedMaterialArtifacts extends CollectedMaterialArtifacts {
  readonly forwardOwners: ReadonlyMap<string, GpuDrivenBatchBinding> | undefined;
  readonly shadowOwners: ReadonlyMap<string, GpuDrivenBatchBinding> | undefined;
  readonly firstSkinOwner: GpuDrivenBatchBinding | undefined;
  readonly batchExecutions: BatchExecutionTable;
}

/** Each key keeps its last contributing binding in roster order, independently of new draw values. */
function projectBatchArtifacts(
  last: IssuedMaterialArtifacts,
  batchExecutions: BatchExecutionTable,
): IssuedMaterialArtifacts {
  const selected = (binding: GpuDrivenBatchBinding, pass: 'forward' | 'shadow') => {
    const draw = batchExecutions.get(binding)?.[pass];
    if (draw?.route !== 'gpu') throw new Error('Published shader owner lost its GPU route');
    return draw.artifact;
  };
  const project = (
    previous: ReadonlyMap<string, MaterialShaderArtifact>,
    owners: IssuedMaterialArtifacts['forwardOwners'],
    pass: 'forward' | 'shadow',
  ) => {
    let edited: Map<string, MaterialShaderArtifact> | undefined;
    owners?.forEach((binding, key) => {
      const next = selected(binding, pass);
      if (next !== previous.get(key)) {
        edited ??= new Map(previous);
        edited.set(key, next);
      }
    });
    return edited ?? previous;
  };
  const materialArtifacts = project(last.materialArtifacts, last.forwardOwners, 'forward');
  return {
    ...last,
    batchExecutions,
    materialArtifacts,
    shadowMaterialArtifacts: project(last.shadowMaterialArtifacts, last.shadowOwners, 'shadow'),
    firstArtifact:
      materialArtifacts === last.materialArtifacts
        ? last.firstArtifact
        : materialArtifacts.values().next().value,
    firstSkinArtifact:
      last.firstSkinOwner === undefined ? undefined : selected(last.firstSkinOwner, 'forward'),
  };
}

function requireBatchBinding(batch: Pick<GpuDrivenBatch, 'binding'>): GpuDrivenBatchBinding {
  if (batch.binding === undefined)
    throw new GpuDrivenPreparationError('missing-material-receipt', {
      reason: 'material-receipt-missing',
      owner: 'material',
      expected: 'a geometry and material binding from the scene owner',
    });
  return batch.binding;
}

function reconcileMaterialExecutions(
  last: IssuedMaterialArtifacts,
  previousFrame: MaterialFrame,
  frame: MaterialFrame,
  inputs: BatchExecutionInputs,
  observed: BatchArtifactReads,
  currentBinding: (binding: GpuDrivenBatchBinding, prior?: BatchExecutions) => BatchExecutions,
) {
  if (frame !== previousFrame) {
    frame.changesSince(previousFrame, (before, after) => {
      if (
        before?.snapshot === after?.snapshot &&
        before?.passes === after?.passes &&
        before?.programs === after?.programs
      )
        return;
      const resource = (after ?? before)?.resource;
      if (resource !== undefined) inputs.markMaterial(resource);
    });
  }

  inputs.markShaders(observed);
  let artifactLayoutChanged = false;
  const executions = last.batchExecutions.reconcile(
    (prior, binding, row) => {
      const current = currentBinding(binding);
      if (current === prior || sameBatchExecutions(current, prior)) return prior;
      if (current instanceof PublishedBatchExecutions && prior instanceof PublishedBatchExecutions)
        current.registerInputs(inputs, row, prior);
      artifactLayoutChanged ||=
        !sameArtifactSlot(prior.forward, current.forward) ||
        !sameArtifactSlot(prior.shadow, current.shadow);
      return current;
    },
    inputs.rows,
    inputs.count,
  );
  inputs.finish();
  return { executions, artifactLayoutChanged };
}

/** Ordered artifact maps and the first skinned artifact depend only on these draw facts. */
function sameArtifactSlot(before: BatchExecution, after: BatchExecution): boolean {
  if (before === after) return true;
  if (before.route !== 'gpu' || after.route !== 'gpu')
    return before.route !== 'gpu' && after.route !== 'gpu';
  if (before.prepared === after.prepared) return true;
  const key = capturedPreparedMaterialArtifactKey(before.prepared);
  return (
    key === capturedPreparedMaterialArtifactKey(after.prepared) &&
    (key === undefined ||
      before.prepared.identity.deformation === after.prepared.identity.deformation)
  );
}

function sameBatchExecutions(left: BatchExecutions, right: BatchExecutions): boolean {
  return (
    left === right ||
    (left.forward === right.forward &&
      left.shadow === right.shadow &&
      left instanceof PublishedBatchExecutions &&
      right instanceof PublishedBatchExecutions &&
      left.sameReads(right))
  );
}

function sameOrderedEntries<K, V>(
  left: ReadonlyMap<K, V>,
  right: ReadonlyMap<K, V>,
  same: (left: V, right: V) => boolean,
): boolean {
  if (left.size !== right.size) return false;
  const other = right.entries();
  for (const [key, value] of left) {
    const next = other.next();
    if (next.done === true || next.value[0] !== key || !same(value, next.value[1])) return false;
  }
  return true;
}

/** Explicit candidate rows use the same geometry/material join as retained scene batches. */
const hiddenPreparations = new WeakMap<
  RenderableSnapshot,
  {
    readonly draws: ReturnType<typeof eligibleGpuDrivenDraws>;
    readonly programs: GpuDrivenMaterialProgramProjection;
    readonly forward: GpuDrivenMaterialExecutionRetention;
    readonly shadow: GpuDrivenMaterialExecutionRetention;
  }
>();
const EMPTY_HIDDEN_DISPATCH: DispatchList = Object.freeze([]);

export function* prepareHiddenMaterialExecutions(
  entry: ValidatedRenderable,
  materials: MaterialFrame | undefined,
  pass: 'forward' | 'shadow',
  resolve: RenderSystemInternals['getMaterialShaderArtifact'],
  canAwaitSource?: (identifier: string) => boolean,
) {
  // A validated source owns fixed geometry and bindings. Frame validation may
  // wrap that same source in a new entry. Do not recapture
  // those bindings for every hidden PSO lane: doing so defeats the ordinary
  // execution retention, even when the material and shader are unchanged.
  // Sources are weak keys; no frame context, device or resolver is retained here.
  let retained = materials === undefined ? undefined : hiddenPreparations.get(entry.source);
  if (retained === undefined && materials !== undefined) {
    retained = {
      draws: eligibleGpuDrivenDraws(entry.source),
      programs: new GpuDrivenMaterialProgramProjection(),
      forward: new GpuDrivenMaterialExecutionRetention(),
      shadow: new GpuDrivenMaterialExecutionRetention(),
    };
    hiddenPreparations.set(entry.source, retained);
  }
  const draws = retained?.draws ?? eligibleGpuDrivenDraws(entry.source);
  if (draws.length === 0) return;
  let fixed = materials;
  if (fixed === undefined) {
    fixed = new MaterialFrame(undefined);
    for (const draw of draws) fixed = fixed.with(draw.binding.material);
  }
  const programs = (retained?.programs ?? new GpuDrivenMaterialProgramProjection()).project(
    EMPTY_HIDDEN_DISPATCH,
    fixed,
  );
  const collected = collectGpuDrivenMaterialArtifacts({
    batches: draws,
    resolve,
    ...(canAwaitSource === undefined ? {} : { canAwaitSource }),
    programs,
    clustered: false,
    reflectionFallback: false,
    probeBlend: false,
    demand: pass,
    ...(retained === undefined ? {} : { retention: retained[pass] }),
  });
  for (const draw of draws) {
    const execution = collected.batchExecutions.get(draw.binding)?.[pass];
    if (execution !== undefined) yield { draw, execution };
  }
}
/** The raster class's pass state (production-raster-classes shapeRenderState) for a hidden row. */
function hiddenRenderState(
  state: MaterialRenderState | undefined,
  selected: MaterialShaderArtifact,
  pass: {
    readonly coverageOnly: boolean;
    readonly seededDepth?: boolean;
    readonly opaqueDepthPrimed?: boolean;
  },
  transform: RenderableSnapshot['transform'],
): MaterialRenderState | undefined {
  const passState =
    pass.seededDepth === true && predepthCoversMaterial(selected, state)
      ? seededDepthRenderState(state, artifactAlphaMask(selected.variantSet))
      : geometryRenderStateForPass(
          state,
          isVelocityRasterEntry(selected.fragmentEntry) ? 'temporal' : 'forward',
          pass.coverageOnly,
          undefined,
          selected.fragmentEntry,
          pass.opaqueDepthPrimed ?? false,
        );
  return reflectedRenderState(passState, CapturedSceneTransform.reflected(transform));
}

/** A seeded masked row selects the program without its alpha discard (maskedInEarlyPassVariantSet). */
function seededHiddenArtifact(
  artifact: MaterialShaderArtifact,
  state: MaterialRenderState | undefined,
  seeded: boolean,
): MaterialShaderArtifact {
  if (!seeded || !predepthCoversMaterial(artifact, state)) return artifact;
  const variantSet = maskedInEarlyPassVariantSet(
    artifact.variantSet,
    state,
    seededDepthRenderState(state, artifactAlphaMask(artifact.variantSet)),
    artifact.fragmentEntry,
  );
  return variantSet === undefined || variantSet === artifact.variantSet
    ? artifact
    : { ...artifact, variantSet };
}

/** Only explicitly requested hidden rows; admission and PSO specification are shared with real raster. */
function hiddenMaterialMatchesFilter(
  filter: RenderPipelineGpuDrivenFilter | undefined,
  medium: boolean,
  deferredPass: boolean | undefined,
): boolean {
  return !(
    (filter === 'single-layer-medium' && !medium) ||
    ((filter === 'opaque' || filter === 'deferred-opaque' || filter === 'forward-only-opaque') &&
      medium) ||
    (filter === 'deferred-opaque' && deferredPass !== true) ||
    (filter === 'forward-only-opaque' && deferredPass === true)
  );
}

export function prepareHiddenGpuDrivenPipelines(input: {
  readonly entries: DrawRows;
  readonly materials?: MaterialFrame | undefined;
  readonly resolve?: RenderSystemInternals['getMaterialShaderArtifact'];
  readonly shaders: RenderSystemInternals['shaderRegistry'];
  readonly artifacts: ReadonlyMap<string, MaterialShaderArtifact> | undefined;
  readonly factory: NonNullable<RenderSystemInternals['getMaterialShaderPipelineEntry']>;
  readonly formats: readonly TextureFormat[];
  readonly sampleCount: 1 | 4;
  readonly shaderUvSetCount: number;
  readonly filter: RenderPipelineGpuDrivenFilter | undefined;
  readonly fragmentEntry: string | undefined;
  readonly coverageOnly: boolean;
  /** Forward opaque over the exact prepass depth (see seededDepthRenderState). */
  readonly seededDepth?: boolean;
  readonly opaqueDepthPrimed?: boolean;
  readonly visibleSurface: boolean;
  readonly directionalShadowSimple?: boolean;
  readonly leanLighting?: boolean;
  readonly forwardInlineSsr?: boolean;
  /** The recording view carries camera clipping planes; absent keeps them off. */
  readonly viewClipping?: boolean;
  /** The same admitted source draw belongs to this pass's indirect lane. */
  readonly onSelected?: (entry: ValidatedRenderable, sourceDrawIndex: number) => void;
  readonly onPending?: (reason: FramePresentationPendingReason) => void;
}): boolean {
  let ready = true;
  for (const entry of input.entries) {
    if (entry.source.authorVisible !== false) continue;
    for (const { draw, execution } of prepareHiddenMaterialExecutions(
      entry,
      input.materials,
      'forward',
      input.resolve,
      (identifier) => {
        if (input.shaders?.isMaterialArtifactPreparationPending(identifier) !== true) return false;
        ready = false;
        input.onPending?.({
          code: 'scene-pipeline-preparation',
          entity: entry.source.entityKey,
          pass: 'forward',
          shader: identifier,
        });
        return true;
      },
    )) {
      if (execution.route !== 'gpu') continue;
      const { prepared, material, artifact } = execution;
      if (
        !hiddenMaterialMatchesFilter(
          input.filter,
          artifact.receipt?.surface?.model === 'single-layer-medium',
          material.deferredPass,
        )
      )
        continue;
      if (
        input.fragmentEntry === PREDEPTH_FRAGMENT_ENTRY &&
        !predepthCoversMaterial(artifact, material.renderState)
      )
        continue;
      input.onSelected?.(entry, draw.sourceDrawIndex);
      const fragment =
        input.fragmentEntry === 'fs_gbuffer' &&
        prepared.identity.deformation === 'skin' &&
        input.visibleSurface
          ? SKIN_UNCOVERED_GBUFFER_ENTRY
          : selectStandardForwardScreenEntry(input.fragmentEntry, artifact.fragmentEntry);
      const passArtifact =
        fragment === undefined
          ? artifact
          : {
              ...artifact,
              fragmentEntry: fragment,
              ...(isVelocityRasterEntry(fragment) ? { vertexEntry: 'vs_temporal' } : {}),
              ...(input.coverageOnly
                ? { variantSet: variantSetForCoveragePass(artifact.variantSet, true) ?? '' }
                : {}),
            };
      const renderState = hiddenRenderState(
        material.renderState,
        passArtifact,
        input,
        entry.source.transform,
      );
      // Same program as the raster class (production-raster-classes
      // maskedInEarlyPassArtifact): a seeded masked row drops its alpha discard.
      const generalArtifact = seededHiddenArtifact(
        passArtifact,
        material.renderState,
        input.seededDepth === true,
      );
      const forwardColorPass =
        fragment === undefined || fragment === STANDARD_OPAQUE_FRAGMENT_ENTRY;
      const selectedArtifact = forwardColorPass
        ? withFrameLighting(
            generalArtifact,
            input.directionalShadowSimple === true,
            input.leanLighting === true,
            input.forwardInlineSsr === true,
          )
        : generalArtifact;
      const request = requestMaterialAbiRasterPipeline(input.factory, {
        artifact: selectedArtifact,
        deformation: prepared.identity.deformation,
        format: rasterColorFormat(input.formats, 'rgba16float'),
        sampleCount: input.sampleCount,
        layoutProjection: entry.mesh.layoutProjection,
        shaderUvSetCount: input.shaderUvSetCount,
        topology: draw.key.topology,
        stripIndexFormat:
          draw.key.drawKind === 'indexed' &&
          (draw.key.topology === 'triangle-strip' || draw.key.topology === 'line-strip')
            ? entry.mesh.indexFormat
            : undefined,
        renderState,
        additionalColorFormats: input.formats.slice(1),
        standardTextureMask: material.standardTextureMask,
        // Same facts as the raster class: source LOD capability and view clipping.
        standardSurfaceDiscards: standardSurfaceDiscardMask(
          lodCoverageMayFade({ prepared, ...(draw.lod === undefined ? {} : { lod: draw.lod }) }),
          input.viewClipping === true,
        ),
        forwardColorPass,
      });
      if (request === null) {
        ready = false;
        input.onPending?.({
          code: 'scene-pipeline-preparation',
          entity: entry.source.entityKey,
          pass: (fragment ?? input.filter ?? 'forward').slice(0, 256),
          shader: selectedArtifact.material.slice(0, 256),
        });
      }
    }
  }
  return ready;
}

/** Reflection fact: the selected scene-index vertex entry reads @group(3) @binding(8). */
function readsSceneMorphInputs(artifact: MaterialShaderArtifact): boolean {
  const entry = isVelocityRasterEntry(artifact.fragmentEntry)
    ? 'vs_temporal'
    : artifact.receipt?.sceneIndexEntry;
  const reads = findMaterialShaderEntry(artifact.program.entryPoints, entry, 'vertex');
  return reads?.bindings.some((read) => read.group === 3 && read.binding === 8) === true;
}

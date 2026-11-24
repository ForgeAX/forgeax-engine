import { runtimeMaterialShaderId } from '@forgeax/engine-assets-runtime';
import { isStandardRootModule } from '@forgeax/engine-types';
import { LIGHTING_CHANNELS_DEFAULT } from '../components/lighting-channels';
import { materialUsesDirectDfgLut } from '../device/direct-dfg-lut';
import { SceneDataUnavailableError } from '../errors/render';
import {
  deriveRenderFeaturePassAccess,
  type RenderFeatureDerivedAccess,
  type RenderFeaturePlannedFrame,
  type RenderFeatureWorkPlan,
  renderFeaturePlanDeclarations,
} from '../features/plan';
import type { MaterialResource } from '../material-resource';
import {
  isCanonicalStandardPbrMaterialShader,
  isStandardPbrSkinMaterialShader,
} from '../pbr-pipeline';
import { matchesRecordMode } from '../record/material-pass-selection';
import type { RenderPipelineTopology } from '../render-pipeline';
import type { DispatchEntry, RenderableSnapshot } from '../render-system-extract';
import { DEFERRED_PASS_SELECTOR, FORWARD_PASS_SELECTOR, matchPass } from '../systems/pass-selector';
import { materialProgramFact } from './material-program-facts';
import type {
  SceneDataLane,
  StandardSceneDataContributorProgramFact,
  StandardSceneDataContributorRejectedField,
  StandardSceneDataContributorRejectionReason,
  StandardSceneDataContributorTuple,
  StandardSceneDataMissingContributor,
  StandardSceneSurfaceAdmission,
} from './scene-data';
import {
  isSceneDataTarget,
  SCENE_DATA_STANDARD_GBUFFER_NORMAL_V2_SCHEMA,
  SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA,
  SCENE_DATA_TEMPORAL_V1_SCHEMA,
  type SceneDataSchemaId,
  type SceneDataSurfaceBinding,
  sceneDataTargetOwner,
} from './scene-data';

type SceneDataBindingOwner = NonNullable<ReturnType<typeof sceneDataTargetOwner>>;

export function sceneDataTopologyFields(
  admission: StandardSceneSurfaceAdmission | undefined,
  bindings: readonly SceneDataSurfaceBinding[] | undefined,
): Pick<RenderPipelineTopology, 'sceneDataAdmission' | 'sceneDataBindings'> {
  if (bindings === undefined || bindings.length === 0) return {};
  return {
    ...(admission === undefined ? {} : { sceneDataAdmission: admission }),
    sceneDataBindings: bindings,
  };
}

function sceneDataOwnerForAccess(
  planned: RenderFeaturePlannedFrame,
  access: RenderFeatureDerivedAccess,
  admission: StandardSceneSurfaceAdmission | undefined,
): { readonly schema: SceneDataSchemaId; readonly owner: SceneDataBindingOwner } | undefined {
  if (access.usage !== 'sampled-read' || !isSceneDataTarget(access.resource)) return undefined;
  const target = access.resource;
  const owner = sceneDataTargetOwner(target);
  const surfaceSchema = target.schema !== SCENE_DATA_TEMPORAL_V1_SCHEMA;
  const plannedView = typeof planned.scope === 'string' ? undefined : planned.scope.view;
  if (
    owner === undefined ||
    planned.featureIdentity !== owner.featureIdentity ||
    planned.generation !== owner.generation ||
    plannedView !== owner.viewIdentity ||
    owner.planIdentity !== `${planned.featureIdentity}:${owner.viewIdentity}:${planned.generation}`
  ) {
    return undefined;
  }
  if (
    surfaceSchema &&
    (admission?.status !== 'available' ||
      owner.viewIdentity !== admission.viewIdentity ||
      owner.generation !== admission.generation ||
      owner.deviceGeneration !== admission.deviceGeneration ||
      owner.surfaceAdmissionIdentity !== admission.identity ||
      owner.surfaceAdmissionRevision === undefined)
  ) {
    return undefined;
  }
  return { schema: target.schema, owner };
}

function sceneDataOwnerKey(owner: SceneDataBindingOwner, schema: SceneDataSchemaId): string {
  const surfaceSchema = schema !== SCENE_DATA_TEMPORAL_V1_SCHEMA;
  return JSON.stringify([
    owner.featureIdentity,
    owner.viewIdentity,
    owner.planIdentity,
    owner.generation,
    owner.deviceGeneration,
    surfaceSchema ? owner.surfaceAdmissionIdentity : undefined,
    surfaceSchema ? owner.surfaceAdmissionRevision : undefined,
  ]);
}

/**
 * Whether any pass of the plan can derive a SceneData `sampled-read`. Pass
 * access only yields a non-string resource from a `prepared-gpu-resource`
 * declaration's `logicalTarget` (raster `sampledTargets` keep strings only),
 * so a plan without such a SceneData declaration contributes no binding.
 */
function declaresSceneDataTarget(plan: RenderFeatureWorkPlan): boolean {
  return plan.resources.some(
    (resource) =>
      resource.kind === 'prepared-gpu-resource' && isSceneDataTarget(resource.logicalTarget),
  );
}

export function sceneDataSurfaceBindings(
  plans: readonly RenderFeaturePlannedFrame[],
  admission?: StandardSceneSurfaceAdmission,
): readonly SceneDataSurfaceBinding[] {
  const owners = new Map<SceneDataSchemaId, Map<string, SceneDataBindingOwner>>();
  for (const planned of plans) {
    if (!declaresSceneDataTarget(planned.plan)) continue;
    const declarations = renderFeaturePlanDeclarations(planned.plan);
    for (const pass of planned.plan.passes) {
      for (const access of deriveRenderFeaturePassAccess(planned.plan, pass, declarations)) {
        const binding = sceneDataOwnerForAccess(planned, access, admission);
        if (binding === undefined) continue;
        const schemaOwners = owners.get(binding.schema) ?? new Map();
        schemaOwners.set(sceneDataOwnerKey(binding.owner, binding.schema), binding.owner);
        owners.set(binding.schema, schemaOwners);
      }
    }
  }
  return Object.freeze(
    [...owners.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([schema, schemaOwners]) =>
        Object.freeze({
          schema: schema as SceneDataSurfaceBinding['schema'],
          owners: Object.freeze([...schemaOwners.values()]),
        }),
      ),
  );
}

export interface StandardSceneDataContributor {
  /** The selected Deferred writer has a producer-certified Standard GBuffer ABI. */
  readonly gbufferWriter?: boolean;
  /** The receiver must retain object-specific probe or shadow selection. */
  readonly compactReceiverContext?: true;
  /** The captured writer and receiver fit a model in the Default GBuffer. */
  readonly compactGbufferWriter?: 'default-channels' | 'lighting-channels';
  /** Proven by the same pass selectors as the later opaque Forward pass. */
  readonly forwardOnly?: boolean;
  readonly id: string;
  readonly publication: string;
  readonly materialShaderId: string;
  readonly geometry: string;
  readonly deformation: 'rigid' | 'skin' | 'morph' | 'unknown';
  readonly entryPoint: string | undefined;
  readonly selectedProgram: string;
  /** Actual captured program authority; absent for all borrowed program inputs. */
  readonly programIdentity?: object | undefined;
  readonly facts?: {
    readonly sourceTuple: StandardSceneDataContributorTuple | undefined;
    readonly dispatchProgramKey: string;
    readonly authoredModule: string | undefined;
    readonly authoredShaderId: string | undefined;
    readonly expectedFragmentEntry: string;
    readonly publishedFragmentEntries: readonly string[];
    readonly registryLookupKey: string | undefined;
    readonly selectedPass: string | undefined;
    readonly publicationIdentity: StandardSceneDataContributorProgramFact['publicationIdentity'];
    readonly selectedProgramFacts: StandardSceneDataContributorProgramFact['program'];
    readonly programCandidates?: readonly StandardSceneDataContributorProgramFact[];
    readonly morphWeightsPresent: boolean;
    readonly skinBindingPresent: boolean;
    readonly materialSnapshotMissing: boolean;
    readonly selectedPassFound: boolean;
  };
}

export interface StandardSceneDataAdmissionInput {
  readonly viewIdentity: string;
  readonly generation: number;
  readonly deviceGeneration: number;
  readonly standardPipeline: boolean;
  readonly cameraAvailable: boolean;
  readonly lane: SceneDataLane;
  readonly renderPath: 'forward' | 'deferred' | undefined;
  readonly contributors: readonly StandardSceneDataContributor[];
}

/** Internal view-producer envelope; raw callers retain their ordinary observation route. */
class SceneSurfaceInputHeader implements Omit<StandardSceneDataAdmissionInput, 'contributors'> {
  declare readonly viewIdentity: StandardSceneDataAdmissionInput['viewIdentity'];
  declare readonly generation: StandardSceneDataAdmissionInput['generation'];
  declare readonly deviceGeneration: StandardSceneDataAdmissionInput['deviceGeneration'];
  declare readonly standardPipeline: StandardSceneDataAdmissionInput['standardPipeline'];
  declare readonly cameraAvailable: StandardSceneDataAdmissionInput['cameraAvailable'];
  declare readonly lane: StandardSceneDataAdmissionInput['lane'];
  declare readonly renderPath: StandardSceneDataAdmissionInput['renderPath'];
  #fixedHeader = false;
  #captured = false;

  capture(header: Omit<StandardSceneDataAdmissionInput, 'contributors'>): void {
    if (this.#captured) throw new Error('SceneData producer header was already captured');
    this.#captured = true;
    const descriptors = Object.getOwnPropertyDescriptors(header);
    // Derive this check from the input itself, without a second header vocabulary.
    // Copy descriptors rather than reading a custom header getter during proof setup.
    this.#fixedHeader = Reflect.ownKeys(descriptors).every((key) => {
      const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;
      if (typeof key !== 'string' || !('value' in descriptor)) return false;
      const value: unknown = descriptor.value;
      return (
        value === null ||
        value === undefined ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      );
    });
    Object.defineProperties(this, descriptors);
    Object.freeze(this);
  }

  static hasFixedHeader(input: StandardSceneDataAdmissionInput): boolean {
    // A Proxy around the envelope does not carry its private producer authority.
    return #fixedHeader in input && input.#fixedHeader;
  }
}

export class ProducedStandardSceneDataAdmissionInput extends SceneSurfaceInputHeader {
  readonly contributors: StandardSceneDataContributor[] = [];
}

const noSurfaceContributors: readonly StandardSceneDataContributor[] = Object.freeze([]);

/** A view always visits its current material members. The resulting immutable roster shares
 * the previous ordered prefix until the first changed member needs new storage. */
export class CurrentSceneSurfaceInput
  extends SceneSurfaceInputHeader
  implements StandardSceneDataAdmissionInput
{
  #before: readonly StandardSceneDataContributor[];
  #count = 0;
  #changed: StandardSceneDataContributor[] | undefined;
  #published: readonly StandardSceneDataContributor[] | undefined;

  constructor(
    header: Omit<StandardSceneDataAdmissionInput, 'contributors'>,
    previous?: StandardSceneSurfaceAdmission,
  ) {
    super();
    this.#before = standardSceneSurfaceContributorBaseline(previous) ?? noSurfaceContributors;
    this.capture(header);
  }

  get previousRow(): StandardSceneDataContributor | undefined {
    return this.#before[this.#count];
  }

  append(row: StandardSceneDataContributor | undefined): void {
    if (this.#published !== undefined) throw new Error('SceneData contributors are already sealed');
    if (row === undefined) return;
    const index = this.#count++;
    if (this.#changed === undefined) {
      if (this.#before[index] === row) return;
      this.#changed = this.#before.slice(0, index);
    }
    this.#changed.push(row);
  }

  get contributors(): readonly StandardSceneDataContributor[] {
    if (this.#published !== undefined) return this.#published;
    if (this.#changed !== undefined) this.#published = Object.freeze(this.#changed);
    else if (this.#count === this.#before.length) this.#published = this.#before;
    else
      this.#published =
        this.#count === 0
          ? noSurfaceContributors
          : Object.freeze(this.#before.slice(0, this.#count));
    this.#before = noSurfaceContributors;
    this.#changed = undefined;
    return this.#published;
  }

  static published(
    input: StandardSceneDataAdmissionInput,
  ): readonly StandardSceneDataContributor[] | undefined {
    return #published in input ? input.contributors : undefined;
  }
}

// Only this producer's frozen primitive observations can reuse a prior proof.
// Raw/custom contributors keep the complete ordinary getter and diagnostic route.
const ownedContributors = new WeakSet<StandardSceneDataContributor>();
const contributorProgram = Symbol('StandardSceneDataContributor.program');
type ProducedContributor = StandardSceneDataContributor & {
  [contributorProgram]?: StandardSceneDataContributorProgramFact;
};
interface GBufferWriters {
  readonly incompatibleWriter: string | undefined;
  readonly receiverContext: boolean;
  readonly lightingChannels: boolean;
}
type AdmissionProof = {
  readonly kind: 'available' | 'unavailable';
  readonly header: Omit<StandardSceneDataAdmissionInput, 'contributors'>;
  readonly contributors: readonly StandardSceneDataContributor[];
  readonly writers: GBufferWriters | undefined;
};

/** The issued admission owns its evidence, including while a different view is recording.
 * Copies keep their public fields but cannot authorize prior contributors or native graph work. */
class SurfaceAdmissionReceipt {
  declare readonly identity: string;
  readonly #value: SurfaceCoverageIdentity | string;
  readonly #proof: AdmissionProof | undefined;
  private static readonly identityField = {
    enumerable: true,
    get(this: SurfaceAdmissionReceipt) {
      return typeof this.#value === 'string' ? this.#value : this.#value.read();
    },
  };
  constructor(value: SurfaceCoverageIdentity | string, proof: AdmissionProof | undefined) {
    this.#value = value;
    this.#proof = proof;
    Object.defineProperty(this, 'identity', SurfaceAdmissionReceipt.identityField);
  }
  static proof(issued: StandardSceneSurfaceAdmission | undefined): AdmissionProof | undefined {
    return issued !== undefined && #proof in issued ? issued.#proof : undefined;
  }
  static coverage(
    issued: StandardSceneSurfaceAdmission | undefined,
  ): SurfaceCoverageIdentity | undefined {
    if (issued === undefined || !(#value in issued)) return undefined;
    return typeof issued.#value === 'string' ? undefined : issued.#value;
  }
}

function captureAdmissionProof(
  input: StandardSceneDataAdmissionInput,
  ownedRows: readonly StandardSceneDataContributor[] | undefined,
  kind: AdmissionProof['kind'],
  writers: GBufferWriters | undefined,
): AdmissionProof | undefined {
  if (kind === 'unavailable') {
    if (
      !SceneSurfaceInputHeader.hasFixedHeader(input) ||
      !input.contributors.every(completeNegativeContributor)
    )
      return undefined;
  } else if (
    ownedRows === undefined &&
    !input.contributors.every((row) => ownedContributors.has(row))
  ) {
    return undefined;
  }
  const { contributors, ...header } = input;
  return { kind, header, contributors: ownedRows ?? Object.freeze(contributors.slice()), writers };
}

export function standardSceneGBufferWriters(
  admission: StandardSceneSurfaceAdmission | undefined,
): GBufferWriters | undefined {
  return SurfaceAdmissionReceipt.proof(admission)?.writers;
}

/** The prior complete proof's immutable producer observations, in contribution order. */
export function standardSceneSurfaceContributorBaseline(
  admitted: StandardSceneSurfaceAdmission | undefined,
): readonly StandardSceneDataContributor[] | undefined {
  return SurfaceAdmissionReceipt.proof(admitted)?.contributors;
}

/** Complete diagnostic authority comes from the retained program producer, not shallow freeze. */
function completeNegativeContributor(row: StandardSceneDataContributor): boolean {
  if (!ownedContributors.has(row)) return false;
  const program = (row as ProducedContributor)[contributorProgram];
  const facts = row.facts;
  return (
    program !== undefined &&
    facts !== undefined &&
    !facts.materialSnapshotMissing &&
    facts.selectedPassFound &&
    // The private marker is issued only for the MaterialResource's captured
    // program authority. These exact links cover all nested diagnostic facts.
    facts.publishedFragmentEntries === program.fragmentEntryPoints &&
    facts.publicationIdentity === program.publicationIdentity &&
    facts.selectedProgramFacts === program.program &&
    facts.programCandidates !== undefined &&
    Object.isFrozen(facts.programCandidates) &&
    facts.programCandidates.length === 1 &&
    facts.programCandidates[0] === program
  );
}

function ownContributor(
  contributor: StandardSceneDataContributor | undefined,
): StandardSceneDataContributor | undefined {
  if (contributor !== undefined) {
    if (ownedContributors.has(contributor)) return contributor;
    if (contributor.facts !== undefined) Object.freeze(contributor.facts);
    Object.freeze(contributor);
    ownedContributors.add(contributor);
  }
  return contributor;
}

/** Compare every input to identity and rejection; no program/source identity shortcut. */
function sameContributorProof(
  row: StandardSceneDataContributor,
  prior: StandardSceneDataContributor,
) {
  return (
    ownedContributors.has(row) &&
    (row === prior ||
      (row.id === prior.id &&
        row.publication === prior.publication &&
        row.materialShaderId === prior.materialShaderId &&
        row.geometry === prior.geometry &&
        row.deformation === prior.deformation &&
        row.entryPoint === prior.entryPoint &&
        row.selectedProgram === prior.selectedProgram &&
        row.gbufferWriter === prior.gbufferWriter &&
        row.compactGbufferWriter === prior.compactGbufferWriter &&
        row.compactReceiverContext === prior.compactReceiverContext &&
        (row.forwardOnly === true) === (prior.forwardOnly === true) &&
        row.facts?.authoredShaderId === prior.facts?.authoredShaderId &&
        row.facts?.materialSnapshotMissing === prior.facts?.materialSnapshotMissing &&
        row.facts?.selectedPassFound === prior.facts?.selectedPassFound &&
        row.facts?.expectedFragmentEntry === prior.facts?.expectedFragmentEntry))
  );
}

function matchingAdmissionHeader(
  input: StandardSceneDataAdmissionInput,
  previous: StandardSceneSurfaceAdmission | undefined,
): AdmissionProof | undefined {
  if (previous === undefined) return undefined;
  const proof = SurfaceAdmissionReceipt.proof(previous);
  if (proof === undefined) return undefined;
  if (proof.kind === 'unavailable' && !SceneSurfaceInputHeader.hasFixedHeader(input))
    return undefined;
  const header = proof.header;
  if (
    input.viewIdentity !== header.viewIdentity ||
    input.generation !== header.generation ||
    input.deviceGeneration !== header.deviceGeneration ||
    input.standardPipeline !== header.standardPipeline ||
    input.cameraAvailable !== header.cameraAvailable ||
    input.lane !== header.lane ||
    input.renderPath !== header.renderPath ||
    input.contributors.length !== proof.contributors.length
  )
    return undefined;
  return proof;
}

function matchesProofRow(
  proof: AdmissionProof,
  row: StandardSceneDataContributor,
  index: number,
): boolean {
  const prior = proof.contributors[index];
  return (
    prior !== undefined &&
    (proof.kind === 'unavailable' ? row === prior : sameContributorProof(row, prior))
  );
}

function reusableAdmission(
  input: StandardSceneDataAdmissionInput,
  previous: StandardSceneSurfaceAdmission,
): boolean {
  const proof = matchingAdmissionHeader(input, previous);
  if (proof === undefined) return false;
  for (let index = 0; index < input.contributors.length; index++) {
    const row = input.contributors[index];
    if (row === undefined || !matchesProofRow(proof, row, index)) return false;
  }
  return true;
}

function coversStockAo(admission: StandardSceneSurfaceAdmission): boolean {
  return (
    admission.status === 'available' ||
    (admission.renderPath === 'deferred' && admission.deferredAoCompatible === true)
  );
}

export function standardAoSceneDataUnavailable(input: {
  readonly admission: StandardSceneSurfaceAdmission | undefined;
  readonly viewIdentity: string;
  readonly generation: number;
  readonly deviceGeneration: number;
  readonly renderPath: 'forward' | 'deferred' | undefined;
  readonly fallbackLane: SceneDataLane;
}): SceneDataUnavailableError | undefined {
  const admission = input.admission;
  const sameOwner =
    admission !== undefined &&
    admission.viewIdentity === input.viewIdentity &&
    admission.generation === input.generation &&
    admission.deviceGeneration === input.deviceGeneration &&
    admission.renderPath === input.renderPath;
  if (sameOwner && coversStockAo(admission)) return undefined;
  const unavailable = sameOwner && admission.status === 'unavailable' ? admission : undefined;
  const reason = unavailable?.reason ?? 'producer-missing';
  const missingContributorIds =
    reason === 'coverage-incomplete' ? (unavailable?.missingContributorIds ?? []) : [];
  return new SceneDataUnavailableError({
    featureIdentity: 'forgeax::standard',
    schema:
      input.renderPath === 'deferred'
        ? SCENE_DATA_STANDARD_GBUFFER_NORMAL_V2_SCHEMA
        : SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA,
    lane: admission?.lane ?? input.fallbackLane,
    reason,
    missingContributorIds,
    ...(reason === 'coverage-incomplete'
      ? { missingContributors: unavailable?.missingContributors ?? [] }
      : {}),
    omittedMissingContributorCount:
      reason === 'coverage-incomplete' ? (unavailable?.omittedMissingContributorCount ?? 0) : 0,
    recovery: 'next-frame',
  });
}

type SurfaceView = Omit<StandardSceneDataAdmissionInput, 'contributors'>;

function coverageHeader(input: SurfaceView, producer: string | undefined) {
  return [
    input.viewIdentity,
    input.generation,
    input.deviceGeneration,
    input.standardPipeline,
    input.cameraAvailable,
    input.lane,
    input.renderPath,
    producer,
  ];
}

/** Detached observation of the exact coverage inputs. No per-draw decision objects survive the frame. */
class SurfaceCoverageIdentity {
  private serialized: string | undefined;

  constructor(
    readonly header: ReturnType<typeof coverageHeader>,
    readonly rows: readonly StandardSceneDataContributor[],
    readonly rejections: Uint8Array | undefined,
    readonly rejectedCount: number,
  ) {}

  read(): string {
    if (this.serialized !== undefined) return this.serialized;
    const ordered: string[] = [],
      singleton: unknown[][] = [],
      rejected: [string, string][] = [];
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i] as StandardSceneDataContributor;
      const reason = rejectionByCode[this.rejections?.[i] ?? 0]?.reason;
      const fields = contributorIdentityFields(row, reason);
      if (this.rows.length < 2) singleton.push(fields);
      else ordered.push(JSON.stringify(fields));
      if (reason !== undefined) rejected.push([row.id, reason]);
    }
    rejected.sort((a, b) => a[0].localeCompare(b[0]));
    if (this.rows.length < 2)
      this.serialized = JSON.stringify([...this.header, singleton, rejected]);
    else {
      ordered.sort((a, b) => a.localeCompare(b));
      this.serialized =
        JSON.stringify(this.header).slice(0, -1) +
        ',[' +
        ordered.join(',') +
        '],' +
        JSON.stringify(rejected) +
        ']';
    }
    return this.serialized;
  }
}

function sameCoverageRow(
  a: StandardSceneDataContributor,
  b: StandardSceneDataContributor,
): boolean {
  return (
    a === b ||
    (a.id === b.id &&
      a.publication === b.publication &&
      a.materialShaderId === b.materialShaderId &&
      a.geometry === b.geometry &&
      a.deformation === b.deformation &&
      a.entryPoint === b.entryPoint &&
      a.selectedProgram === b.selectedProgram &&
      a.gbufferWriter === b.gbufferWriter &&
      (a.forwardOnly === true) === (b.forwardOnly === true))
  );
}

/** Compare complete native observations directly; canonical ordering also accepts a permuted roster. */
export function sameSceneSurfaceAdmission(
  a: StandardSceneSurfaceAdmission | undefined,
  b: StandardSceneSurfaceAdmission | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  const left = SurfaceAdmissionReceipt.coverage(a),
    right = SurfaceAdmissionReceipt.coverage(b);
  if (left === undefined || right === undefined) return a.identity === b.identity;
  if (
    left.rows.length !== right.rows.length ||
    left.rejectedCount !== right.rejectedCount ||
    !left.header.every((field, index) => field === right.header[index])
  )
    return false;
  for (let i = 0; i < left.rows.length; i++) {
    const old = left.rows[i] as StandardSceneDataContributor;
    const reason = left.rejections?.[i] ?? 0;
    if (
      reason === (right.rejections?.[i] ?? 0) &&
      sameCoverageRow(old, right.rows[i] as StandardSceneDataContributor)
    )
      continue;
    if (
      !right.rows.some(
        (row, index) => reason === (right.rejections?.[index] ?? 0) && sameCoverageRow(old, row),
      )
    )
      return false;
    return left.read() === right.read();
  }
  return true;
}

const emptyCoverage = Object.freeze([]) as readonly [];

/** Select the producer before asking the Scene for a single material or geometry row. */
export function standardSurfaceProducerPath(view: SurfaceView): SurfaceView['renderPath'] {
  return view.standardPipeline && view.cameraAvailable ? view.renderPath : undefined;
}

/** A missing producer owns only its view identity. Its recovery cannot depend on mesh membership. */
export function missingStandardSurfaceProducer(view: SurfaceView): StandardSceneSurfaceAdmission {
  const identity = new SurfaceCoverageIdentity(
    coverageHeader(view, undefined),
    emptyCoverage,
    undefined,
    0,
  );
  return Object.freeze({
    viewIdentity: view.viewIdentity,
    generation: view.generation,
    deviceGeneration: view.deviceGeneration,
    lane: view.lane,
    renderPath: view.renderPath,
    status: 'unavailable',
    reason: 'producer-missing',
    get identity() {
      return identity.read();
    },
    deferredGBufferEmpty: false,
    deferredAoCompatible: false,
    missingContributorIds: emptyCoverage,
    missingContributors: emptyCoverage,
    omittedMissingContributorCount: 0,
  });
}

function isDeferredAoCompatiblePass(contributor: StandardSceneDataContributor): boolean {
  return contributor.forwardOnly === true || contributor.gbufferWriter === true;
}

export function createStandardSceneSurfaceAdmission(
  input: StandardSceneDataAdmissionInput,
  previous?: StandardSceneSurfaceAdmission,
): StandardSceneSurfaceAdmission {
  const renderPath = standardSurfaceProducerPath(input);
  if (renderPath === undefined) return missingStandardSurfaceProducer(input);
  const expectedEntry = renderPath === 'deferred' ? 'fs_gbuffer' : 'fs_ao_input';
  const previousCoverage = SurfaceAdmissionReceipt.coverage(previous);
  const previousCodes =
    previousCoverage?.rows.length === input.contributors.length
      ? previousCoverage.rejections
      : undefined;
  const currentRows = CurrentSceneSurfaceInput.published(input);
  const fixedProducer = currentRows !== undefined && SceneSurfaceInputHeader.hasFixedHeader(input);
  let proof = fixedProducer ? matchingAdmissionHeader(input, previous) : undefined;
  const identicalRows = proof !== undefined && proof.contributors === currentRows;
  let owned = fixedProducer;
  let rejections = previousCodes;
  let rejectedCount = 0;
  let deferredAoCompatible = renderPath === 'deferred';
  let deferredGBufferEmpty = renderPath === 'deferred';
  let incompatibleWriter: string | undefined;
  let receiverContext = false;
  let lightingChannels = false;
  for (let index = 0; index < (currentRows ?? input.contributors).length; index++) {
    const contributor = (currentRows ?? input.contributors)[index] as StandardSceneDataContributor;
    if (contributor.forwardOnly !== true) deferredGBufferEmpty = false;
    if (owned && !identicalRows && !ownedContributors.has(contributor)) owned = false;
    if (renderPath === 'deferred' && ownedContributors.has(contributor)) {
      if (!contributor.forwardOnly && !contributor.compactGbufferWriter)
        incompatibleWriter ??= contributor.materialShaderId || contributor.id;
      receiverContext ||= contributor.compactReceiverContext === true;
      lightingChannels ||= contributor.compactGbufferWriter === 'lighting-channels';
    }
    if (proof !== undefined && !identicalRows && !matchesProofRow(proof, contributor, index))
      proof = undefined;
    const rejection = surfaceContributorRejection(contributor, expectedEntry);
    const code = rejection?.code ?? 0;
    if ((rejections?.[index] ?? 0) !== code) {
      if (rejections === previousCodes || rejections === undefined)
        rejections = previousCodes?.slice() ?? new Uint8Array(input.contributors.length);
      rejections[index] = code;
    }
    if (rejection === undefined) continue;
    rejectedCount++;
    if (
      !isDeferredAoCompatiblePass(contributor) ||
      contributor.facts?.selectedPassFound !== true ||
      contributor.facts.materialSnapshotMissing !== false
    )
      deferredAoCompatible = false;
  }
  // Retain only the public result after classifying every current row.
  if (
    previous !== undefined &&
    (fixedProducer ? proof !== undefined : reusableAdmission(input, previous))
  )
    return previous;
  const diagnostics: RejectedSurfaceContributor[] = [];
  if (rejectedCount > 0 && rejections !== undefined) {
    for (let i = 0; i < rejections.length; i++) {
      const reason = rejectionByCode[rejections[i] as number];
      if (reason !== undefined)
        retainDiagnostic(
          diagnostics,
          input.contributors[i] as StandardSceneDataContributor,
          reason,
        );
    }
  }
  const missingContributors = Object.freeze(
    diagnostics.map(({ contributor, rejection }) =>
      surfaceContributorDiagnostic(contributor, rejection),
    ),
  );
  const missingContributorIds = Object.freeze(missingContributors.map(({ id }) => id));
  const omittedMissingContributorCount = Math.max(0, rejectedCount - 32);
  const producer: Extract<StandardSceneSurfaceAdmission, { status: 'available' }>['producer'] =
    input.contributors.length === 0
      ? 'clear-background'
      : renderPath === 'deferred'
        ? 'standard-deferred-gbuffer'
        : 'standard-forward-surface-pass';
  const native = fixedProducer
    ? owned
    : SceneSurfaceInputHeader.hasFixedHeader(input) &&
      input.contributors.every((row) => ownedContributors.has(row));
  const rows = native
    ? (currentRows ?? Object.freeze(input.contributors.slice()))
    : input.contributors;
  const identity = new SurfaceCoverageIdentity(
    coverageHeader(input, producer),
    rows,
    rejectedCount === 0 ? undefined : rejections,
    rejectedCount,
  );
  // Borrowed rows or getters must finish observing their values during this call.
  const value = native ? identity : identity.read();
  const base = {
    deferredGBufferEmpty: deferredAoCompatible && deferredGBufferEmpty,
    viewIdentity: input.viewIdentity,
    generation: input.generation,
    deviceGeneration: input.deviceGeneration,
    lane: input.lane,
  };
  const writers =
    renderPath === 'deferred'
      ? { incompatibleWriter, receiverContext, lightingChannels }
      : undefined;
  const captured = captureAdmissionProof(
    input,
    native ? rows : undefined,
    rejectedCount === 0 ? 'available' : 'unavailable',
    writers,
  );
  const receipt = new SurfaceAdmissionReceipt(value, captured);
  if (rejectedCount === 0) {
    return Object.freeze(
      Object.assign(receipt, base, {
        renderPath,
        status: 'available' as const,
        producer,
        missingContributorIds: emptyCoverage,
      }),
    );
  }
  return Object.freeze(
    Object.assign(receipt, base, {
      renderPath: input.renderPath,
      status: 'unavailable' as const,
      reason: 'coverage-incomplete' as const,
      deferredAoCompatible,
      missingContributorIds,
      missingContributors,
      omittedMissingContributorCount,
    }),
  );
}

type RejectedSurfaceContributor = {
  readonly contributor: StandardSceneDataContributor;
  readonly rejection: SurfaceContributorRejection;
};

/** Retain only the first 32 diagnostics in stable ID order while judging the full roster. */
function retainDiagnostic(
  rows: RejectedSurfaceContributor[],
  contributor: StandardSceneDataContributor,
  rejection: SurfaceContributorRejection,
): void {
  const limit = 32;
  if (
    rows.length === limit &&
    contributor.id.localeCompare((rows[limit - 1] as RejectedSurfaceContributor).contributor.id) >=
      0
  )
    return;
  let lo = 0,
    hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (contributor.id.localeCompare((rows[mid] as RejectedSurfaceContributor).contributor.id) < 0)
      hi = mid;
    else lo = mid + 1;
  }
  if (rows.length === limit) rows.pop();
  for (let i = rows.length; i > lo; i--) rows[i] = rows[i - 1] as RejectedSurfaceContributor;
  rows[lo] = { contributor, rejection };
}

type SurfaceContributorRejection = {
  readonly code: number;
  readonly reason: StandardSceneDataContributorRejectionReason;
  readonly rejectedField: StandardSceneDataContributorRejectedField;
};

function contributorIdentityFields(
  row: StandardSceneDataContributor,
  rejection: StandardSceneDataContributorRejectionReason | undefined,
) {
  return [
    row.id,
    row.publication,
    row.materialShaderId,
    row.geometry,
    row.deformation,
    row.entryPoint,
    row.selectedProgram,
    row.forwardOnly === true,
    rejection,
    row.gbufferWriter === true,
  ];
}

const MATERIAL_SNAPSHOT_MISSING: SurfaceContributorRejection = Object.freeze({
  code: 1,
  reason: 'material-snapshot-missing',
  rejectedField: 'material-snapshot',
});
const SELECTED_PASS_MISSING: SurfaceContributorRejection = Object.freeze({
  code: 2,
  reason: 'selected-pass-missing',
  rejectedField: 'selected-pass',
});
const AUTHORED_PROGRAM_NOT_STANDARD_PBR: SurfaceContributorRejection = Object.freeze({
  code: 3,
  reason: 'authored-program-not-standard-pbr',
  rejectedField: 'authored-shader-id',
});
const MISSING_FRAGMENT_ENTRY: SurfaceContributorRejection = Object.freeze({
  code: 4,
  reason: 'missing-fragment-entry',
  rejectedField: 'fragment-entry-point',
});
const UNSUPPORTED_GEOMETRY: SurfaceContributorRejection = Object.freeze({
  code: 5,
  reason: 'unsupported-geometry',
  rejectedField: 'geometry',
});
const UNSUPPORTED_DEFORMATION: SurfaceContributorRejection = Object.freeze({
  code: 6,
  reason: 'unsupported-deformation',
  rejectedField: 'deformation',
});

const rejectionByCode = [
  undefined,
  MATERIAL_SNAPSHOT_MISSING,
  SELECTED_PASS_MISSING,
  AUTHORED_PROGRAM_NOT_STANDARD_PBR,
  MISSING_FRAGMENT_ENTRY,
  UNSUPPORTED_GEOMETRY,
  UNSUPPORTED_DEFORMATION,
] as const;

function surfaceContributorRejection(
  contributor: StandardSceneDataContributor,
  expectedEntry: string,
): SurfaceContributorRejection | undefined {
  const facts = contributor.facts;
  const authoredShaderId = facts?.authoredShaderId ?? contributor.materialShaderId;
  const unlitForward =
    expectedEntry === 'fs_ao_input' &&
    (authoredShaderId === 'forgeax::default-unlit' ||
      authoredShaderId === 'forgeax_material::unlit');
  if (facts?.materialSnapshotMissing === true) return MATERIAL_SNAPSHOT_MISSING;
  if (facts?.selectedPassFound === false) return SELECTED_PASS_MISSING;
  if (
    !isCanonicalStandardPbrMaterialShader(authoredShaderId) &&
    (authoredShaderId === undefined || !isStandardRootModule(authoredShaderId)) &&
    !unlitForward
  )
    return AUTHORED_PROGRAM_NOT_STANDARD_PBR;
  const geometry = surfaceGeometryRejection(contributor, authoredShaderId);
  if (geometry !== undefined) return geometry;
  if (
    contributor.entryPoint !== expectedEntry ||
    (facts?.expectedFragmentEntry !== undefined && facts.expectedFragmentEntry !== expectedEntry)
  )
    return MISSING_FRAGMENT_ENTRY;
  return undefined;
}

/** Deformation producers retain the selected rigid or Skin program's input ABI. */
function surfaceGeometryRejection(
  contributor: StandardSceneDataContributor,
  authoredShaderId: string | undefined,
): SurfaceContributorRejection | undefined {
  if (contributor.geometry !== 'mesh' && contributor.geometry !== 'skinned')
    return UNSUPPORTED_GEOMETRY;
  if (
    contributor.geometry === 'mesh' &&
    contributor.deformation !== 'rigid' &&
    contributor.deformation !== 'morph'
  )
    return UNSUPPORTED_DEFORMATION;
  if (
    contributor.geometry === 'skinned' &&
    ((contributor.deformation !== 'skin' && contributor.deformation !== 'morph') ||
      !isStandardPbrSkinMaterialShader(authoredShaderId))
  )
    return UNSUPPORTED_DEFORMATION;
  return undefined;
}

function surfaceContributorDiagnostic(
  contributor: StandardSceneDataContributor,
  rejection: {
    readonly reason: StandardSceneDataContributorRejectionReason;
    readonly rejectedField: StandardSceneDataContributorRejectedField;
  },
): StandardSceneDataMissingContributor {
  const facts = contributor.facts;
  return Object.freeze({
    id: contributor.id,
    sourceTuple: facts?.sourceTuple,
    reason: rejection.reason,
    rejectedField: rejection.rejectedField,
    dispatchProgramKey: facts?.dispatchProgramKey ?? contributor.materialShaderId,
    authoredModule: facts?.authoredModule,
    authoredShaderId: facts?.authoredShaderId ?? contributor.materialShaderId,
    canonicalStandardPbr: isCanonicalStandardPbrMaterialShader(
      facts?.authoredShaderId ?? contributor.materialShaderId,
    ),
    materialContextGeometry: contributor.geometry,
    deformation: contributor.deformation,
    morphWeightsPresent: facts?.morphWeightsPresent ?? contributor.deformation === 'morph',
    skinBindingPresent: facts?.skinBindingPresent ?? contributor.deformation === 'skin',
    selectedPass: facts?.selectedPass,
    expectedFragmentEntry: facts?.expectedFragmentEntry ?? contributor.entryPoint ?? 'unknown',
    publishedFragmentEntries: facts?.publishedFragmentEntries ?? Object.freeze([]),
    registryLookupKey: facts?.registryLookupKey,
    publicationIdentity: facts?.publicationIdentity,
    selectedProgram: facts?.selectedProgramFacts,
    programCandidates: Object.freeze([...(facts?.programCandidates ?? [])].slice(0, 8)),
    omittedProgramCandidateCount: Math.max(0, (facts?.programCandidates?.length ?? 0) - 8),
  });
}

type ContributorRow = Pick<
  RenderableSnapshot,
  | 'morph'
  | 'skinBinding'
  | 'lightingChannels'
  | 'shadowReceiver'
  | 'capsuleShadowRequested'
  | 'probeBlendRecord'
>;

function fitsCompactGBuffer(
  material: MaterialResource['snapshot'],
  row: ContributorRow | undefined,
  shaderId: string | undefined,
): boolean {
  const ior = material.paramSnapshot?.ior ?? 1.5;
  const specular = material.paramSnapshot?.specular ?? 1;
  return (
    (isCanonicalStandardPbrMaterialShader(shaderId) ||
      (shaderId !== undefined && isStandardRootModule(shaderId))) &&
    row !== undefined &&
    typeof ior === 'number' &&
    Number.isFinite(ior) &&
    typeof specular === 'number' &&
    Number.isFinite(specular) &&
    ((Math.max(ior, 1) - 1) / (Math.max(ior, 1) + 1)) ** 2 * Math.min(1, Math.max(0, specular)) <=
      0.08 &&
    (material.specularColor?.every((channel) => channel === 1) ?? true) &&
    material.authoredTextureFields?.has('specularTexture') !== true &&
    material.authoredTextureFields?.has('specularColorTexture') !== true &&
    !materialUsesDirectDfgLut(material.materialParamSchema)
  );
}
type ContributorMaterials = Pick<RenderableSnapshot, 'material' | 'materials'>;
type ContributorSource = ContributorRow &
  ContributorMaterials &
  Pick<RenderableSnapshot, 'entityKey'>;

function materialForDispatch(
  row: ContributorMaterials | undefined,
  materialHandle: number,
): MaterialResource | undefined {
  if (row === undefined) return undefined;
  const materials = row.materials;
  for (let index = 0; index < materials.length; index++) {
    const material = materials[index] as MaterialResource;
    if (material.snapshot.materialHandle === materialHandle) return material;
  }
  return row.material.snapshot.materialHandle === materialHandle ? row.material : undefined;
}

function passForDispatch(
  material: MaterialResource,
  materialShaderId: string | undefined,
  tags: Record<string, string>,
) {
  return material.snapshot.passes.find((pass) => {
    const passTags = (pass.renderState?.tags as Record<string, string> | undefined) ?? {};
    if (passTags.LightMode !== tags.LightMode) return false;
    const programs = material.snapshot.materialProgramKeys;
    const shaderId =
      programs === undefined
        ? runtimeMaterialShaderId(pass.program.module, pass.name)
        : programs[pass.name];
    return shaderId === materialShaderId;
  });
}

function isRequiredSurfaceDispatch(
  material: MaterialResource,
  tags: Record<string, string>,
  lane: 'forward' | 'deferred',
): boolean {
  if (!matchesRecordMode(material.snapshot, 'opaque')) return false;
  if (lane === 'forward') return matchPass(tags, FORWARD_PASS_SELECTOR);
  if (matchPass(tags, DEFERRED_PASS_SELECTOR)) return true;
  return (
    matchPass(tags, FORWARD_PASS_SELECTOR) &&
    !material.snapshot.passes.some((pass) =>
      matchPass(
        (pass.renderState?.tags as Record<string, string> | undefined) ?? {},
        DEFERRED_PASS_SELECTOR,
      ),
    )
  );
}

function deformationForContributor(
  row: ContributorRow | undefined,
  geometry: string,
): StandardSceneDataContributor['deformation'] {
  if (row?.morph !== undefined) return 'morph';
  if (row?.skinBinding !== undefined) return 'skin';
  return geometry === 'mesh' ? 'rigid' : 'unknown';
}

type StandardSceneDataDispatch = Pick<
  DispatchEntry,
  'materialHandle' | 'materialShaderId' | 'tags' | 'passIndex'
>;

export function standardSceneDataContributorForDispatch(
  row: ContributorSource | undefined,
  dispatch: StandardSceneDataDispatch,
  lane: 'forward' | 'deferred',
  previous?: StandardSceneDataContributor,
): StandardSceneDataContributor | undefined {
  // Observe identity before material selection, but materialize it only for
  // passes that actually contribute. The existing dispatch is the sole source.
  const entityKey = row?.entityKey ?? -1;
  return standardSceneDataContributorFromColumns(row, row, entityKey, dispatch, lane, previous);
}

// One material pass owns this selection for the duration of its member walk.
export function selectSceneDataDispatchPass(
  material: MaterialResource,
  dispatch: StandardSceneDataDispatch,
  lane: 'forward' | 'deferred',
): {
  readonly material: MaterialResource;
  readonly snapshot: MaterialResource['snapshot'];
  readonly required: boolean;
  readonly pass: MaterialResource['snapshot']['passes'][number] | undefined;
  readonly observation: ReturnType<MaterialResource['programObservation']> | undefined;
} {
  const required = isRequiredSurfaceDispatch(material, dispatch.tags, lane);
  const pass = required
    ? passForDispatch(material, dispatch.materialShaderId, dispatch.tags)
    : undefined;
  return {
    material,
    snapshot: material.snapshot,
    required,
    pass,
    observation: pass === undefined ? undefined : material.programObservation(pass),
  };
}

/** Native Scene columns share the judgement without assembling a snapshot-shaped wrapper. */
export function standardSceneDataContributorFromColumns(
  row: ContributorRow | undefined,
  materials: ContributorMaterials | undefined,
  entityKey: number,
  dispatch: StandardSceneDataDispatch,
  lane: 'forward' | 'deferred',
  previous?: StandardSceneDataContributor,
  group?: ReturnType<typeof selectSceneDataDispatchPass>,
): StandardSceneDataContributor | undefined {
  const materialHandle = dispatch.materialHandle;
  const passIndex = dispatch.passIndex;
  const materialShaderId = dispatch.materialShaderId;
  const tags = dispatch.tags;
  const material = materialForDispatch(materials, materialHandle);
  const selected =
    group !== undefined && group.material === material && group.snapshot === material.snapshot
      ? group
      : undefined;
  if (
    material === undefined
      ? !matchPass(tags, lane === 'deferred' ? DEFERRED_PASS_SELECTOR : FORWARD_PASS_SELECTOR)
      : !(selected?.required ?? isRequiredSurfaceDispatch(material, tags, lane))
  )
    return undefined;
  const prior = previous !== undefined && ownedContributors.has(previous) ? previous : undefined;
  const sourceTuple = contributorSourceTuple(prior, entityKey, materialHandle, passIndex);
  const expectedFragmentEntry = lane === 'deferred' ? 'fs_gbuffer' : 'fs_ao_input';
  if (material === undefined)
    return ownContributor(
      missingSnapshotContributor(row, sourceTuple, materialShaderId, expectedFragmentEntry),
    );
  const pass =
    selected === undefined ? passForDispatch(material, materialShaderId, tags) : selected.pass;
  if (pass === undefined)
    return ownContributor(
      selectedPassMissingContributor(
        material,
        row,
        sourceTuple,
        materialShaderId,
        tags,
        expectedFragmentEntry,
      ),
    );
  return ownContributor(
    selectedPassContributor(
      material,
      row,
      sourceTuple,
      materialShaderId,
      tags,
      lane,
      pass,
      expectedFragmentEntry,
      prior,
      selected?.observation,
    ),
  );
}

function contributorSourceTuple(
  previous: StandardSceneDataContributor | undefined,
  entityKey: number,
  materialHandle: number,
  passIndex: number,
): StandardSceneDataContributorTuple {
  const tuple = previous?.facts?.sourceTuple;
  if (
    tuple !== undefined &&
    typeof entityKey === 'number' &&
    typeof materialHandle === 'number' &&
    typeof passIndex === 'number' &&
    Object.is(tuple[0], entityKey) &&
    Object.is(tuple[1], materialHandle) &&
    Object.is(tuple[2], passIndex)
  )
    return tuple;
  return Object.freeze([entityKey, materialHandle, passIndex] as const);
}

function missingSnapshotContributor(
  row: ContributorRow | undefined,
  sourceTuple: StandardSceneDataContributorTuple,
  materialShaderId: string | undefined,
  expectedFragmentEntry: string,
): StandardSceneDataContributor {
  return {
    id: JSON.stringify(sourceTuple),
    publication: '',
    materialShaderId: materialShaderId ?? '',
    geometry: 'unknown',
    deformation: deformationForContributor(row, 'unknown'),
    entryPoint: undefined,
    selectedProgram: '',
    facts: {
      sourceTuple,
      dispatchProgramKey: materialShaderId ?? '',
      authoredModule: undefined,
      authoredShaderId: undefined,
      expectedFragmentEntry,
      publishedFragmentEntries: Object.freeze([]),
      registryLookupKey: undefined,
      selectedPass: undefined,
      publicationIdentity: undefined,
      selectedProgramFacts: undefined,
      programCandidates: Object.freeze([]),
      morphWeightsPresent: row?.morph !== undefined,
      skinBindingPresent: row?.skinBinding !== undefined,
      materialSnapshotMissing: true,
      selectedPassFound: false,
    },
  };
}

function selectedPassMissingContributor(
  material: MaterialResource,
  row: ContributorRow | undefined,
  sourceTuple: StandardSceneDataContributorTuple,
  materialShaderId: string | undefined,
  tags: Record<string, string>,
  expectedFragmentEntry: string,
): StandardSceneDataContributor {
  const candidate = material.snapshot.passes.find((entry) => {
    const candidateTags = (entry.renderState?.tags as Record<string, string> | undefined) ?? {};
    return candidateTags.LightMode === tags.LightMode;
  });
  const candidateFact =
    candidate === undefined ? undefined : materialProgramFact(material, candidate);
  const geometry = material.snapshot.materialContext?.geometry ?? 'unknown';
  return {
    id: JSON.stringify(sourceTuple),
    publication: '',
    materialShaderId: candidateFact?.authoredShaderId ?? materialShaderId ?? '',
    geometry,
    deformation: deformationForContributor(row, geometry),
    entryPoint: undefined,
    selectedProgram: '',
    facts: {
      sourceTuple,
      dispatchProgramKey: materialShaderId ?? '',
      authoredModule: candidateFact?.authoredModule,
      authoredShaderId: candidateFact?.authoredShaderId,
      expectedFragmentEntry,
      publishedFragmentEntries: candidateFact?.fragmentEntryPoints ?? Object.freeze([]),
      registryLookupKey: candidateFact?.registryLookupKey,
      selectedPass: candidate?.name,
      publicationIdentity: material.snapshot.materialPublication?.identity,
      selectedProgramFacts: candidateFact?.program,
      programCandidates: candidateFact === undefined ? Object.freeze([]) : [candidateFact],
      morphWeightsPresent: row?.morph !== undefined,
      skinBindingPresent: row?.skinBinding !== undefined,
      materialSnapshotMissing: false,
      selectedPassFound: false,
    },
  };
}

function isCertifiedGBufferWriter(
  snapshot: MaterialResource['snapshot'],
  pass: MaterialResource['snapshot']['passes'][number],
  lane: 'forward' | 'deferred',
  forwardOnly: boolean,
  entryPoint: string | undefined,
): boolean {
  return (
    lane === 'deferred' &&
    !forwardOnly &&
    entryPoint === 'fs_gbuffer' &&
    snapshot.materialProgramInputs?.[pass.name]?.gbuffer === 'standard-gbuffer/2'
  );
}

function selectedPassContributor(
  material: MaterialResource,
  row: ContributorRow | undefined,
  sourceTuple: StandardSceneDataContributorTuple,
  materialShaderId: string | undefined,
  tags: Record<string, string>,
  lane: 'forward' | 'deferred',
  pass: MaterialResource['snapshot']['passes'][number],
  expectedFragmentEntry: string,
  previous: StandardSceneDataContributor | undefined,
  observation = material.programObservation(pass),
): StandardSceneDataContributor {
  const snapshot = material.snapshot;
  const retained = observation.identity === undefined ? undefined : observation;
  const selectedProgramFact = observation.fact;
  const forwardOnly = lane === 'deferred' && matchPass(tags, FORWARD_PASS_SELECTOR);
  // Publishing fs_gbuffer in the same WGSL module does not select a GBuffer
  // draw. The later Forward-only pass cannot certify that producer's coverage.
  const entryPoint = contributorFragmentEntry(
    snapshot,
    pass,
    selectedProgramFact,
    retained !== undefined,
    forwardOnly,
    expectedFragmentEntry,
  );
  const authoredShaderId =
    retained === undefined
      ? runtimeMaterialShaderId(pass.program.module, pass.name)
      : selectedProgramFact.authoredShaderId;
  const gbufferWriter = isCertifiedGBufferWriter(snapshot, pass, lane, forwardOnly, entryPoint);
  const compactGbufferWriter =
    lane === 'deferred' && !forwardOnly && fitsCompactGBuffer(snapshot, row, authoredShaderId)
      ? (row?.lightingChannels ?? LIGHTING_CHANNELS_DEFAULT) === LIGHTING_CHANNELS_DEFAULT
        ? 'default-channels'
        : 'lighting-channels'
      : undefined;
  const compactReceiverContext =
    compactGbufferWriter !== undefined &&
    (row?.probeBlendRecord !== undefined || row?.shadowReceiver === false)
      ? true
      : undefined;
  const id =
    previous?.facts?.sourceTuple === sourceTuple ? previous.id : JSON.stringify(sourceTuple);
  const publication =
    retained?.publication ??
    JSON.stringify([
      snapshot.materialPublication?.identity ?? null,
      snapshot.materialProgramKeys?.[pass.name] ?? materialShaderId,
    ]);
  const geometry = snapshot.materialContext?.geometry ?? 'unknown';
  const deformation = deformationForContributor(
    row,
    snapshot.materialContext?.geometry ?? 'unknown',
  );
  const selectedProgram =
    retained?.selectedProgram ?? JSON.stringify(selectedProgramFact.program ?? null);
  const dispatchProgramKey = materialShaderId ?? '';
  const authoredModule = pass.program.module;
  const publishedFragmentEntries = selectedProgramFact.fragmentEntryPoints;
  const registryLookupKey = selectedProgramFact.registryLookupKey;
  const selectedPass = pass.name;
  const publicationIdentity = selectedProgramFact.publicationIdentity;
  const selectedProgramFacts = selectedProgramFact.program;
  const programCandidates = retained?.candidates ?? [selectedProgramFact];
  const morphWeightsPresent = row?.morph !== undefined;
  const skinBindingPresent = row?.skinBinding !== undefined;
  if (
    previous !== undefined &&
    retained !== undefined &&
    previous.compactGbufferWriter === compactGbufferWriter &&
    previous.compactReceiverContext === compactReceiverContext &&
    matchesSelectedContributor(
      previous,
      selectedProgramFact,
      sourceTuple,
      publication,
      forwardOnly,
      geometry,
      deformation,
      entryPoint,
      dispatchProgramKey,
      expectedFragmentEntry,
      morphWeightsPresent,
      skinBindingPresent,
    )
  )
    return previous;
  const contributor: ProducedContributor = {
    forwardOnly,
    gbufferWriter,
    ...(compactGbufferWriter === undefined ? {} : { compactGbufferWriter }),
    ...(compactReceiverContext === undefined ? {} : { compactReceiverContext }),
    id,
    publication,
    materialShaderId: authoredShaderId ?? '',
    geometry,
    deformation,
    entryPoint,
    selectedProgram,
    facts: {
      sourceTuple,
      dispatchProgramKey,
      authoredModule,
      authoredShaderId,
      expectedFragmentEntry,
      publishedFragmentEntries,
      registryLookupKey,
      selectedPass,
      publicationIdentity,
      selectedProgramFacts,
      programCandidates,
      morphWeightsPresent,
      skinBindingPresent,
      materialSnapshotMissing: false,
      selectedPassFound: true,
    },
  };
  if (retained !== undefined) contributor[contributorProgram] = selectedProgramFact;
  return contributor;
}

function contributorFragmentEntry(
  snapshot: MaterialResource['snapshot'],
  pass: MaterialResource['snapshot']['passes'][number],
  selectedProgramFact: StandardSceneDataContributorProgramFact,
  retained: boolean,
  forwardOnly: boolean,
  expectedFragmentEntry: string,
): string | undefined {
  if (forwardOnly) return undefined;
  if (retained)
    return selectedProgramFact.fragmentEntryPoints.includes(expectedFragmentEntry)
      ? expectedFragmentEntry
      : undefined;
  return (snapshot.materialProgramInputs?.[pass.name]?.entryPoints ?? []).find(
    (entry) => entry.stage === 'fragment' && entry.name === expectedFragmentEntry,
  )?.name;
}

/** Complete current observations, compared only against a producer-owned prior. */
function matchesSelectedContributor(
  previous: StandardSceneDataContributor,
  program: StandardSceneDataContributorProgramFact,
  sourceTuple: StandardSceneDataContributorTuple,
  publication: string,
  forwardOnly: boolean,
  geometry: StandardSceneDataContributor['geometry'],
  deformation: StandardSceneDataContributor['deformation'],
  entryPoint: string | undefined,
  dispatchProgramKey: string,
  expectedFragmentEntry: string,
  morphWeightsPresent: boolean,
  skinBindingPresent: boolean,
): boolean {
  return (
    (previous as ProducedContributor)[contributorProgram] === program &&
    previous.facts?.sourceTuple === sourceTuple &&
    previous.publication === publication &&
    previous.forwardOnly === forwardOnly &&
    previous.geometry === geometry &&
    previous.deformation === deformation &&
    previous.entryPoint === entryPoint &&
    previous.facts.dispatchProgramKey === dispatchProgramKey &&
    previous.facts.expectedFragmentEntry === expectedFragmentEntry &&
    previous.facts.morphWeightsPresent === morphWeightsPresent &&
    previous.facts.skinBindingPresent === skinBindingPresent
  );
}

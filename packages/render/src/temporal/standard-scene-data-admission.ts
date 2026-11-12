import { runtimeMaterialShaderId } from '@forgeax/engine-assets-runtime';
import { isStandardRootModule } from '@forgeax/engine-types';
import { SceneDataUnavailableError } from '../errors/render';
import {
  deriveRenderFeaturePassAccess,
  type RenderFeatureDerivedAccess,
  type RenderFeaturePlannedFrame,
} from '../features/plan';
import type { MaterialResource } from '../material-resource';
import { runtimeMaterialShaderIdForMaterial } from '../material-resource';
import {
  isCanonicalStandardPbrMaterialShader,
  isStandardPbrSkinMaterialShader,
} from '../pbr-pipeline';
import { matchesRecordMode } from '../record/material-pass-selection';
import type { RenderPipelineTopology } from '../render-pipeline';
import type { DispatchEntry, RenderableSnapshot } from '../render-system-extract';
import { GenerationalWeakMap } from '../scene/generational-weak-map';
import { DEFERRED_PASS_SELECTOR, FORWARD_PASS_SELECTOR, matchPass } from '../systems/pass-selector';
import { materialProgramFact, retainedMaterialProgramFacts } from './material-program-facts';
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

export function sceneDataSurfaceBindings(
  plans: readonly RenderFeaturePlannedFrame[],
  admission?: StandardSceneSurfaceAdmission,
): readonly SceneDataSurfaceBinding[] {
  const owners = new Map<SceneDataSchemaId, Map<string, SceneDataBindingOwner>>();
  for (const planned of plans) {
    for (const pass of planned.plan.passes) {
      for (const access of deriveRenderFeaturePassAccess(planned.plan, pass)) {
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
  /** Proven by the same pass selectors as the later opaque Forward pass. */
  readonly forwardOnly?: boolean;
  readonly id: string;
  readonly publication: string;
  readonly materialShaderId: string;
  readonly geometry: string;
  readonly deformation: 'rigid' | 'skin' | 'morph' | 'unknown';
  readonly entryPoint: string | undefined;
  readonly selectedProgram: string;
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
export class ProducedStandardSceneDataAdmissionInput implements StandardSceneDataAdmissionInput {
  declare readonly viewIdentity: StandardSceneDataAdmissionInput['viewIdentity'];
  declare readonly generation: StandardSceneDataAdmissionInput['generation'];
  declare readonly deviceGeneration: StandardSceneDataAdmissionInput['deviceGeneration'];
  declare readonly standardPipeline: StandardSceneDataAdmissionInput['standardPipeline'];
  declare readonly cameraAvailable: StandardSceneDataAdmissionInput['cameraAvailable'];
  declare readonly lane: StandardSceneDataAdmissionInput['lane'];
  declare readonly renderPath: StandardSceneDataAdmissionInput['renderPath'];
  readonly contributors: StandardSceneDataContributor[] = [];
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

// Only this producer's frozen primitive observations can reuse a prior proof.
// Raw/custom contributors keep the complete ordinary getter and diagnostic route.
const ownedContributors = new WeakSet<StandardSceneDataContributor>();
const contributorProgram = Symbol('StandardSceneDataContributor.program');
type ProducedContributor = StandardSceneDataContributor & {
  [contributorProgram]?: StandardSceneDataContributorProgramFact;
};
type AdmissionProof = {
  readonly kind: 'available' | 'unavailable';
  readonly header: Omit<StandardSceneDataAdmissionInput, 'contributors'>;
  readonly contributors: readonly StandardSceneDataContributor[];
};
const admissionProofs = new GenerationalWeakMap<StandardSceneSurfaceAdmission, AdmissionProof>();

function rememberAvailableProof(
  admitted: StandardSceneSurfaceAdmission,
  input: StandardSceneDataAdmissionInput,
): void {
  if (!input.contributors.every((row) => ownedContributors.has(row))) return;
  const { contributors, ...header } = input;
  // Retain the producer observations themselves, not a second primitive-field roster.
  admissionProofs.set(admitted, {
    kind: 'available',
    header,
    contributors: Object.freeze(contributors.slice()),
  });
}

/** The prior complete proof's immutable producer observations, in contribution order. */
export function standardSceneSurfaceContributorBaseline(
  admitted: StandardSceneSurfaceAdmission | undefined,
): readonly StandardSceneDataContributor[] | undefined {
  return admitted === undefined ? undefined : admissionProofs.get(admitted)?.contributors;
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
    // The private marker is issued only after fixedProgramSnapshot's deep, plain,
    // dense program proof. These exact links cover all nested diagnostic facts.
    facts.publishedFragmentEntries === program.fragmentEntryPoints &&
    facts.publicationIdentity === program.publicationIdentity &&
    facts.selectedProgramFacts === program.program &&
    facts.programCandidates !== undefined &&
    Object.isFrozen(facts.programCandidates) &&
    facts.programCandidates.length === 1 &&
    facts.programCandidates[0] === program
  );
}

function rememberUnavailableProof(
  admitted: StandardSceneSurfaceAdmission,
  input: StandardSceneDataAdmissionInput,
): void {
  if (
    admitted.status !== 'unavailable' ||
    admitted.reason !== 'coverage-incomplete' ||
    !ProducedStandardSceneDataAdmissionInput.hasFixedHeader(input) ||
    !input.contributors.every(completeNegativeContributor)
  )
    return;
  const { contributors, ...header } = input;
  admissionProofs.set(admitted, {
    kind: 'unavailable',
    header: Object.freeze(header),
    // The live producer can continue filling/replacing its array. The proof cannot.
    contributors: Object.freeze(contributors.slice()),
  });
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
        (row.forwardOnly === true) === (prior.forwardOnly === true) &&
        row.facts?.authoredShaderId === prior.facts?.authoredShaderId &&
        row.facts?.materialSnapshotMissing === prior.facts?.materialSnapshotMissing &&
        row.facts?.selectedPassFound === prior.facts?.selectedPassFound &&
        row.facts?.expectedFragmentEntry === prior.facts?.expectedFragmentEntry))
  );
}

function reusableAdmission(
  input: StandardSceneDataAdmissionInput,
  previous: StandardSceneSurfaceAdmission | undefined,
): boolean {
  if (previous === undefined) return false;
  const proof = admissionProofs.get(previous);
  if (proof === undefined) return false;
  if (
    proof.kind === 'unavailable' &&
    !ProducedStandardSceneDataAdmissionInput.hasFixedHeader(input)
  )
    return false;
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
    return false;
  for (let index = 0; index < input.contributors.length; index++) {
    const row = input.contributors[index],
      prior = proof.contributors[index];
    if (row === undefined || prior === undefined) return false;
    if (proof.kind === 'unavailable') {
      if (row !== prior) return false;
    } else if (!sameContributorProof(row, prior)) return false;
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
    schema: SCENE_DATA_STANDARD_SURFACE_NORMAL_V1_SCHEMA,
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

export function createStandardSceneSurfaceAdmission(
  input: StandardSceneDataAdmissionInput,
  previous?: StandardSceneSurfaceAdmission,
): StandardSceneSurfaceAdmission {
  if (previous !== undefined && reusableAdmission(input, previous)) return previous;
  const renderPath = input.standardPipeline && input.cameraAvailable ? input.renderPath : undefined;
  const expectedEntry = renderPath === 'deferred' ? 'fs_gbuffer' : 'fs_ao_input';
  const hasProducer = renderPath !== undefined;
  const decisions = input.contributors.map((contributor) => ({
    contributor,
    rejection:
      renderPath === undefined
        ? undefined
        : surfaceContributorRejection(contributor, expectedEntry),
  }));
  let deferredAoCompatible = renderPath === 'deferred';
  const rejected = decisions.flatMap(({ contributor, rejection }) => {
    if (rejection === undefined) return [];
    // These rows are composed after GBuffer lighting/AO, by the existing
    // Forward-only pass. Do not turn their absent GBuffer into a frame error.
    if (
      contributor.forwardOnly !== true ||
      contributor.facts?.selectedPassFound !== true ||
      contributor.facts.materialSnapshotMissing !== false
    )
      deferredAoCompatible = false;
    return [surfaceContributorDiagnostic(contributor, rejection)];
  });
  rejected.sort((left, right) => left.id.localeCompare(right.id));
  const missingContributorIds = Object.freeze(rejected.slice(0, 32).map(({ id }) => id));
  const missingContributors = Object.freeze(rejected.slice(0, 32));
  const omittedMissingContributorCount = Math.max(0, rejected.length - 32);
  const producer =
    renderPath === undefined
      ? undefined
      : input.contributors.length === 0
        ? 'clear-background'
        : renderPath === 'deferred'
          ? 'standard-deferred-gbuffer'
          : 'standard-forward-surface-pass';
  const identityRows = decisions.map(({ contributor, rejection }) =>
    contributorIdentityFields(contributor, rejection?.reason),
  );
  // A singleton needs no ordering key. Keep its original direct serialization.
  const orderedIdentityRows =
    identityRows.length < 2
      ? identityRows
      : identityRows
          .map((fields) => ({ fields, key: JSON.stringify(fields) }))
          .sort((left, right) => left.key.localeCompare(right.key))
          .map(({ fields }) => fields);
  const identity = JSON.stringify([
    input.viewIdentity,
    input.generation,
    input.deviceGeneration,
    input.standardPipeline,
    input.cameraAvailable,
    input.lane,
    input.renderPath,
    producer,
    orderedIdentityRows,
    rejected.map(({ id, reason }) => [id, reason]),
  ]);
  const base = {
    identity,
    deferredGBufferEmpty:
      renderPath === 'deferred' &&
      deferredAoCompatible &&
      rejected.length === input.contributors.length,
    viewIdentity: input.viewIdentity,
    generation: input.generation,
    deviceGeneration: input.deviceGeneration,
    lane: input.lane,
  };
  if (renderPath !== undefined && producer !== undefined && rejected.length === 0) {
    const admitted: StandardSceneSurfaceAdmission = Object.freeze({
      ...base,
      renderPath,
      status: 'available',
      producer,
      missingContributorIds: Object.freeze([]) as readonly [],
    });
    rememberAvailableProof(admitted, input);
    return admitted;
  }
  const admitted: StandardSceneSurfaceAdmission = Object.freeze({
    ...base,
    renderPath: input.renderPath,
    status: 'unavailable',
    reason: hasProducer ? 'coverage-incomplete' : 'producer-missing',
    deferredAoCompatible,
    missingContributorIds: hasProducer ? missingContributorIds : Object.freeze([]),
    missingContributors: hasProducer ? missingContributors : Object.freeze([]),
    omittedMissingContributorCount: hasProducer ? omittedMissingContributorCount : 0,
  });
  rememberUnavailableProof(admitted, input);
  return admitted;
}

type SurfaceContributorRejection = {
  readonly reason: StandardSceneDataContributorRejectionReason;
  readonly rejectedField: StandardSceneDataContributorRejectedField;
};

/** Capture the complete tuple once before canonical ordering. */
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
  ];
}

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
  if (facts?.materialSnapshotMissing === true)
    return { reason: 'material-snapshot-missing', rejectedField: 'material-snapshot' };
  if (facts?.selectedPassFound === false)
    return { reason: 'selected-pass-missing', rejectedField: 'selected-pass' };
  if (
    !isCanonicalStandardPbrMaterialShader(authoredShaderId) &&
    (authoredShaderId === undefined || !isStandardRootModule(authoredShaderId)) &&
    !unlitForward
  )
    return { reason: 'authored-program-not-standard-pbr', rejectedField: 'authored-shader-id' };
  const geometry = surfaceGeometryRejection(contributor, authoredShaderId);
  if (geometry !== undefined) return geometry;
  if (
    contributor.entryPoint !== expectedEntry ||
    (facts?.expectedFragmentEntry !== undefined && facts.expectedFragmentEntry !== expectedEntry)
  )
    return { reason: 'missing-fragment-entry', rejectedField: 'fragment-entry-point' };
  return undefined;
}

/** Deformation producers retain the selected rigid or Skin program's input ABI. */
function surfaceGeometryRejection(
  contributor: StandardSceneDataContributor,
  authoredShaderId: string | undefined,
): SurfaceContributorRejection | undefined {
  if (contributor.geometry !== 'mesh' && contributor.geometry !== 'skinned')
    return { reason: 'unsupported-geometry', rejectedField: 'geometry' };
  if (
    contributor.geometry === 'mesh' &&
    contributor.deformation !== 'rigid' &&
    contributor.deformation !== 'morph'
  )
    return { reason: 'unsupported-deformation', rejectedField: 'deformation' };
  if (
    contributor.geometry === 'skinned' &&
    ((contributor.deformation !== 'skin' && contributor.deformation !== 'morph') ||
      !isStandardPbrSkinMaterialShader(authoredShaderId))
  )
    return { reason: 'unsupported-deformation', rejectedField: 'deformation' };
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

type ContributorRow = Pick<RenderableSnapshot, 'morph' | 'skinBinding'>;
type ContributorMaterials = Pick<RenderableSnapshot, 'material' | 'materials'>;
type ContributorSource = ContributorRow &
  ContributorMaterials &
  Pick<RenderableSnapshot, 'worldId' | 'entityKey'>;

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
  if (!matchesRecordMode(material.snapshot, 'opaque')) return undefined;
  return material.snapshot.passes.find((pass) => {
    const passTags = (pass.renderState?.tags as Record<string, string> | undefined) ?? {};
    if (passTags.LightMode !== tags.LightMode) return false;
    const shaderId = runtimeMaterialShaderIdForMaterial(
      [pass],
      material.snapshot.materialProgramKeys,
    );
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
  const worldId = row?.worldId ?? -1;
  const entityKey = row?.entityKey ?? -1;
  return standardSceneDataContributorFromColumns(
    row,
    row,
    worldId,
    entityKey,
    dispatch,
    lane,
    previous,
  );
}

/** Native Scene columns share the judgement without assembling a snapshot-shaped wrapper. */
export function standardSceneDataContributorFromColumns(
  row: ContributorRow | undefined,
  materials: ContributorMaterials | undefined,
  worldId: number,
  entityKey: number,
  dispatch: StandardSceneDataDispatch,
  lane: 'forward' | 'deferred',
  previous?: StandardSceneDataContributor,
): StandardSceneDataContributor | undefined {
  const materialHandle = dispatch.materialHandle;
  const passIndex = dispatch.passIndex;
  const materialShaderId = dispatch.materialShaderId;
  const tags = dispatch.tags;
  const material = materialForDispatch(materials, materialHandle);
  if (
    material === undefined
      ? !matchPass(tags, lane === 'deferred' ? DEFERRED_PASS_SELECTOR : FORWARD_PASS_SELECTOR)
      : !isRequiredSurfaceDispatch(material, tags, lane)
  )
    return undefined;
  const prior = previous !== undefined && ownedContributors.has(previous) ? previous : undefined;
  const sourceTuple = contributorSourceTuple(prior, worldId, entityKey, materialHandle, passIndex);
  const expectedFragmentEntry = lane === 'deferred' ? 'fs_gbuffer' : 'fs_ao_input';
  if (material === undefined)
    return ownContributor(
      missingSnapshotContributor(row, sourceTuple, materialShaderId, expectedFragmentEntry),
    );
  const pass = passForDispatch(material, materialShaderId, tags);
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
    ),
  );
}

function contributorSourceTuple(
  previous: StandardSceneDataContributor | undefined,
  worldId: number,
  entityKey: number,
  materialHandle: number,
  passIndex: number,
): StandardSceneDataContributorTuple {
  const tuple = previous?.facts?.sourceTuple;
  if (
    tuple !== undefined &&
    typeof worldId === 'number' &&
    typeof entityKey === 'number' &&
    typeof materialHandle === 'number' &&
    typeof passIndex === 'number' &&
    Object.is(tuple[0], worldId) &&
    Object.is(tuple[1], entityKey) &&
    Object.is(tuple[2], materialHandle) &&
    Object.is(tuple[3], passIndex)
  )
    return tuple;
  return Object.freeze([worldId, entityKey, materialHandle, passIndex] as const);
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
): StandardSceneDataContributor {
  const snapshot = material.snapshot;
  const retained = retainedMaterialProgramFacts(material, snapshot, pass, materialShaderId);
  const selectedProgramFact = retained?.fact ?? materialProgramFact(material, pass);
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
  return (snapshot.materialEntryPoints?.[pass.name] ?? []).find(
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

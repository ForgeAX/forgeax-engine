import { runtimeMaterialShaderId } from '@forgeax/engine-assets-runtime';
import { SceneDataUnavailableError } from '../errors/render';
import {
  deriveRenderFeaturePassAccess,
  type RenderFeatureDerivedAccess,
  type RenderFeaturePlannedFrame,
} from '../features/plan';
import type { MaterialResource } from '../material-resource';
import { runtimeMaterialShaderIdForMaterial } from '../material-resource';
import { isCanonicalStandardPbrMaterialShader } from '../pbr-pipeline';
import { matchesRecordMode } from '../record/material-pass-selection';
import type { RenderPipelineTopology } from '../render-pipeline';
import type { RenderableSnapshot } from '../render-system-extract';
import { DEFERRED_PASS_SELECTOR, FORWARD_PASS_SELECTOR, matchPass } from '../systems/pass-selector';
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
  if (sameOwner && admission.status === 'available') return undefined;
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
): StandardSceneSurfaceAdmission {
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
  const rejected = decisions.flatMap(({ contributor, rejection }) =>
    rejection === undefined ? [] : [surfaceContributorDiagnostic(contributor, rejection)],
  );
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
  const identity = JSON.stringify([
    input.viewIdentity,
    input.generation,
    input.deviceGeneration,
    input.standardPipeline,
    input.cameraAvailable,
    input.lane,
    input.renderPath,
    producer,
    decisions
      .map(({ contributor: row, rejection }) => [
        row.id,
        row.publication,
        row.materialShaderId,
        row.geometry,
        row.deformation,
        row.entryPoint,
        row.selectedProgram,
        rejection?.reason,
      ])
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    rejected.map(({ id, reason }) => [id, reason]),
  ]);
  const base = {
    identity,
    viewIdentity: input.viewIdentity,
    generation: input.generation,
    deviceGeneration: input.deviceGeneration,
    lane: input.lane,
  };
  if (renderPath !== undefined && producer !== undefined && rejected.length === 0) {
    return Object.freeze({
      ...base,
      renderPath,
      status: 'available',
      producer,
      missingContributorIds: Object.freeze([]) as readonly [],
    });
  }
  return Object.freeze({
    ...base,
    renderPath: input.renderPath,
    status: 'unavailable',
    reason: hasProducer ? 'coverage-incomplete' : 'producer-missing',
    missingContributorIds: hasProducer ? missingContributorIds : Object.freeze([]),
    missingContributors: hasProducer ? missingContributors : Object.freeze([]),
    omittedMissingContributorCount: hasProducer ? omittedMissingContributorCount : 0,
  });
}

function surfaceContributorRejection(
  contributor: StandardSceneDataContributor,
  expectedEntry: string,
):
  | {
      readonly reason: StandardSceneDataContributorRejectionReason;
      readonly rejectedField: StandardSceneDataContributorRejectedField;
    }
  | undefined {
  const facts = contributor.facts;
  const authoredShaderId = facts?.authoredShaderId ?? contributor.materialShaderId;
  if (facts?.materialSnapshotMissing === true)
    return { reason: 'material-snapshot-missing', rejectedField: 'material-snapshot' };
  if (facts?.selectedPassFound === false)
    return { reason: 'selected-pass-missing', rejectedField: 'selected-pass' };
  if (!isCanonicalStandardPbrMaterialShader(authoredShaderId))
    return { reason: 'authored-program-not-standard-pbr', rejectedField: 'authored-shader-id' };
  if (contributor.geometry !== 'mesh' && contributor.geometry !== 'skinned')
    return { reason: 'unsupported-geometry', rejectedField: 'geometry' };
  if (contributor.geometry === 'mesh' && contributor.deformation !== 'rigid')
    return { reason: 'unsupported-deformation', rejectedField: 'deformation' };
  if (
    contributor.geometry === 'skinned' &&
    (contributor.deformation !== 'skin' ||
      (authoredShaderId !== 'forgeax::pbr-skin' &&
        authoredShaderId !== 'forgeax::default-standard-pbr-skin'))
  )
    return { reason: 'unsupported-deformation', rejectedField: 'deformation' };
  if (
    contributor.entryPoint !== expectedEntry ||
    (facts?.expectedFragmentEntry !== undefined && facts.expectedFragmentEntry !== expectedEntry)
  )
    return { reason: 'missing-fragment-entry', rejectedField: 'fragment-entry-point' };
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

function materialForDispatch(
  row: RenderableSnapshot | undefined,
  materialHandle: number,
): MaterialResource | undefined {
  if (row === undefined) return undefined;
  return (
    row.materials.find((material) => material.snapshot.materialHandle === materialHandle) ??
    (row.material.snapshot.materialHandle === materialHandle ? row.material : undefined)
  );
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

function materialProgramFact(
  material: MaterialResource,
  pass: MaterialResource['snapshot']['passes'][number],
): StandardSceneDataContributorProgramFact {
  const snapshot = material.snapshot;
  const selectedProgramKey = snapshot.materialProgramKeys?.[pass.name];
  const registryLookupKey =
    selectedProgramKey ?? runtimeMaterialShaderId(pass.program.module, pass.name);
  const selectedProgram = snapshot.materialPublication?.programs.find(
    (program) => program.pass === pass.name,
  );
  return Object.freeze({
    pass: pass.name,
    authoredModule: pass.program.module,
    authoredShaderId: runtimeMaterialShaderId(pass.program.module, pass.name),
    selectedProgramKey,
    registryLookupKey,
    fragmentEntryPoints: Object.freeze(
      (snapshot.materialEntryPoints?.[pass.name] ?? [])
        .filter((entry) => entry.stage === 'fragment')
        .map((entry) => entry.name),
    ),
    publicationIdentity: snapshot.materialPublication?.identity,
    program:
      selectedProgram === undefined
        ? undefined
        : Object.freeze({
            context: selectedProgram.context,
            address: selectedProgram.address,
            specializationKey: selectedProgram.specializationKey,
            artifactHash: selectedProgram.artifactHash,
          }),
  });
}

function deformationForContributor(
  row: RenderableSnapshot | undefined,
  geometry: string,
): StandardSceneDataContributor['deformation'] {
  if (row?.morph !== undefined) return 'morph';
  if (row?.skinBinding !== undefined) return 'skin';
  return geometry === 'mesh' ? 'rigid' : 'unknown';
}

export function standardSceneDataContributorForDispatch(input: {
  readonly row: RenderableSnapshot | undefined;
  readonly sourceTuple: StandardSceneDataContributorTuple;
  readonly materialHandle: number;
  readonly materialShaderId: string | undefined;
  readonly tags: Record<string, string>;
  readonly lane: 'forward' | 'deferred';
  readonly id: string;
}): StandardSceneDataContributor | undefined {
  const material = materialForDispatch(input.row, input.materialHandle);
  const expectedFragmentEntry = input.lane === 'deferred' ? 'fs_gbuffer' : 'fs_ao_input';
  if (material === undefined) return missingSnapshotContributor(input, expectedFragmentEntry);
  if (!isRequiredSurfaceDispatch(material, input.tags, input.lane)) return undefined;
  const pass = passForDispatch(material, input.materialShaderId, input.tags);
  if (pass === undefined)
    return selectedPassMissingContributor(material, input, expectedFragmentEntry);
  return selectedPassContributor(material, input, pass, expectedFragmentEntry);
}

type StandardSceneDataDispatchInput = Parameters<typeof standardSceneDataContributorForDispatch>[0];

function missingSnapshotContributor(
  input: StandardSceneDataDispatchInput,
  expectedFragmentEntry: string,
): StandardSceneDataContributor | undefined {
  const selected = matchPass(
    input.tags,
    input.lane === 'deferred' ? DEFERRED_PASS_SELECTOR : FORWARD_PASS_SELECTOR,
  );
  if (!selected) return undefined;
  return {
    id: input.id,
    publication: '',
    materialShaderId: input.materialShaderId ?? '',
    geometry: 'unknown',
    deformation: deformationForContributor(input.row, 'unknown'),
    entryPoint: undefined,
    selectedProgram: '',
    facts: {
      sourceTuple: input.sourceTuple,
      dispatchProgramKey: input.materialShaderId ?? '',
      authoredModule: undefined,
      authoredShaderId: undefined,
      expectedFragmentEntry,
      publishedFragmentEntries: Object.freeze([]),
      registryLookupKey: undefined,
      selectedPass: undefined,
      publicationIdentity: undefined,
      selectedProgramFacts: undefined,
      programCandidates: Object.freeze([]),
      morphWeightsPresent: input.row?.morph !== undefined,
      skinBindingPresent: input.row?.skinBinding !== undefined,
      materialSnapshotMissing: true,
      selectedPassFound: false,
    },
  };
}

function selectedPassMissingContributor(
  material: MaterialResource,
  input: StandardSceneDataDispatchInput,
  expectedFragmentEntry: string,
): StandardSceneDataContributor {
  const candidate = material.snapshot.passes.find((entry) => {
    const tags = (entry.renderState?.tags as Record<string, string> | undefined) ?? {};
    return tags.LightMode === input.tags.LightMode;
  });
  const candidateFact =
    candidate === undefined ? undefined : materialProgramFact(material, candidate);
  const geometry = material.snapshot.materialContext?.geometry ?? 'unknown';
  return {
    id: input.id,
    publication: '',
    materialShaderId: candidateFact?.authoredShaderId ?? input.materialShaderId ?? '',
    geometry,
    deformation: deformationForContributor(input.row, geometry),
    entryPoint: undefined,
    selectedProgram: '',
    facts: {
      sourceTuple: input.sourceTuple,
      dispatchProgramKey: input.materialShaderId ?? '',
      authoredModule: candidateFact?.authoredModule,
      authoredShaderId: candidateFact?.authoredShaderId,
      expectedFragmentEntry,
      publishedFragmentEntries: candidateFact?.fragmentEntryPoints ?? Object.freeze([]),
      registryLookupKey: candidateFact?.registryLookupKey,
      selectedPass: candidate?.name,
      publicationIdentity: material.snapshot.materialPublication?.identity,
      selectedProgramFacts: candidateFact?.program,
      programCandidates: candidateFact === undefined ? Object.freeze([]) : [candidateFact],
      morphWeightsPresent: input.row?.morph !== undefined,
      skinBindingPresent: input.row?.skinBinding !== undefined,
      materialSnapshotMissing: false,
      selectedPassFound: false,
    },
  };
}

function selectedPassContributor(
  material: MaterialResource,
  input: StandardSceneDataDispatchInput,
  pass: MaterialResource['snapshot']['passes'][number],
  expectedFragmentEntry: string,
): StandardSceneDataContributor {
  const snapshot = material.snapshot;
  const selectedProgramFact = materialProgramFact(material, pass);
  const entryPoint = (snapshot.materialEntryPoints?.[pass.name] ?? []).find(
    (entry) => entry.stage === 'fragment' && entry.name === expectedFragmentEntry,
  )?.name;
  const authoredShaderId = runtimeMaterialShaderId(pass.program.module, pass.name);
  return {
    id: input.id,
    publication: JSON.stringify([
      snapshot.materialPublication?.identity ?? null,
      snapshot.materialProgramKeys?.[pass.name] ?? input.materialShaderId,
    ]),
    materialShaderId: authoredShaderId ?? '',
    geometry: snapshot.materialContext?.geometry ?? 'unknown',
    deformation: deformationForContributor(
      input.row,
      snapshot.materialContext?.geometry ?? 'unknown',
    ),
    entryPoint,
    selectedProgram: JSON.stringify(selectedProgramFact.program ?? null),
    facts: {
      sourceTuple: input.sourceTuple,
      dispatchProgramKey: input.materialShaderId ?? '',
      authoredModule: pass.program.module,
      authoredShaderId,
      expectedFragmentEntry,
      publishedFragmentEntries: selectedProgramFact.fragmentEntryPoints,
      registryLookupKey: selectedProgramFact.registryLookupKey,
      selectedPass: pass.name,
      publicationIdentity: selectedProgramFact.publicationIdentity,
      selectedProgramFacts: selectedProgramFact.program,
      programCandidates: [selectedProgramFact],
      morphWeightsPresent: input.row?.morph !== undefined,
      skinBindingPresent: input.row?.skinBinding !== undefined,
      materialSnapshotMissing: false,
      selectedPassFound: true,
    },
  };
}

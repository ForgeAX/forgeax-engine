import { evaluateMaterialOracle, type MaterialOracleInput } from '../evidence/oracle.js';
import { canonicalPresentation, createCanonicalPreviewRecipe } from '../kit/canonical.js';
import {
  loadResourceSubject,
  type ResourcePreviewArgs,
  type ResourcePreviewInput,
  subjectFailure,
} from './subject.js';

export interface MaterialSubjectInspection {
  readonly subjectDigest: string;
  readonly program: string;
  readonly pass: string;
  readonly bindingsDigest: string;
  readonly closureDigest: string;
}

/** Portable sampled-texture budget the material owner reported for the Standard program. */
export interface MaterialSampledTextureBudgetFacts {
  readonly limit: number;
  readonly required: number;
  readonly transmission: 'none' | 'dedicated' | 'shared' | 'exceeded';
  readonly conflicts: readonly string[];
}

const TRANSMISSION_BUDGET_KINDS = new Set(['none', 'dedicated', 'shared', 'exceeded']);

export function materialSampledTextureBudgetFacts(
  ownerFacts: Readonly<Record<string, unknown>> | undefined,
): MaterialSampledTextureBudgetFacts | undefined {
  const limit = ownerFacts?.sampledTextureLimit;
  const required = ownerFacts?.sampledTextureRequired;
  const transmission = ownerFacts?.sampledTextureTransmission;
  const conflicts = ownerFacts?.sampledTextureConflicts;
  if (
    typeof limit !== 'number' ||
    typeof required !== 'number' ||
    typeof transmission !== 'string' ||
    !TRANSMISSION_BUDGET_KINDS.has(transmission) ||
    typeof conflicts !== 'string'
  )
    return undefined;
  return {
    limit,
    required,
    transmission: transmission as MaterialSampledTextureBudgetFacts['transmission'],
    conflicts: conflicts.length === 0 ? [] : conflicts.split(','),
  };
}

type InspectionResult =
  | { readonly ok: true; readonly value: MaterialSubjectInspection }
  | ReturnType<typeof subjectFailure>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function digest(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function inspectMaterialSubject(input: {
  readonly guid: string;
  readonly asset: unknown;
  readonly digest?: string;
  readonly ownerFacts?: Readonly<Record<string, string | number | boolean>>;
}): InspectionResult {
  if (!isRecord(input.asset) || input.asset.kind !== 'material') {
    return subjectFailure('resource-preview-kind-mismatch', 'a MaterialAsset with kind material', {
      phase: 'subject',
      guid: input.guid,
      actualKind:
        isRecord(input.asset) && typeof input.asset.kind === 'string'
          ? input.asset.kind
          : 'unknown',
    });
  }
  const passes = input.asset.passes;
  if (!Array.isArray(passes) || passes.length === 0) {
    return subjectFailure(
      'resource-preview-subject-invalid',
      'a MaterialAsset with at least one pass',
      {
        phase: 'subject',
        guid: input.guid,
        field: 'passes',
      },
    );
  }
  const first =
    passes.find((pass) => {
      if (!isRecord(pass)) return false;
      const tags =
        isRecord(pass.renderState) && isRecord(pass.renderState.tags)
          ? pass.renderState.tags
          : undefined;
      const mode = tags?.LightMode ?? pass.name;
      return !/shadow|depth/i.test(String(mode));
    }) ?? passes[0];
  if (!isRecord(first) || typeof first.name !== 'string' || !isRecord(first.program)) {
    return subjectFailure(
      'resource-preview-subject-invalid',
      'every material pass to declare a program',
      {
        phase: 'subject',
        guid: input.guid,
        field: 'passes[0]',
      },
    );
  }
  if (typeof first.program.module !== 'string' || first.program.module.length === 0) {
    return subjectFailure(
      'resource-preview-subject-invalid',
      'the material program module identity to be present',
      {
        phase: 'subject',
        guid: input.guid,
        field: 'passes[0].program.module',
      },
    );
  }
  const owner = input.asset.ownerFacts;
  const ownerFacts = isRecord(owner) ? owner : input.ownerFacts;
  const subjectDigest = digest(input.asset.digest ?? input.digest ?? ownerFacts?.subjectDigest);
  const bindingsDigest = digest(input.asset.bindingsDigest ?? ownerFacts?.bindingsDigest);
  const closureDigest = digest(input.asset.closureDigest ?? ownerFacts?.closureDigest);
  if (subjectDigest === undefined || bindingsDigest === undefined || closureDigest === undefined) {
    return subjectFailure(
      'resource-preview-subject-invalid',
      'the MaterialAsset owner to publish subject, bindings, and closure digests',
      { phase: 'subject', guid: input.guid, field: 'ownerFacts' },
    );
  }
  return {
    ok: true,
    value: {
      subjectDigest,
      program: first.program.module,
      pass: first.name,
      bindingsDigest,
      closureDigest,
    },
  };
}

export async function executeMaterialPreview(
  args: ResourcePreviewArgs,
  input: ResourcePreviewInput,
) {
  const loaded = await loadResourceSubject(args.guid, input, 'material');
  if (!loaded.ok) return loaded;
  const inspected = inspectMaterialSubject(loaded.value);
  if (!inspected.ok) return inspected;
  const owner = loaded.value.asset.ownerFacts;
  const sampledTextureBudget = materialSampledTextureBudgetFacts(
    isRecord(owner) ? owner : loaded.value.ownerFacts,
  );
  const renderer = input.renderer;
  if (
    renderer?.rendererReady !== true ||
    renderer.worldReady !== true ||
    renderer.drawCalls <= 0 ||
    renderer.nonBlackPixels <= 0 ||
    renderer.observation === undefined
  )
    return subjectFailure(
      'resource-preview-oracle-failed',
      'shared World and Renderer to be ready',
      { phase: 'renderer', runId: input.runId },
    );
  const observed: MaterialOracleInput['observed'] = {
    subjectDigest: digest(renderer.observation.subjectDigest) ?? '',
    program: digest(renderer.observation.program) ?? '',
    pass: digest(renderer.observation.pass) ?? '',
    bindingsDigest: digest(renderer.observation.bindingsDigest) ?? '',
    closureDigest: digest(renderer.observation.closureDigest) ?? '',
    rendererHealthy: renderer.rendererReady && renderer.worldReady,
    drawCalls: renderer.drawCalls,
    nonBlackPixels: renderer.nonBlackPixels,
  };
  const oracle = evaluateMaterialOracle({ requested: inspected.value, observed });
  if (oracle.status !== 'passed') {
    return subjectFailure(
      'resource-preview-oracle-failed',
      'the rendered material observation to match the loaded owner facts',
      { phase: 'oracle', runId: input.runId, ...oracle.detail },
    );
  }
  return {
    ok: true as const,
    value: {
      subject: {
        kind: 'material' as const,
        guid: args.guid,
        digest: inspected.value.subjectDigest,
      },
      presentation: canonicalPresentation('material'),
      recipe: createCanonicalPreviewRecipe('material'),
      oracle,
      ...(sampledTextureBudget === undefined ? {} : { sampledTextureBudget }),
      artifacts: input.artifacts ?? [],
    },
    artifacts: input.artifacts ?? [],
  };
}

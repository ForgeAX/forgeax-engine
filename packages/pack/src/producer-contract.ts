import type {
  AssetSubjectRef,
  ImportedOutputDeclaration,
  ProducerContractDiagnostic,
  ProducerContractResult,
  SourceOverrideMap,
} from '@forgeax/engine-types';
import { validateSourceOverrideMap } from '@forgeax/engine-types';

type ProducerObject = Record<string, unknown>;

function isRecord(value: unknown): value is ProducerObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function issue(
  code: ProducerContractDiagnostic['code'],
  subjectId: string,
  expected: string,
  hint: string,
  actual?: string,
  authority: 'producer' | 'pack' = 'producer',
): ProducerContractResult<never> {
  const subject: AssetSubjectRef = { type: 'asset', id: subjectId };
  return {
    ok: false,
    error: {
      code,
      subject,
      expected,
      ...(actual === undefined ? {} : { actual }),
      hint,
      authority,
    },
  };
}

function validateFacts(
  value: ProducerObject,
  subjectId: string,
): ProducerContractResult<ProducerObject> {
  if ('packageId' in value && !hasText(value.packageId)) {
    return issue(
      'invalid-producer-fact',
      subjectId,
      'packageId must be a non-empty string',
      'publish a stable package identity',
    );
  }
  if ('provenance' in value) {
    const provenance = value.provenance;
    if (!isRecord(provenance) || !hasText(provenance.provider) || !hasText(provenance.version)) {
      return issue(
        'invalid-producer-fact',
        subjectId,
        'provenance.provider and provenance.version must be non-empty',
        'publish provider identity and version',
      );
    }
  }
  if ('revision' in value) {
    const revision = value.revision;
    if (
      !isRecord(revision) ||
      !hasText(revision.digest) ||
      !hasText(revision.rootId) ||
      typeof revision.observedAt !== 'number' ||
      !Number.isFinite(revision.observedAt)
    ) {
      return issue(
        'invalid-producer-fact',
        subjectId,
        'revision.digest, revision.rootId and finite revision.observedAt',
        'publish a complete resource revision',
      );
    }
  }
  if ('diagnostics' in value) {
    if (!Array.isArray(value.diagnostics)) {
      return issue(
        'invalid-producer-fact',
        subjectId,
        'diagnostics must be an array',
        'publish structured diagnostics as an array',
      );
    }
    for (const diagnostic of value.diagnostics) {
      if (!isRecord(diagnostic) || !hasText(diagnostic.code)) {
        return issue(
          'invalid-producer-fact',
          subjectId,
          'each diagnostic needs a stable code',
          'publish a machine-readable diagnostic code',
        );
      }
      if (diagnostic.severity === 'blocking') {
        if (!isRecord(diagnostic.subject) || !hasText(diagnostic.subject.id)) {
          return issue(
            'invalid-producer-fact',
            subjectId,
            'blocking diagnostic.subject must identify an object',
            'set subject.type and subject.id',
          );
        }
        if (!hasText(diagnostic.expected) || !hasText(diagnostic.hint)) {
          return issue(
            'invalid-producer-fact',
            subjectId,
            'blocking diagnostics need expected and hint',
            'provide an executable recovery hint',
          );
        }
      }
    }
  }
  return { ok: true, value };
}

function validateMetaSourceOverrides(
  value: ProducerObject,
  subjectId: string,
): ProducerContractResult<ProducerObject> {
  if (!('sourceOverrides' in value)) return { ok: true, value };
  const declaredSourceKeys = Array.isArray(value.subAssets)
    ? value.subAssets.flatMap((subAsset) =>
        isRecord(subAsset) && hasText(subAsset.sourceKey) ? [subAsset.sourceKey] : [],
      )
    : [];
  const result = validateSourceOverrideMap(value.sourceOverrides, declaredSourceKeys);
  if (!result.ok) {
    return issue(
      result.error.code,
      subjectId,
      result.error.expected,
      result.error.hint,
      result.error.actual,
      'pack',
    );
  }
  return {
    ok: true,
    value: { ...value, sourceOverrides: result.value as SourceOverrideMap | undefined },
  };
}

/**
 * Validate one package or imported-output producer declaration.
 *
 * The accepted fields mirror the engine-types POD contract. This function
 * validates that schema without creating a second schema or interpreting
 * diagnostic messages.
 */
export function validateProducerContract(value: unknown): ProducerContractResult<ProducerObject> {
  if (!isRecord(value)) {
    return issue(
      'invalid-producer-fact',
      'unknown',
      'producer declaration must be an object',
      'publish a JSON object',
    );
  }

  const subjectId = hasText(value.guid)
    ? value.guid
    : hasText(value.packageId)
      ? value.packageId
      : 'unknown';
  const facts = validateFacts(value, subjectId);
  if (!facts.ok) return facts;

  const metaOverrides = validateMetaSourceOverrides(value, subjectId);
  if (!metaOverrides.ok) return metaOverrides;

  if ('kind' in value && !hasText(value.kind)) {
    return issue(
      'invalid-producer-fact',
      subjectId,
      'kind must be a non-empty open string',
      'publish the provider-owned asset kind',
    );
  }
  if ('execution' in value && value.execution !== 'direct' && value.execution !== 'cooked') {
    return issue(
      'invalid-producer-fact',
      subjectId,
      'execution must be either direct or cooked',
      'publish the explicit authoring execution mode',
    );
  }
  const hasOutputIdentity = 'kind' in value || 'sourceIndex' in value || 'sourceKey' in value;
  if (!hasOutputIdentity) return facts;
  if (value.sourceKey !== undefined && !hasText(value.sourceKey)) {
    return issue(
      'invalid-source-key',
      subjectId,
      'sourceKey must be a non-empty producer-owned string',
      'publish a stable semantic sourceKey',
    );
  }
  if (
    value.sourceIndex !== undefined &&
    (typeof value.sourceIndex !== 'number' ||
      !Number.isInteger(value.sourceIndex) ||
      value.sourceIndex < 0)
  ) {
    return issue(
      'invalid-source-index',
      subjectId,
      'sourceIndex must be a non-negative integer locator',
      'publish a non-negative sourceIndex without using it as identity',
    );
  }
  if (value.sourceKey === undefined && value.sourceIndex !== undefined) {
    return issue(
      'missing-source-key',
      subjectId,
      'sourceKey is required when an output declares sourceIndex',
      'publish a stable semantic key; do not derive identity from sourceIndex',
    );
  }
  if (
    'compatiblePreviousKinds' in value &&
    (!Array.isArray(value.compatiblePreviousKinds) ||
      value.compatiblePreviousKinds.some((kind) => !hasText(kind)))
  ) {
    return issue(
      'invalid-producer-fact',
      subjectId,
      'compatiblePreviousKinds must be an array of non-empty kind strings',
      'declare only producer-verified prior kinds that may preserve the GUID',
    );
  }
  return metaOverrides;
}

/**
 * Validate output topology without ever treating `sourceIndex` as identity.
 *
 * AI-readable callers should use the discriminated result and its structured
 * `code`, `expected`, `actual`, and `hint` fields for recovery decisions.
 */
export function validateProducerOutputs(
  outputs: readonly ImportedOutputDeclaration[],
): ProducerContractResult<readonly ImportedOutputDeclaration[]> {
  const missingKey = outputs.find((output) => output.sourceKey === undefined);
  if (missingKey !== undefined) {
    return issue(
      outputs.length > 1 ? 'source-index-ambiguous' : 'missing-source-key',
      missingKey.guid,
      'every output declaration needs a stable sourceKey',
      'add sourceKey to each output before matching topology',
    );
  }
  const keys = new Map<string, ImportedOutputDeclaration>();
  for (const output of outputs) {
    const result = validateProducerContract(output);
    if (!result.ok) return result;
    const sourceKey = output.sourceKey;
    if (sourceKey === undefined) continue;
    const prior = keys.get(sourceKey);
    if (prior !== undefined) {
      return issue(
        'duplicate-source-key',
        output.guid,
        'sourceKey values must be unique within one producer package',
        'rename the duplicate semantic output key',
        sourceKey,
      );
    }
    keys.set(sourceKey, output);
  }
  return { ok: true, value: outputs };
}

import {
  type CookedMaterialRecord,
  createMaterialArtifactDigest,
  type MaterialCookProgramContext,
  materialLayerPlanIdentity,
  validateCookedMaterialRecord,
} from '@forgeax/engine-pack';
import type { MaterialProgramAddress } from '@forgeax/engine-types';

export interface MaterialLoadRequest {
  readonly guid: string;
  readonly specializationKey: string;
}

export interface MaterialReady {
  readonly status: 'Ready';
  readonly record: CookedMaterialRecord &
    Required<
      Pick<
        CookedMaterialRecord,
        | 'materialGuid'
        | 'publicationGeneration'
        | 'specializationKey'
        | 'artifactDigest'
        | 'sourceClosure'
        | 'parameterContract'
      >
    >;
}

export interface MaterialPublication {
  readonly guid: string;
  readonly record: unknown;
  readonly artifactError?: {
    readonly code: 'asset-artifact-missing' | 'asset-artifact-integrity-mismatch';
    readonly expected: string;
    readonly actual?: string;
  };
  readonly artifacts?: Readonly<
    Record<string, { readonly bytes: Uint8Array; readonly digest?: string }>
  >;
}

export type MaterialLoadErrorCode =
  | 'material-specialization-not-cooked'
  | 'asset-artifact-missing'
  | 'asset-artifact-integrity-mismatch'
  | 'material-cook-record-invalid'
  | 'material-reference-not-ready';

export interface MaterialLoadErrorDetail {
  readonly guid: string;
  readonly specializationKey: string;
  readonly publicationGeneration?: number;
  readonly field?: string;
  readonly pass?: string;
  readonly context?: MaterialCookProgramContext;
  readonly address?: MaterialProgramAddress;
  readonly matches?: number;
  readonly vertexColorAvailable?: boolean;
  readonly missing?: readonly string[];
  readonly expected?: string;
  readonly actual?: string;
}

export interface MaterialLoadError {
  readonly status: 'Error';
  readonly error: {
    readonly code: MaterialLoadErrorCode;
    readonly expected: string;
    readonly hint: string;
    readonly retryable: boolean;
    readonly recoveryActions: readonly string[];
    readonly detail: MaterialLoadErrorDetail;
  };
}

export interface MaterialLoaderOptions {
  readonly loadPublication: (
    guid: string,
    specializationKey: string,
  ) => Promise<MaterialPublication | undefined>;
  readonly loadReference?: (guid: string) => Promise<boolean>;
}

function materialError(
  request: MaterialLoadRequest,
  code: MaterialLoadErrorCode,
  expected: string,
  hint: string,
  detail: Omit<MaterialLoadErrorDetail, 'guid' | 'specializationKey'> = {},
  retryable = false,
): MaterialLoadError {
  return {
    status: 'Error',
    error: {
      code,
      expected,
      hint,
      retryable,
      recoveryActions: retryable ? ['retry-material-load'] : ['recook-material-publication'],
      detail: { guid: request.guid, specializationKey: request.specializationKey, ...detail },
    },
  };
}

function missingCook(request: MaterialLoadRequest): MaterialLoadError {
  return materialError(
    request,
    'material-specialization-not-cooked',
    'a cooked material specialization record and artifact',
    'run the build-time material cooker for this specialization before loading it at runtime',
    {},
    true,
  );
}

function recordError(
  request: MaterialLoadRequest,
  field: string,
  expected = 'a complete material-cook/4 publication record',
): MaterialLoadError {
  return materialError(
    request,
    'material-cook-record-invalid',
    expected,
    're-publish the material record and its artifact as one immutable publication',
    { field },
  );
}

function immutableBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

/** Native hashing is optional; the existing digest remains the correctness fallback. */
function nativeMaterialArtifactDigest():
  | ((bytes: Uint8Array<ArrayBuffer>) => Promise<string>)
  | undefined {
  try {
    const subtle = globalThis.crypto?.subtle;
    const digest = subtle?.digest;
    if (subtle === undefined || typeof digest !== 'function') return undefined;
    return async (bytes) => {
      try {
        // Keep the SubtleCrypto receiver and the exact private view, including its offset.
        const hash = await digest.call(subtle, 'SHA-256', bytes);
        return `sha256:${[...new Uint8Array(hash)]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('')}`;
      } catch {
        return createMaterialArtifactDigest(bytes);
      }
    };
  } catch {
    return undefined;
  }
}

/** Plain own data only; descriptor admission never invokes an adapter getter. */
function materialDataProperties(value: unknown): PropertyDescriptorMap | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const properties = Object.getOwnPropertyDescriptors(value);
  Object.setPrototypeOf(properties, null);
  return Reflect.ownKeys(properties).every(
    (key) =>
      typeof key === 'string' &&
      'value' in (properties[key] as PropertyDescriptor) &&
      (properties[key] as PropertyDescriptor).enumerable === true,
  )
    ? properties
    : undefined;
}

/** Metadata adapters keep their complete original synchronous behavior. */
function snapshotMaterialRecord(record: CookedMaterialRecord): CookedMaterialRecord | undefined {
  try {
    // The validator owns these views. They are excluded from structuredClone below.
    const programBytes = new Set(record.programs.map((program) => program.artifact.bytes));
    const complete = new WeakSet<object>();
    const active = new WeakSet<object>();
    const dataOnly = (value: unknown): boolean => {
      if (value === null || typeof value !== 'object') return typeof value !== 'function';
      if (programBytes.has(value as Uint8Array)) return true;
      const prototype = Object.getPrototypeOf(value);
      const array = Array.isArray(value);
      if (array ? prototype !== Array.prototype : prototype !== Object.prototype) {
        return false;
      }
      if (active.has(value)) return false;
      if (complete.has(value)) return true;
      const properties = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(properties);
      if (
        !keys.every((key) => {
          if (typeof key !== 'string') return false;
          const property = properties[key] as PropertyDescriptor;
          if (!('value' in property)) return false;
          return (
            property.enumerable === true ||
            (array &&
              key === 'length' &&
              property.enumerable === false &&
              property.configurable === false)
          );
        })
      )
        return false;
      const fields = keys.map((key) => properties[key as string] as PropertyDescriptor);
      active.add(value);
      const accepted = fields.every((property) => dataOnly(property.value));
      active.delete(value);
      if (accepted) complete.add(value);
      return accepted;
    };
    if (!dataOnly(record)) return undefined;
    const metadata = structuredClone({
      ...record,
      programs: record.programs.map((program) => ({
        ...program,
        artifact: { ...program.artifact, bytes: undefined },
      })),
    });
    return {
      ...metadata,
      programs: metadata.programs.map((program, index) => ({
        ...program,
        artifact: {
          ...program.artifact,
          bytes: (record.programs[index] as CookedMaterialRecord['programs'][number]).artifact
            .bytes,
        },
      })),
    };
  } catch {
    return undefined;
  }
}

/** Admit every artifact descriptor before metadata capture or body copies. */
function materialArtifactData(
  publication: MaterialPublication,
  record: CookedMaterialRecord,
): readonly { readonly bytes: Uint8Array; readonly digest: string | undefined }[] | undefined {
  try {
    const publicationFields = materialDataProperties(publication);
    if (publicationFields === undefined) return undefined;
    const artifactFields = materialDataProperties(publicationFields.artifacts?.value);
    if (artifactFields === undefined) return undefined;
    const captured: { bytes: Uint8Array; digest: string | undefined }[] = [];
    for (const program of record.programs) {
      const published = artifactFields[program.artifact.path]?.value;
      const fields = materialDataProperties(published);
      if (fields === undefined || fields.bytes === undefined) return undefined;
      const prototype = Object.getPrototypeOf(published);
      if (
        fields.digest === undefined &&
        prototype !== null &&
        Object.getOwnPropertyDescriptor(prototype, 'digest') !== undefined
      )
        return undefined;
      const bytes = fields.bytes.value;
      if (
        !(bytes instanceof Uint8Array) ||
        Object.getPrototypeOf(bytes) !== Uint8Array.prototype ||
        Object.getOwnPropertyDescriptor(bytes, 'buffer') !== undefined ||
        Object.getPrototypeOf(bytes.buffer) !== ArrayBuffer.prototype
      )
        return undefined;
      captured.push({ bytes, digest: fields.digest?.value });
    }
    return captured;
  } catch {
    return undefined;
  }
}

function copyMaterialArtifacts(
  artifacts: readonly { readonly bytes: Uint8Array; readonly digest: string | undefined }[],
):
  | readonly { readonly bytes: Uint8Array<ArrayBuffer>; readonly digest: string | undefined }[]
  | undefined {
  try {
    return artifacts.map(({ bytes, digest }) => ({ bytes: immutableBytes(bytes), digest }));
  } catch {
    // An ordered old-path body error must not preempt an earlier integrity failure.
    return undefined;
  }
}

function immutableParameterContract(
  parameterContract: NonNullable<CookedMaterialRecord['parameterContract']>,
): NonNullable<CookedMaterialRecord['parameterContract']> {
  return Object.freeze({
    parameters: Object.freeze([...parameterContract.parameters]),
    values: Object.freeze({ ...parameterContract.values }),
  });
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  const length = left.byteLength;
  if (length !== right.byteLength) return false;
  // Preserve TypedArray.every's detached/out-of-bounds validation without a byte callback.
  Uint8Array.prototype.values.call(left);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function completeTupleField(record: CookedMaterialRecord): string | undefined {
  if (
    typeof record.materialGuid !== 'string' ||
    !Number.isSafeInteger(record.publicationGeneration) ||
    (record.publicationGeneration as number) < 1
  )
    return 'publicationGeneration';
  if (typeof record.specializationKey !== 'string' || record.specializationKey.length === 0)
    return 'specializationKey';
  if (typeof record.artifactDigest !== 'string' || record.artifactDigest.length === 0)
    return 'artifactDigest';
  if (
    !Array.isArray(record.sourceClosure) ||
    record.sourceClosure.some((path) => typeof path !== 'string' || path.length === 0)
  )
    return 'sourceClosure';
  const parameterContract = record.parameterContract;
  if (
    parameterContract === undefined ||
    !Array.isArray(parameterContract.parameters) ||
    parameterContract.values === null ||
    typeof parameterContract.values !== 'object' ||
    Array.isArray(parameterContract.values)
  )
    return 'parameterContract';
  const receipt = record.receipt;
  if (
    !Array.isArray(receipt.sourceClosure) ||
    receipt.sourceClosure.some((path) => typeof path !== 'string' || path.length === 0) ||
    receipt.sourceClosure.length !== record.sourceClosure.length ||
    receipt.sourceClosure.some((path, index) => path !== record.sourceClosure?.[index])
  )
    return 'receipt.sourceClosure';
  if (
    typeof receipt.profile !== 'string' ||
    receipt.profile.length === 0 ||
    typeof receipt.compilerVersion !== 'string' ||
    receipt.compilerVersion.length === 0 ||
    typeof receipt.identity.cookIdentity !== 'string' ||
    receipt.identity.cookIdentity.length === 0 ||
    receipt.identity.artifactDigest !== record.artifactDigest ||
    receipt.identity.cookGeneration !== record.publicationGeneration
  )
    return 'receipt';
  if (
    typeof receipt.identity.layoutIdentity !== 'string' ||
    receipt.identity.layoutIdentity.length === 0 ||
    receipt.derivedInterface?.layoutIdentity !== receipt.identity.layoutIdentity
  )
    return 'receipt.identity.layoutIdentity';
  let expectedLayerPlanIdentity: string | undefined;
  try {
    expectedLayerPlanIdentity = materialLayerPlanIdentity(record);
  } catch {
    return 'resolved.layerPlanIdentity';
  }
  if (
    expectedLayerPlanIdentity !== undefined &&
    receipt.derivedInterface.layerPlanIdentity !== expectedLayerPlanIdentity
  )
    return 'receipt.derivedInterface.layerPlanIdentity';
  return undefined;
}

export function createMaterialLoader(options: MaterialLoaderOptions) {
  return {
    async load(request: MaterialLoadRequest): Promise<MaterialReady | MaterialLoadError> {
      const publication = await options.loadPublication(request.guid, request.specializationKey);
      if (publication === undefined) return missingCook(request);
      if (publication.artifactError !== undefined) {
        return materialError(
          request,
          publication.artifactError.code,
          publication.artifactError.expected,
          'restore the published material artifact and retry the load',
          {
            expected: publication.artifactError.expected,
            ...(publication.artifactError.actual === undefined
              ? {}
              : { actual: publication.artifactError.actual }),
          },
          true,
        );
      }
      const parsed = validateCookedMaterialRecord(publication.record);
      if (!parsed.ok) return recordError(request, parsed.error.detail.field);
      let record = parsed.value;
      const invalidTupleField = completeTupleField(record);
      if (invalidTupleField !== undefined) return recordError(request, invalidTupleField);
      const publicationGeneration = record.publicationGeneration;
      const sourceClosure = record.sourceClosure;
      const parameterContract = record.parameterContract;
      const materialGuid = record.materialGuid;
      const recordSpecializationKey = record.specializationKey;
      const artifactDigest = record.artifactDigest;
      if (publicationGeneration === undefined) return recordError(request, 'publicationGeneration');
      if (sourceClosure === undefined) return recordError(request, 'sourceClosure');
      if (parameterContract === undefined) return recordError(request, 'parameterContract');
      if (materialGuid === undefined) return recordError(request, 'materialGuid');
      if (recordSpecializationKey === undefined) return recordError(request, 'specializationKey');
      if (artifactDigest === undefined) return recordError(request, 'artifactDigest');
      if (
        publication.guid.toLowerCase() !== request.guid.toLowerCase() ||
        record.guid.toLowerCase() !== request.guid.toLowerCase()
      ) {
        return recordError(
          request,
          'guid',
          `record GUID ${request.guid} to match the requested GUID`,
        );
      }
      if (materialGuid.toLowerCase() !== request.guid.toLowerCase())
        return recordError(request, 'materialGuid');
      if (recordSpecializationKey !== request.specializationKey) return missingCook(request);
      let digest = nativeMaterialArtifactDigest();
      // Close native mode before snapshot/copy/await for unknown adapter semantics.
      let artifacts: ReturnType<typeof materialArtifactData>;
      try {
        artifacts =
          digest === undefined || materialDataProperties(request) === undefined
            ? undefined
            : materialArtifactData(publication, record);
      } catch {
        artifacts = undefined;
      }
      const snapshot = artifacts === undefined ? undefined : snapshotMaterialRecord(record);
      const capturedArtifacts =
        snapshot === undefined || artifacts === undefined
          ? undefined
          : copyMaterialArtifacts(artifacts);
      if (snapshot === undefined || capturedArtifacts === undefined) digest = undefined;
      else record = snapshot;
      const readySourceClosure =
        digest === undefined
          ? sourceClosure
          : (record.sourceClosure as NonNullable<CookedMaterialRecord['sourceClosure']>);
      const readyParameterContract =
        digest === undefined
          ? parameterContract
          : (record.parameterContract as NonNullable<CookedMaterialRecord['parameterContract']>);
      // New digest awaits use one already admitted publication and request snapshot.
      if (digest !== undefined) request = { ...request };
      const programs: CookedMaterialRecord['programs'][number][] = [];
      for (const [programIndex, program] of record.programs.entries()) {
        const artifact = program.artifact;
        const captured = digest === undefined ? undefined : capturedArtifacts?.[programIndex];
        const published = captured ?? publication.artifacts?.[artifact.path];
        if (published === undefined)
          return materialError(
            request,
            'asset-artifact-missing',
            `published artifact ${artifact.path}`,
            'publish every program artifact before loading the material',
            { publicationGeneration, field: artifact.path },
            true,
          );
        const bytes = captured?.bytes ?? immutableBytes(published.bytes);
        const actualDigest =
          digest === undefined ? createMaterialArtifactDigest(bytes) : await digest(bytes);
        if (
          actualDigest !== artifact.digest ||
          (published.digest !== undefined && published.digest !== actualDigest)
        ) {
          return materialError(
            request,
            'asset-artifact-integrity-mismatch',
            `artifact digest ${artifact.digest}`,
            'restore the complete published generation or re-cook the material',
            {
              publicationGeneration,
              field: artifact.path,
              expected: artifact.digest,
              actual: actualDigest,
            },
          );
        }
        if (!sameBytes(artifact.bytes, bytes))
          return recordError(
            request,
            `programs.${program.specializationKey}.artifact.bytes`,
            'record bytes to match the published program artifact',
          );
        programs.push(
          Object.freeze({
            ...program,
            selections: Object.freeze(
              program.selections.map((selection) =>
                Object.freeze({ ...selection, context: Object.freeze({ ...selection.context }) }),
              ),
            ),
            artifact: Object.freeze({ ...artifact, bytes }),
          }),
        );
      }
      const refs = [
        ...record.refs.parent,
        ...record.refs.textures,
        ...record.refs.samplers,
        ...record.refs.modules,
      ];
      const missing = options.loadReference
        ? (
            await Promise.all(
              refs.map(async (reference) =>
                (await options.loadReference?.(reference)) ? undefined : reference,
              ),
            )
          ).filter((reference): reference is string => reference !== undefined)
        : [];
      if (missing.length > 0) {
        return materialError(
          request,
          'material-reference-not-ready',
          'all cooked material references to be available',
          'load referenced parent, texture, sampler, and module assets before publishing Ready',
          { publicationGeneration, missing },
          true,
        );
      }
      return {
        status: 'Ready',
        record: {
          ...record,
          materialGuid,
          publicationGeneration,
          specializationKey: recordSpecializationKey,
          artifactDigest,
          sourceClosure: Object.freeze([...readySourceClosure]),
          parameterContract: immutableParameterContract(readyParameterContract),
          programs: Object.freeze(programs),
        },
      };
    },
  };
}

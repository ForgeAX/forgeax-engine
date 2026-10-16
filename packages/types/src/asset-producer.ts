// @forgeax/engine-types - producer-owned asset catalog contract.
//
// This is the shared POD boundary between an engine asset producer and any
// consumer. Consumers must use these facts instead of deriving origin from a
// DDC URL, filename suffix, or catalog position.

export type AssetSubjectType = 'asset' | 'package' | 'resource';

/** The producer-owned subject behind a catalog row. */
export type CatalogSubject = 'internal-asset' | 'imported-output';

/** Whether the runtime projection is validated directly or cooked. */
export type CookExecution = 'direct' | 'cooked';

/** Derived lifecycle states exposed by the catalog. */
export type CatalogLifecycle = 'missing' | 'cooking' | 'current' | 'stale' | 'failed';

/** Usage derived from producer refs and build-time content reads. */
export type AssetPublicationEvidenceUsage = 'reference' | 'content' | 'both';

/** One external dependency observed while publishing a source package. */
export interface AssetPublicationExternalEvidence {
  readonly guid: string;
  readonly usage: AssetPublicationEvidenceUsage;
  readonly generation?: number;
  readonly digest?: string;
}

/** One ordinary asset output in an atomic source-package publication. */
export interface AssetPublicationOutput {
  readonly guid: string;
  readonly sourceKey: string;
  readonly kind: string;
  readonly digest: string;
  /** GUIDs emitted by the owning ordinary producer, in stable order. */
  readonly refs: readonly string[];
}

/** Receipt facts that prove the complete output set and dependency closure. */
export interface AssetPublicationReceipt {
  readonly schemaVersion: 'asset-publication-receipt/1';
  readonly sourcePath: string;
  readonly sourceRevision: string;
  readonly inputFingerprint: string;
  readonly outputDigest: string;
  readonly outputSetDigest: string;
  readonly externalEvidence: readonly AssetPublicationExternalEvidence[];
}

/** Stable locator for current or last-known-good publication recovery. */
export interface AssetPublicationLocator {
  readonly generation: number;
  readonly digest: string;
  readonly outputSetDigest: string;
  readonly packageUrl: string;
  readonly receiptKey: string;
}

export type AssetPublicationFailureStage =
  | 'source'
  | 'output'
  | 'receipt'
  | 'route'
  | 'catalog'
  | 'cancelled';

/** Machine-readable failure and recovery facts; messages are not a protocol. */
export interface AssetPublicationFailure {
  readonly code: string;
  readonly stage: AssetPublicationFailureStage;
  readonly sourcePath: string;
  readonly sourceRevision?: string;
  readonly generation?: number;
  readonly outputGuid?: string;
  readonly reason: string;
}

/** Actions a consumer can execute after a candidate publication is rejected. */
export interface AssetPublicationRecovery {
  readonly retryable: boolean;
  readonly preserveCurrent: boolean;
  readonly useLastKnownGood: boolean;
  readonly actions: readonly string[];
}

/**
 * Engine-owned publication SSOT shared by pack, import, Catalog, and consumers.
 * A publication is valid only when receipt and every output belong to one
 * source revision, generation, digest, and output-set digest tuple.
 */
export interface AssetPublicationEnvelope {
  readonly schemaVersion: 'asset-publication/1';
  readonly sourcePath: string;
  readonly sourceRevision: string;
  readonly generation: number;
  readonly digest: string;
  readonly outputSetDigest: string;
  readonly outputs: readonly AssetPublicationOutput[];
  readonly receipt: AssetPublicationReceipt;
  readonly externalEvidence: readonly AssetPublicationExternalEvidence[];
  readonly failureStage?: AssetPublicationFailureStage;
  readonly failure?: AssetPublicationFailure;
  readonly current?: AssetPublicationLocator;
  readonly lastKnownGood?: AssetPublicationLocator;
  readonly recovery?: AssetPublicationRecovery;
}

/**
 * Immutable source-level identity carried by an authored generated Scene mount.
 * A mount is consumable only when every member resolves from this complete
 * publication tuple; no single output GUID or generation number is sufficient.
 */
export interface ScenePublicationFence {
  readonly schemaVersion: 'scene-publication-fence/1';
  readonly sourcePath: string;
  readonly sourceRevision: string;
  readonly publicationGeneration: number;
  readonly outputDigest: string;
  readonly outputSetDigest: string;
  readonly receiptIdentity: string;
}

export type CatalogOperationName =
  | 'preview'
  | 'save'
  | 'rebuild'
  | 'sourceOverride'
  | 'instanceOverride'
  | 'promote';

export interface CatalogOperationDescriptor {
  readonly operation: CatalogOperationName;
  readonly enabled: boolean;
  readonly reason?: string;
}

export type CatalogOperations = Readonly<Record<CatalogOperationName, CatalogOperationDescriptor>>;

export interface CatalogProjectionInput {
  readonly subject: CatalogSubject;
  readonly execution: CookExecution;
  readonly lifecycle: CatalogLifecycle;
}

/** The explicit three-axis projection consumed by AI-facing catalog clients. */
export interface CatalogProjection extends CatalogProjectionInput {
  readonly operations: CatalogOperations;
  readonly lastKnownGood?: {
    readonly packageUrl: string;
    readonly receiptUrl?: string;
  };
}

/**
 * Derive operation descriptors from catalog facts only.
 *
 * `kind`, paths, and diagnostic messages are intentionally absent from this
 * function: a consumer receives a complete operation matrix and can branch
 * on `enabled` without reimplementing producer policy.
 */
export function catalogOperationsFor(input: CatalogProjectionInput): CatalogOperations {
  const imported = input.subject === 'imported-output';
  const current = input.lifecycle === 'current';
  const ready = current && (input.execution === 'direct' || input.execution === 'cooked');
  const canRebuild = input.execution === 'cooked';
  const canPreview = input.execution === 'cooked' && input.lifecycle !== 'missing';
  const operation = (name: CatalogOperationName, enabled: boolean, reason?: string) => ({
    operation: name,
    enabled,
    ...(reason === undefined ? {} : { reason }),
  });

  return {
    preview: operation('preview', canPreview, canPreview ? undefined : 'no projection to preview'),
    save: operation(
      'save',
      !imported && input.execution === 'direct' && ready,
      imported ? 'imported output is read-only' : 'direct projection is not current',
    ),
    rebuild: operation(
      'rebuild',
      canRebuild,
      canRebuild ? undefined : 'direct assets do not require a cook',
    ),
    sourceOverride: operation(
      'sourceOverride',
      imported && canRebuild,
      imported
        ? canRebuild
          ? undefined
          : 'cooked projection is not available'
        : 'only imported output has a source override',
    ),
    instanceOverride: operation(
      'instanceOverride',
      imported && current,
      imported
        ? current
          ? undefined
          : 'projection is not current'
        : 'only imported output has an instance override',
    ),
    promote: operation(
      'promote',
      imported && current,
      imported
        ? current
          ? undefined
          : 'projection is not current'
        : 'internal assets are already authored',
    ),
  };
}

/** Reject impossible axis combinations before a catalog row is published. */
export function isCatalogProjectionValid(input: CatalogProjection): boolean {
  if (input.execution === 'direct' && input.lifecycle !== 'current') return false;
  if (input.subject === 'imported-output' && input.execution !== 'cooked') return false;
  return Object.entries(input.operations).every(
    ([name, descriptor]) => name === descriptor.operation,
  );
}

export interface AssetAuthoringUnavailableReason {
  readonly code: 'unsupported-asset-kind' | 'missing-producer-capability';
  readonly hint: string;
}

/** Engine-facing operation shape exposed by a producer-owned catalog row. */
export type AssetPlacementCapability =
  | { readonly operation: 'spawnEntity' }
  | { readonly operation: 'addSceneAssetToScene' }
  | { readonly operation: 'unavailable'; readonly reason: AssetAuthoringUnavailableReason };

export interface AssetBindingTarget {
  readonly component: string;
  readonly field: string;
  readonly assetType: string;
  readonly cardinality: 'single' | 'array';
}

/**
 * One projection exposed by the producer-owned UI authoring contract.
 *
 * `supported` describes a real engine seam; `unavailable` is deliberately
 * structured so an editor or AI client cannot silently invent a consumer-side
 * implementation for a missing producer capability.
 */
export type UiAuthoringProjection =
  | {
      readonly status: 'supported';
      readonly operation:
        | 'createUiPreviewSession'
        | 'mountUi'
        | 'gameProjection'
        | 'dom-native'
        | 'ui-artifact-companion'
        | 'i18next';
      readonly contractVersion: '1';
    }
  | {
      readonly status: 'unavailable';
      readonly reason: AssetAuthoringUnavailableReason;
    };

/**
 * Versioned UI authoring facts published beside every `kind: 'ui'` catalog
 * row. This is a protocol descriptor, not a promise that the editor may reach
 * into a game world: runtime state/action/read semantics remain owned by the
 * game projection registrar and the UI mount/preview seams remain owned by the
 * engine UI package.
 */
export interface UiAuthoringCapability {
  readonly contractVersion: '1';
  readonly profileVersion: '1';
  readonly preview: {
    readonly operation: 'createUiPreviewSession';
    readonly lifecycle: 'open-rebuild-retry-dispose';
  };
  readonly mount: {
    readonly operation: 'mountUi';
    readonly lifecycle: 'mount-dispose';
    readonly actionPort: 'onAction';
  };
  readonly state: UiAuthoringProjection;
  readonly actions: UiAuthoringProjection;
  readonly reads: UiAuthoringProjection;
  readonly input: UiAuthoringProjection;
  readonly navigation: UiAuthoringProjection;
  readonly font: UiAuthoringProjection;
  readonly localization: UiAuthoringProjection;
}

export type AssetBindingCapability =
  | {
      readonly operation: 'bindAssetRef' | 'createMaterialThenBindAssetRef';
      readonly target: AssetBindingTarget;
      readonly requiredSlots: 1;
    }
  | { readonly operation: 'unavailable'; readonly reason: AssetAuthoringUnavailableReason };

/** Producer-owned placement and binding facts for one catalog asset. */
export interface AssetAuthoringCapability {
  readonly placement: AssetPlacementCapability;
  readonly binding: AssetBindingCapability;
  /** Present for producer-owned UI assets; absent for unrelated kinds. */
  readonly ui?: UiAuthoringCapability;
  readonly sourceOverrides?: readonly SourceOverrideDescriptor[];
}

const UI_AUTHORING_CAPABILITY: UiAuthoringCapability = {
  contractVersion: '1',
  profileVersion: '1',
  preview: {
    operation: 'createUiPreviewSession',
    lifecycle: 'open-rebuild-retry-dispose',
  },
  mount: {
    operation: 'mountUi',
    lifecycle: 'mount-dispose',
    actionPort: 'onAction',
  },
  state: { status: 'supported', operation: 'gameProjection', contractVersion: '1' },
  actions: { status: 'supported', operation: 'gameProjection', contractVersion: '1' },
  reads: { status: 'supported', operation: 'gameProjection', contractVersion: '1' },
  input: { status: 'supported', operation: 'dom-native', contractVersion: '1' },
  navigation: { status: 'supported', operation: 'dom-native', contractVersion: '1' },
  font: { status: 'supported', operation: 'ui-artifact-companion', contractVersion: '1' },
  localization: { status: 'supported', operation: 'i18next', contractVersion: '1' },
};

/** Built-in defaults for legacy rows that do not carry an explicit override. */
export function authoringCapabilityForAssetKind(kind: string): AssetAuthoringCapability {
  switch (kind) {
    case 'ui':
      return {
        placement: {
          operation: 'unavailable',
          reason: {
            code: 'unsupported-asset-kind',
            hint: 'UI assets mount through the UI runtime and are not ECS scene placements.',
          },
        },
        binding: {
          operation: 'unavailable',
          reason: {
            code: 'unsupported-asset-kind',
            hint: 'UI assets bind through their producer-owned UI runtime contract.',
          },
        },
        ui: UI_AUTHORING_CAPABILITY,
      };
    case 'scene':
      return {
        placement: { operation: 'addSceneAssetToScene' },
        binding: {
          operation: 'unavailable',
          reason: {
            code: 'unsupported-asset-kind',
            hint: 'Scene assets are placed as a scene mount.',
          },
        },
      };
    case 'mesh':
      return {
        placement: { operation: 'spawnEntity' },
        binding: {
          operation: 'bindAssetRef',
          target: {
            component: 'MeshFilter',
            field: 'assetHandle',
            assetType: 'MeshAsset',
            cardinality: 'single',
          },
          requiredSlots: 1,
        },
      };
    case 'material':
      return {
        placement: { operation: 'spawnEntity' },
        binding: {
          operation: 'bindAssetRef',
          target: {
            component: 'MeshRenderer',
            field: 'materials',
            assetType: 'MaterialAsset',
            cardinality: 'array',
          },
          requiredSlots: 1,
        },
      };
    case 'texture':
      return {
        placement: { operation: 'spawnEntity' },
        binding: {
          operation: 'createMaterialThenBindAssetRef',
          target: {
            component: 'MeshRenderer',
            field: 'materials',
            assetType: 'MaterialAsset',
            cardinality: 'array',
          },
          requiredSlots: 1,
        },
      };
    case 'particle-effect':
      return {
        placement: { operation: 'spawnEntity' },
        binding: {
          operation: 'bindAssetRef',
          target: {
            component: 'ParticleEffectPlayer',
            field: 'effect',
            assetType: 'ParticleEffectAsset',
            cardinality: 'single',
          },
          requiredSlots: 1,
        },
      };
    default:
      return {
        placement: {
          operation: 'unavailable',
          reason: {
            code: 'unsupported-asset-kind',
            hint: `No placement capability is published for asset kind '${kind}'.`,
          },
        },
        binding: {
          operation: 'unavailable',
          reason: {
            code: 'unsupported-asset-kind',
            hint: `No binding capability is published for asset kind '${kind}'.`,
          },
        },
      };
  }
}

/** Stable producer subject identity used by relations and diagnostics. */
export interface AssetSubjectRef {
  readonly type: AssetSubjectType;
  readonly id: string;
}

/** Provider identity carried with producer-owned facts; not a catalog locator. */
export interface ProviderProvenance {
  readonly provider: string;
  readonly version: string;
  readonly source?: string;
}

/** Producer-owned JSON payload for one stable imported-output source key. */
export type SourceOverridePayload = Readonly<Record<string, unknown>>;

/** Optional Meta author facts keyed by the producer's stable sourceKey. */
export type SourceOverrideMap = Readonly<Record<string, SourceOverridePayload>>;

export interface SourceOverrideDescriptor {
  readonly sourceKey: string;
  /** Producer-owned semantic used by authoring hosts for catalog-aware validation. */
  readonly semantic?: 'mesh-material-slot-defaults';
  readonly payloadSchema?: unknown;
}

/** Shared payload contract explicitly published by Mesh-producing importers. */
export const MESH_MATERIAL_SLOT_SOURCE_OVERRIDE_PAYLOAD_SCHEMA = {
  type: 'object',
  properties: {
    materialSlots: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          slotName: { type: 'string', minLength: 1 },
          sourceKey: { type: 'string', minLength: 1 },
          defaultMaterialGuid: { type: 'string' },
        },
        required: ['slotName'],
        additionalProperties: true,
      },
    },
    materialSlotDefaultOverrides: {
      type: 'object',
      additionalProperties: { type: 'string', nullable: true },
    },
  },
  additionalProperties: true,
} as const;

export type SourceOverrideErrorCode =
  | 'unknown-source-key'
  | 'duplicate-source-key'
  | 'invalid-source-overrides'
  | 'invalid-source-override-payload';

export interface SourceOverrideDiagnostic {
  readonly code: SourceOverrideErrorCode;
  readonly expected: string;
  readonly actual?: string;
  readonly hint: string;
}

export type SourceOverrideValidationResult =
  | { readonly ok: true; readonly value: SourceOverrideMap | undefined }
  | { readonly ok: false; readonly error: SourceOverrideDiagnostic };

function sourceOverrideError(
  code: SourceOverrideErrorCode,
  expected: string,
  hint: string,
  actual?: string,
): SourceOverrideValidationResult {
  return {
    ok: false,
    error: { code, expected, hint, ...(actual === undefined ? {} : { actual }) },
  };
}

function isSourceOverridePayload(value: unknown): value is SourceOverridePayload {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Canonicalize legacy/empty override maps without changing producer payloads. */
export function canonicalizeSourceOverrides(value: unknown): SourceOverrideMap | undefined {
  if (value === undefined) return undefined;
  if (!isSourceOverridePayload(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length === 0) return undefined;
  return Object.fromEntries(keys.sort().map((key) => [key, value[key]])) as SourceOverrideMap;
}

function validateSourceOverrideEntry(
  sourceKey: string,
  payload: unknown,
  declared: ReadonlySet<string>,
  seen: Set<string>,
): SourceOverrideDiagnostic | undefined {
  if (seen.has(sourceKey)) {
    return {
      code: 'duplicate-source-key',
      expected: 'sourceKey values to be unique within sourceOverrides',
      hint: 'remove the duplicate source override',
      actual: sourceKey,
    };
  }
  seen.add(sourceKey);
  if (!declared.has(sourceKey)) {
    return {
      code: 'unknown-source-key',
      expected: 'sourceKey to be declared by the producer topology',
      hint: 'request a fresh Catalog topology before writing Meta',
      actual: sourceKey,
    };
  }
  if (!isSourceOverridePayload(payload)) {
    return {
      code: 'invalid-source-override-payload',
      expected: 'each source override payload to be a producer-owned object',
      hint: 'validate the payload with the producer schema',
      actual: sourceKey,
    };
  }
  return undefined;
}

function validateSourceOverrideEntries(
  entries: readonly (readonly [string, unknown])[],
  declared: ReadonlySet<string>,
): SourceOverrideValidationResult {
  const seen = new Set<string>();
  for (const [sourceKey, payload] of entries) {
    const error = validateSourceOverrideEntry(sourceKey, payload, declared, seen);
    if (error !== undefined) return { ok: false, error };
  }
  return { ok: true, value: canonicalizeSourceOverrides(Object.fromEntries(entries)) };
}

/** Validate source override identity while leaving payload interpretation to the producer. */
export function validateSourceOverrideMap(
  value: unknown,
  declaredSourceKeys: readonly string[],
): SourceOverrideValidationResult {
  const declared = new Set<string>();
  for (const sourceKey of declaredSourceKeys) {
    if (declared.has(sourceKey)) {
      return sourceOverrideError(
        'duplicate-source-key',
        'sourceKey values declared by a producer to be unique',
        'repair the producer topology before publishing Meta',
        sourceKey,
      );
    }
    declared.add(sourceKey);
  }
  if (value === undefined) return { ok: true, value: undefined };
  if (Array.isArray(value)) {
    const entries: (readonly [string, unknown])[] = [];
    for (const item of value) {
      if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string') {
        return sourceOverrideError(
          'invalid-source-overrides',
          'sourceOverrides to be an object keyed by sourceKey',
          'pass a producer-owned source override map',
        );
      }
      entries.push([item[0], item[1]]);
    }
    return validateSourceOverrideEntries(entries, declared);
  }
  if (!isSourceOverridePayload(value)) {
    return sourceOverrideError(
      'invalid-source-overrides',
      'sourceOverrides to be an object keyed by sourceKey',
      'pass a producer-owned source override map',
    );
  }
  return validateSourceOverrideEntries(Object.entries(value), declared);
}

/** Monotonic producer observation used to validate catalog continuity. */
export interface ResourceRevision {
  readonly digest: string;
  readonly observedAt: number;
  readonly rootId: string;
}

export type AssetRelationType =
  | 'references'
  | 'reads'
  | 'depends-on'
  | 'owns'
  | 'contains'
  | 'produces'
  | 'materialized-as'
  | (string & {});

export interface AssetRelationPolicy {
  readonly ownership?: 'owned' | 'shared';
  readonly lifecycle?: 'authored' | 'derived';
  readonly strength?: 'required' | 'optional';
}

/** Structured graph edge emitted by a producer; consumers must preserve its fields. */
export interface AssetRelation {
  readonly from: AssetSubjectRef;
  readonly to: AssetSubjectRef;
  readonly type: AssetRelationType;
  readonly policy?: AssetRelationPolicy;
  readonly provenance: ProviderProvenance;
}

export type CatalogDiagnosticSeverity = 'info' | 'warning' | 'blocking';

/** Bounded, JSON-safe producer failure evidence retained by the catalog transport. */
export type CatalogDiagnosticCause =
  | {
      readonly code?: string;
      readonly message?: string;
      readonly expected?: string;
      readonly actual?: string;
      readonly hint?: string;
      readonly path?: string;
      readonly detail?: Readonly<Record<string, string | readonly string[]>>;
      readonly cause?: CatalogDiagnosticCause;
    }
  | readonly CatalogDiagnosticCause[];

/** Machine-readable catalog problem; consumers branch on fields, never message text. */
export interface CatalogDiagnostic {
  readonly cause?: CatalogDiagnosticCause;
  readonly code: string;
  readonly severity: CatalogDiagnosticSeverity;
  readonly message?: string;
  readonly subject?: AssetSubjectRef;
  readonly expected?: string;
  readonly actual?: string;
  readonly hint?: string;
  readonly authority?: 'producer' | 'pack' | 'catalog';
  readonly evidence?: readonly AssetSubjectRef[];
  readonly recoveryIntents?: readonly string[];
}

/** Closed set of contract failures returned by producer validation. */
export type ProducerContractErrorCode =
  | SourceOverrideErrorCode
  | TopologyConflictReason
  | 'invalid-source-key'
  | 'invalid-source-index'
  | 'invalid-producer-fact';

/** Structured producer validation failure with its owning authority. */
export interface ProducerContractDiagnostic {
  readonly code: ProducerContractErrorCode;
  readonly subject: AssetSubjectRef;
  readonly expected: string;
  readonly actual?: string;
  readonly hint: string;
  readonly authority: 'producer' | 'pack';
}

/** Result boundary for producer validation; success and failure are discriminated by `ok`. */
export type ProducerContractResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProducerContractDiagnostic };

/** Canonical producer output declaration used for topology matching and recovery. */
export interface ImportedOutputDeclaration {
  readonly guid: string;
  readonly sourceKey?: string;
  readonly sourceIndex: number;
  readonly kind: string;
  readonly name?: string;
  /** New kinds that may reuse this output's prior GUID. */
  readonly compatiblePreviousKinds?: readonly string[];
}

export type ProposedOutput = ImportedOutputDeclaration;

export type ExistingOutput = ImportedOutputDeclaration;

export interface KindChange {
  readonly guid: string;
  readonly oldKind: string;
  readonly newKind: string;
  readonly sourceKey?: string;
  readonly action: 'remove-add' | 'preserve-guid';
}

export type TopologyConflictReason =
  | 'duplicate-source-key'
  | 'missing-source-key'
  | 'source-index-ambiguous';

export interface MatchConflict {
  readonly reason: TopologyConflictReason;
  readonly sourceKey?: string;
  readonly previous: readonly ExistingOutput[];
  readonly next: readonly ProposedOutput[];
}

export interface TopologyPreserved {
  readonly guid: string;
  readonly oldKey: string;
  readonly newKey: string;
}

export interface TopologyDiff {
  readonly preserved: readonly TopologyPreserved[];
  readonly added: readonly ProposedOutput[];
  readonly removed: readonly ExistingOutput[];
  readonly changedKind: readonly KindChange[];
  readonly ambiguous: readonly MatchConflict[];
}

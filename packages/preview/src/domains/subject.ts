import { type Plugin, registerTools } from '@forgeax/engine-plugin';
import type {
  JsonValue,
  ToolContribution,
  ToolDescriptor,
  ToolSchema,
} from '@forgeax/engine-tool-runtime';
import type { PreviewHostMechanisms } from '../host/preview-host.js';
import { previewHostCapability } from '../host/preview-host.js';
import type { PreviewSubjectKind } from '../kit/presentation.js';

/** Mechanisms sampled once by the existing preview Host session. */
export type ResourcePreviewInput = Pick<
  PreviewHostMechanisms,
  'assets' | 'renderer' | 'runId' | 'artifacts'
>;

export async function loadResourceSubject(
  guid: string,
  input: ResourcePreviewInput,
  kind: PreviewSubjectKind,
) {
  if (input.assets === undefined)
    return subjectFailure(
      'resource-preview-subject-invalid',
      'resource preview host to expose the existing AssetRegistry',
      { phase: 'asset-registry', runId: input.runId },
    );
  const loaded = await input.assets.loadByGuid<Record<string, unknown>>(guid);
  if (!loaded.ok)
    return assetLoadFailure(
      `AssetRegistry.loadByGuid to resolve the requested ${kind}`,
      input.runId,
      loaded.error,
    );
  return {
    ok: true as const,
    value: {
      guid,
      asset: loaded.value,
      ...(loaded.digest === undefined ? {} : { digest: loaded.digest }),
      ...(loaded.ownerFacts === undefined ? {} : { ownerFacts: loaded.ownerFacts }),
    },
  };
}

export interface ResourcePreviewArgs {
  readonly guid: string;
  /** Square screenshot edge in device pixels. Defaults to 512 and must be a power of two. */
  readonly size?: number;
}

export const RESOURCE_PREVIEW_DEFAULT_SIZE = 512;
export const RESOURCE_PREVIEW_MIN_SIZE = 64;
export const RESOURCE_PREVIEW_MAX_SIZE = 4096;

export function isResourcePreviewSize(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= RESOURCE_PREVIEW_MIN_SIZE &&
    value <= RESOURCE_PREVIEW_MAX_SIZE &&
    (value & (value - 1)) === 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Keep the public result contract concrete at the ToolRuntime boundary. */
function isResourcePreviewResult(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const subject = value.subject;
  if (
    !isRecord(subject) ||
    !isString(subject.kind) ||
    !isString(subject.guid) ||
    !isString(subject.digest)
  )
    return false;
  if (!isRecord(value.presentation) || !isString(value.presentation.kind)) return false;
  if (
    !isRecord(value.recipe) ||
    !isString(value.recipe.schemaVersion) ||
    !isString(value.recipe.recipeDigest)
  )
    return false;
  if (!isRecord(value.oracle) || !isString(value.oracle.status)) return false;
  return Array.isArray(value.artifacts);
}

export const resourcePreviewResultSchema: ToolSchema<unknown> = {
  parse(value) {
    return isResourcePreviewResult(value)
      ? { ok: true, value }
      : {
          ok: false,
          error:
            'resource preview result must include subject, presentation, recipe, oracle, and artifacts',
        };
  },
  describe: '{"type":"object","required":["subject","presentation","recipe","oracle","artifacts"]}',
};

export const resourcePreviewArgsSchema: ToolSchema<ResourcePreviewArgs> = {
  parse(value) {
    if (
      value === null ||
      typeof value !== 'object' ||
      typeof Reflect.get(value, 'guid') !== 'string'
    ) {
      return { ok: false, error: 'expected { guid: string }' };
    }
    const guid = Reflect.get(value, 'guid');
    if (guid.length === 0) return { ok: false, error: 'guid must not be empty' };
    const size = Reflect.get(value, 'size');
    if (size === undefined) return { ok: true, value: { guid } };
    return isResourcePreviewSize(size)
      ? { ok: true, value: { guid, size } }
      : {
          ok: false,
          error: `size must be a power of two between ${RESOURCE_PREVIEW_MIN_SIZE} and ${RESOURCE_PREVIEW_MAX_SIZE}`,
        };
  },
  describe: `{"type":"object","required":["guid"],"properties":{"guid":{"type":"string"},"size":{"type":"integer","minimum":${RESOURCE_PREVIEW_MIN_SIZE},"maximum":${RESOURCE_PREVIEW_MAX_SIZE},"description":"square power-of-two screenshot edge; defaults to ${RESOURCE_PREVIEW_DEFAULT_SIZE}"}}}`,
};

export function subjectDescriptor(
  kind: PreviewSubjectKind,
): ToolDescriptor<ResourcePreviewArgs, unknown> {
  return {
    id: `asset.${kind}.preview`,
    title: `Preview ${kind}`,
    summary: `Preview one ${kind} asset in the Engine-owned resource host.`,
    realm: 'host',
    argsSchema: resourcePreviewArgsSchema,
    resultSchema: resourcePreviewResultSchema,
    evidence: ['rhi-tape', 'profile-capture', 'png'],
  };
}

export interface ResourceSubjectFailure {
  readonly ok: false;
  readonly error: {
    readonly code:
      | 'resource-preview-subject-invalid'
      | 'resource-preview-kind-mismatch'
      | 'resource-preview-oracle-failed';
    readonly expected: string;
    readonly hint: string;
    readonly detail: Readonly<Record<string, JsonValue>>;
  };
}

export function subjectFailure(
  code: ResourceSubjectFailure['error']['code'],
  expected: string,
  detail: Readonly<Record<string, JsonValue>>,
): ResourceSubjectFailure {
  return {
    ok: false,
    error: {
      code,
      expected,
      hint: 'Load the requested GUID through AssetRegistry.loadByGuid and repair the owner facts before retrying.',
      detail,
    },
  };
}

export function assetLoadFailure(
  expected: string,
  runId: string,
  error: unknown,
): ResourceSubjectFailure {
  const owner = isRecord(error) ? error : undefined;
  const ownerCode = typeof owner?.code === 'string' ? owner.code : undefined;
  const ownerExpected = typeof owner?.expected === 'string' ? owner.expected : undefined;
  const ownerHint = typeof owner?.hint === 'string' ? owner.hint : undefined;
  const ownerDetail = owner?.detail;
  return subjectFailure('resource-preview-subject-invalid', expected, {
    phase: 'asset-load',
    runId,
    ...(ownerCode === undefined ? {} : { ownerCode }),
    ...(ownerExpected === undefined ? {} : { ownerExpected }),
    ...(ownerHint === undefined ? {} : { ownerHint }),
    ...(ownerDetail === undefined ? {} : { ownerDetail: toJsonValue(ownerDetail) }),
  });
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry) => toJsonValue(entry));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toJsonValue(entry)]),
    );
  }
  return String(value);
}

// Keep emitted preview declarations tied to the declared Engine plugin owner.
// Inferred Cordis types can resolve a different ancestor dependency in consumers.
export interface NativePreviewPlugin extends Plugin.Object {
  name: string;
  inject: string[];
}

export function nativePreviewPlugin(
  kind: PreviewSubjectKind,
  contribution: ToolContribution<ResourcePreviewArgs, unknown>,
): NativePreviewPlugin {
  return {
    name: `forgeax-preview-${kind}`,
    inject: ['toolApi', previewHostCapability.id],
    apply(ctx) {
      ctx.effect(() =>
        registerTools(ctx, [contribution as ToolContribution<unknown, unknown>], { realm: 'host' }),
      );
    },
  };
}

import { type Plugin, registerTools } from '@forgeax/engine-plugin';
import type {
  JsonValue,
  ToolContribution,
  ToolDescriptor,
  ToolSchema,
} from '@forgeax/engine-tool-runtime';
import type { ResourcePreviewFailure } from '../evidence/errors.js';
import type { PreviewHostMechanisms } from '../host/preview-host.js';
import { previewHostCapability } from '../host/preview-host.js';
import { REQUIRED_PREVIEW_EVIDENCE } from '../host.js';
import type { PreviewSubjectKind } from '../kit/presentation.js';
import { isNonemptyString, isRecord } from '../request-schema.js';

/** Mechanisms sampled once by the existing preview Host session. */
export type ResourcePreviewInput = Pick<
  PreviewHostMechanisms,
  'subject' | 'renderer' | 'runId' | 'artifacts'
>;

export interface ResourceSubject
  extends Pick<NonNullable<PreviewHostMechanisms['subject']>, 'digest' | 'ownerFacts'> {
  readonly guid: string;
  readonly asset: unknown;
}

export function readResourceSubject(
  guid: string,
  input: ResourcePreviewInput,
  kind: PreviewSubjectKind,
) {
  const subject = input.subject;
  if (subject === undefined || subject.guid !== guid)
    return subjectFailure(
      'resource-preview-subject-invalid',
      `the Host to supply the requested ${kind} source facts`,
      {
        phase: 'subject',
        runId: input.runId,
        requestedGuid: guid,
        suppliedGuid: subject?.guid ?? null,
      },
    );
  return { ok: true as const, value: subject };
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

/** Keep the public result contract concrete at the ToolRuntime boundary. */
function isResourcePreviewResult(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const subject = value.subject;
  if (
    !isRecord(subject) ||
    !isNonemptyString(subject.kind) ||
    !isNonemptyString(subject.guid) ||
    !isNonemptyString(subject.digest)
  )
    return false;
  if (!isRecord(value.presentation) || !isNonemptyString(value.presentation.kind)) return false;
  if (
    !isRecord(value.recipe) ||
    !isNonemptyString(value.recipe.schemaVersion) ||
    !isNonemptyString(value.recipe.recipeDigest)
  )
    return false;
  if (!isRecord(value.oracle) || !isNonemptyString(value.oracle.status)) return false;
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
    if (!isRecord(value) || typeof value.guid !== 'string') {
      return { ok: false, error: 'expected { guid: string }' };
    }
    const guid = value.guid;
    if (guid.length === 0) return { ok: false, error: 'guid must not be empty' };
    const size = value.size;
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
    evidence: REQUIRED_PREVIEW_EVIDENCE,
  };
}

export interface ResourceSubjectFailure {
  readonly ok: false;
  readonly error: ResourcePreviewFailure;
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
      hint: 'Read the requested source through the Catalog owner and repair its facts before retrying.',
      detail,
    },
  };
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

import type {
  ArtifactRef,
  JsonValue,
  SnapshotRef,
  ToolCleanupCensus,
  ToolCleanupReport,
  ToolDomainFailure,
  ToolEvidenceKind,
  ToolExecutionContext,
  ToolSubjectRef,
} from '@forgeax/engine-tool-runtime';
import { toolCleanupFailure } from '@forgeax/engine-tool-runtime';
export interface PreviewHostRequest {
  readonly subject: ToolSubjectRef;
  readonly snapshot: SnapshotRef;
}

export interface PreviewAssetBinding {
  readonly guid: string;
  readonly bytes: number;
}

export interface PreviewFrameInput {
  readonly frame: number;
  readonly deltaSeconds: number;
}

export interface PreviewCapture {
  readonly digest: string;
  readonly bytes: number;
}

/**
 * The only resource surface exposed to a preview contribution. The adapter owns
 * the actual Engine resources; callers receive POD bindings and bounded actions.
 */
export interface PreviewHostSession {
  readonly subject: ToolSubjectRef;
  readonly snapshot: SnapshotRef;
  readonly loadAsset: (guid: string) => Promise<PreviewAssetBinding>;
  readonly frame: (input: PreviewFrameInput) => Promise<void>;
  readonly capture: () => Promise<PreviewCapture & { readonly artifact?: ArtifactRef }>;
  readonly census: () => ToolCleanupCensus;
  readonly dispose: () => Promise<void>;
}

export interface PreviewHostAdapter {
  readonly open: (request: PreviewHostRequest) => PreviewHostSession | Promise<PreviewHostSession>;
}

export interface PreviewDomainValue<TReport = unknown> {
  readonly subject: ToolSubjectRef;
  readonly snapshot: SnapshotRef;
  readonly report: TReport;
  readonly artifacts: readonly ArtifactRef[];
}

export type PreviewDomainResult<TReport = unknown> =
  | { readonly ok: true; readonly value: PreviewDomainValue<TReport> }
  | { readonly ok: false; readonly error: ToolDomainFailure };

export type PreviewDomainRunner<TRequest, TReport = unknown> = (
  request: TRequest,
  context: ToolExecutionContext,
) => Promise<PreviewDomainResult<TReport>>;

export const REQUIRED_PREVIEW_EVIDENCE: readonly ToolEvidenceKind[] = [
  'rhi-tape',
  'png',
  'profile-capture',
];

export function domainFailure(
  code: string,
  expected: string,
  hint: string,
  detail: Record<string, JsonValue>,
): { readonly ok: false; readonly error: ToolDomainFailure } {
  return { ok: false, error: { code, expected, hint, detail } };
}

/**
 * The default contribution is deliberately fail-closed. A real Project GUID
 * loader must install a PreviewHost/Browser/Dawn runner; a data-only request
 * must never manufacture PNG, RHI, or profile references from its arguments.
 */
export function previewRuntimeUnavailable(
  subject: ToolSubjectRef,
  snapshot: SnapshotRef,
  domain: string,
): { readonly ok: false; readonly error: ToolDomainFailure } {
  return domainFailure(
    'preview-runtime-unavailable',
    'a Project GUID cold-load and an active PreviewHost/Browser/Dawn runner',
    'Install the Project preview provider and retry; no synthetic artifact is published.',
    {
      domain,
      subjectKind: subject.kind,
      subjectGuid: subject.guid,
      snapshotRevision: snapshot.revision,
      snapshotDigest: snapshot.digest,
      requiredEvidence: REQUIRED_PREVIEW_EVIDENCE as unknown as JsonValue,
    },
  );
}

export function validateDomainValue<TReport>(
  value: PreviewDomainValue<TReport>,
  request: PreviewHostRequest,
): PreviewDomainResult<TReport> {
  if (
    value.subject.kind !== request.subject.kind ||
    value.subject.guid !== request.subject.guid ||
    value.snapshot.revision !== request.snapshot.revision ||
    value.snapshot.digest !== request.snapshot.digest
  ) {
    return domainFailure(
      'preview-subject-identity-mismatch',
      'the terminal subject and snapshot to match the request',
      'Repair the domain producer so evidence remains bound to the requested subject.',
      {
        requestGuid: request.subject.guid,
        resultGuid: value.subject.guid,
        requestSnapshot: request.snapshot.digest,
        resultSnapshot: value.snapshot.digest,
      },
    );
  }
  const kinds = new Set(value.artifacts.map((artifact) => artifact.kind));
  const missing = REQUIRED_PREVIEW_EVIDENCE.filter((kind) => !kinds.has(kind));
  if (missing.length > 0) {
    return domainFailure(
      'preview-evidence-incomplete',
      'one subject-bound artifact for each required evidence kind',
      'Repair the RHI, PNG, and profile producers before retrying.',
      { missing: missing as unknown as JsonValue },
    );
  }
  return { ok: true, value };
}

export class PreviewCleanupError extends Error {
  readonly code = 'preview-cleanup-live-resources';
  readonly census: ToolCleanupCensus;

  constructor(census: ToolCleanupCensus, failures: readonly string[] = []) {
    super(
      failures.length === 0
        ? 'preview session left live resources after disposal'
        : `preview session cleanup failed: ${failures.join('; ')}`,
    );
    this.name = 'PreviewCleanupError';
    this.census = census;
  }
}

/** Open, use and dispose one adapter-owned resource lease. */
export async function withPreviewSession<TResult>(
  adapter: PreviewHostAdapter,
  request: PreviewHostRequest,
  run: (session: PreviewHostSession) => TResult | Promise<TResult>,
): Promise<{ readonly value: TResult; readonly cleanup: ToolCleanupReport }> {
  const session = await adapter.open(request);
  let result: TResult;
  try {
    result = await run(session);
  } finally {
    await session.dispose();
  }
  const cleanup: ToolCleanupReport = { census: session.census(), failures: [] };
  if (toolCleanupFailure(cleanup) !== undefined) {
    throw new PreviewCleanupError(cleanup.census, cleanup.failures);
  }
  return { value: result, cleanup };
}

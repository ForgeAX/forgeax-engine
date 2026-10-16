import type { WorkspaceState } from './contract.ts';
import type { ViewWorkspaceClient, WorkspaceOptions } from './client.ts';
import type { ProjectSessionWindow } from './project-session.ts';
import { workspaceDiagnosticRecord } from './command-error.ts';
import { VIEW_WORKSPACE_TAB_ID, isOpaqueWorkspaceDiagnostic, workspaceError } from './contract.ts';
import { navigateProjectSession } from './project-session.ts';

export const VIEW_WORKSPACE_PAGE_LOST_CODE = 'view-workspace-page-lost';

export const VIEW_WORKSPACE_TARGET_RECOVERY_CODES = Object.freeze([
  VIEW_WORKSPACE_PAGE_LOST_CODE,
  'view-workspace-session-closed',
  'view-workspace-target-mismatch',
  'view-workspace-bootstrap-failed',
]);

const WORKSPACE_FAILURE_CODE_PATTERN =
  /(?:view|engine)-workspace-(?:page-lost|session-closed|target-mismatch|bootstrap-failed)/;

function normalizeWorkspaceFailureCode(candidate: unknown) {
  if (typeof candidate !== 'string' || candidate.length === 0) return undefined;
  const match = candidate.match(/(?:view|engine)-workspace-[a-z0-9-]+/);
  if (!match) return undefined;
  return match[0].replace('engine-workspace-', 'view-workspace-');
}

function collectFailureStrings(value: unknown, strings: string[] = [], depth = 0) {
  if (depth > 4 || value === undefined || value === null) return strings;
  if (typeof value === 'string') {
    strings.push(value);
    return strings;
  }
  if (typeof value !== 'object') return strings;
  if (Array.isArray(value)) {
    for (const entry of value) collectFailureStrings(entry, strings, depth + 1);
    return strings;
  }
  const record = workspaceDiagnosticRecord(value);
  for (const key of ['code', 'expected', 'hint', 'message', 'remoteCode']) {
    collectFailureStrings(record[key], strings, depth + 1);
  }
  collectFailureStrings(record.detail, strings, depth + 1);
  collectFailureStrings(record.payload, strings, depth + 1);
  collectFailureStrings(record.failure, strings, depth + 1);
  return strings;
}

/**
 * Map a Tool terminal failure to a View workspace code. Engine workspace errors
 * thrown inside executors are often wrapped as tool-domain-failed /
 * executor-threw, so we scan nested detail and message text for the real code.
 */
export function resolveWorkspaceFailureCode(value: unknown) {
  if (!value || typeof value !== 'object') return 'view-workspace-provider-failed';
  const failure = workspaceDiagnosticRecord(value);
  const detail = workspaceDiagnosticRecord(failure.detail);
  if (failure.code === 'tool-invalid-args') return 'view-workspace-invalid-args';
  // Native View domain codes survive Workspace forwarding unchanged.
  if (failure.code === 'tool-domain-failed' && typeof detail.code === 'string'
    && detail.code.startsWith('view-')) {
    return detail.code;
  }

  const candidates = collectFailureStrings(failure);
  for (const candidate of candidates) {
    const normalized = normalizeWorkspaceFailureCode(candidate);
    if (normalized !== undefined) return normalized;
  }
  for (const candidate of candidates) {
    if (WORKSPACE_FAILURE_CODE_PATTERN.test(candidate)) {
      const match = candidate.match(WORKSPACE_FAILURE_CODE_PATTERN);
      if (match) return match[0].replace('engine-workspace-', 'view-workspace-');
    }
  }
  if (typeof detail.code === 'string' && detail.code.startsWith('pack-')) {
    return detail.code;
  }
  return 'view-workspace-provider-failed';
}

function diagnosticCandidate(value: unknown) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function pickWorkspaceDiagnostic(candidates: readonly unknown[], { allowOpaque = true } = {}) {
  const texts = candidates.map(diagnosticCandidate).filter((value) => value !== undefined);
  const real = texts.filter((value) => !isOpaqueWorkspaceDiagnostic(value));
  if (real.length > 0) return real[0];
  return allowOpaque ? texts[0] : undefined;
}

/**
 * Unwrap a Tool terminal failure into the View workspace error fields. Nested
 * executor-threw / browser-failure envelopes keep the original diagnostic in
 * hint, message, or payload; wrapper expected strings are not used when a real
 * diagnostic is present. The original failure is always kept on detail.
 */
export function resolveWorkspaceFailure(value: unknown) {
  const failure = workspaceDiagnosticRecord(value);
  const failureDetail = workspaceDiagnosticRecord(failure.detail);
  const code = resolveWorkspaceFailureCode(value);
  if (!value || typeof value !== 'object') {
    return {
      code,
      expected: undefined,
      hint: value === undefined || value === null ? undefined : String(value),
      detail: { failure: value },
    };
  }
  const payload = failureDetail.payload;
  const nested = payload !== null && typeof payload === 'object' ? workspaceDiagnosticRecord(payload) : undefined;
  const nestedDetail =
    nested?.detail !== null && typeof nested?.detail === 'object' ? workspaceDiagnosticRecord(nested.detail) : undefined;
  const expected = pickWorkspaceDiagnostic([
    nested?.expected,
    nestedDetail?.expected,
    failureDetail.expected,
    failure.expected,
  ], { allowOpaque: false });
  const hint = pickWorkspaceDiagnostic([
    nested?.hint,
    nested?.message,
    nestedDetail?.hint,
    nestedDetail?.message,
    failure.hint,
    failureDetail.hint,
    failure.message,
    expected,
  ]);
  return {
    code,
    expected,
    hint,
    detail: {
      failure,
      ...(nested === undefined ? {} : { cause: nested }),
    },
  };
}

export function isWorkspaceTargetRecoveryCode(code: unknown) {
  return typeof code === 'string' && VIEW_WORKSPACE_TARGET_RECOVERY_CODES.includes(code);
}

export function isWorkspacePageLostError(value: unknown) {
  const error = workspaceDiagnosticRecord(value);
  const detail = workspaceDiagnosticRecord(error.detail);
  if (!error || typeof error !== 'object') return false;
  if (isWorkspaceTargetRecoveryCode(error.code)) return true;
  if (isWorkspaceTargetRecoveryCode(detail.remoteCode)) return true;
  return false;
}

export function shouldOfferWorkspaceRecovery(value: unknown) {
  const error = workspaceDiagnosticRecord(value);
  const detail = workspaceDiagnosticRecord(error.detail);
  if (!error || typeof error !== 'object') return false;
  if (isWorkspaceTargetRecoveryCode(error.code)) return true;
  if (detail.remoteCode && isWorkspaceTargetRecoveryCode(detail.remoteCode)) return true;
  if (error.code === 'view-workspace-provider-failed') {
    const text = collectFailureStrings(error).join(' ');
    return WORKSPACE_FAILURE_CODE_PATTERN.test(text)
      || /browser page to remain connected/i.test(text);
  }
  return false;
}

export function resolveWorkspaceReopenRoot(snapshot: WorkspaceState | null | undefined, explicitRoot?: unknown) {
  const candidate =
    typeof explicitRoot === 'string' && explicitRoot.trim() !== ''
      ? explicitRoot.trim()
      : typeof snapshot?.project?.root === 'string'
        ? snapshot.project.root.trim()
        : '';
  if (!candidate) {
    throw workspaceError(
      'view-workspace-reopen-unavailable',
      'a known project root to reopen',
      'Open the project from the View owner process before reconnecting.',
      {},
    );
  }
  return candidate;
}

export function workspaceProjectTargetUrl(snapshot: WorkspaceState | null | undefined) {
  const url = snapshot?.projectTarget?.url;
  return typeof url === 'string' && url.trim() !== '' ? url : undefined;
}

const WORKSPACE_SESSION_PARAM = 'forgeaxWorkspaceSession';

function workspaceSessionFromHref(href: unknown) {
  if (typeof href !== 'string' || href.trim() === '') return undefined;
  try {
    const session = new URL(href).searchParams.get(WORKSPACE_SESSION_PARAM);
    return session && session.trim() !== '' ? session : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The empty shell has no headed session. A document that already carries the
 * target's forgeaxWorkspaceSession is the project page; assigning again
 * reloads it and Engine treats that navigation as a lost workspace. Compare
 * the session parameter, not the full href: encoding or parameter order may
 * differ from the snapshot URL for the same document.
 */
export function shouldAdoptRemoteWorkspaceProject(snapshot: WorkspaceState | null | undefined, locationLike: string | { href?: string } | undefined) {
  if (!snapshot || snapshot.workspaceTargetLost === true) return false;
  if (typeof snapshot.project?.root !== 'string' || snapshot.project.root.trim() === '') return false;
  const url = workspaceProjectTargetUrl(snapshot);
  if (!url) return false;
  const href = typeof locationLike === 'string' ? locationLike : locationLike?.href;
  const currentSession = workspaceSessionFromHref(href);
  if (currentSession !== undefined && currentSession === workspaceSessionFromHref(url)) return false;
  return true;
}

/** Navigate only into the target's headed document. That document itself and lost targets stay put. */
export function adoptRemoteWorkspaceProject(snapshot: WorkspaceState, windowLike: ProjectSessionWindow = globalThis) {
  if (!shouldAdoptRemoteWorkspaceProject(snapshot, windowLike?.location)) return snapshot;
  return navigateToWorkspaceProjectTarget(snapshot, windowLike);
}

/**
 * After project.reopen, adopt the new headed target URL when it differs from the
 * current document. No-op when navigation is unavailable (Node callers).
 */
export function navigateToWorkspaceProjectTarget(snapshot: WorkspaceState, windowLike: ProjectSessionWindow = globalThis) {
  const url = workspaceProjectTargetUrl(snapshot);
  if (!url) {
    throw workspaceError(
      'view-workspace-reopen-incomplete',
      'the reopened project to publish a headed target URL',
      'Retry reconnecting or restart the View owner process.',
      {},
    );
  }
  const location = windowLike?.location;
  if (!location || typeof location.assign !== 'function') return snapshot;
  const nextHref = new URL(url, location.href).href;
  if (nextHref !== location.href) navigateProjectSession(snapshot, windowLike);
  return snapshot;
}

/** @param {unknown} client
 * @param {{ root?: string, tabId?: string, window?: unknown }} options
 */
export async function reopenWorkspaceProject(client: Pick<ViewWorkspaceClient, 'reopenProject'> | undefined, {
  root,
  tabId = VIEW_WORKSPACE_TAB_ID,
  window: windowLike,
  ...options
}: WorkspaceOptions & { window?: ProjectSessionWindow } = {}) {
  if (!client || typeof client.reopenProject !== 'function') {
    throw new TypeError('Workspace recovery requires a View workspace client');
  }
  const snapshot = await client.reopenProject({ ...options, root, tabId });
  return navigateToWorkspaceProjectTarget(snapshot, windowLike ?? globalThis);
}

import type {
  EngineWorkspaceProjectFailure,
  EngineWorkspaceProjectLifecycle,
  EngineWorkspaceProjectStatus,
  EngineWorkspaceProjectTargetIdentity,
  EngineWorkspaceTarget,
} from './workspace';

/** Engine-owned wire projection of the current project lifecycle. */
export function snapshotEngineWorkspaceProjectStatus(
  lifecycle: EngineWorkspaceProjectLifecycle | undefined,
): EngineWorkspaceProjectStatus | undefined {
  if (lifecycle === undefined) return undefined;
  const preparation =
    lifecycle.preparation === undefined
      ? {}
      : {
          preparation: {
            generation: lifecycle.preparation.generation,
            stage: lifecycle.preparation.stage,
            ...(lifecycle.preparation.operation === undefined
              ? {}
              : { operation: lifecycle.preparation.operation }),
            startedAt: lifecycle.preparation.startedAt,
            updatedAt: lifecycle.preparation.updatedAt,
            activeCount: lifecycle.preparation.activeCount,
            active: lifecycle.preparation.active.map(({ source, phase, startedAt, progress }) => ({
              source,
              phase,
              startedAt,
              ...(progress === undefined ? {} : { progress: { ...progress } }),
            })),
            recent: lifecycle.preparation.recent.map(({ source, cacheHit }) => ({
              source,
              cacheHit,
            })),
          },
        };
  const targetIdentity = (value: EngineWorkspaceTarget): EngineWorkspaceProjectTargetIdentity => {
    const { surface: _surface, ...identity } = value;
    return identity;
  };
  switch (lifecycle.phase) {
    case 'preparing':
      return {
        phase: 'preparing',
        ...preparation,
        sessionId: lifecycle.sessionId,
        generation: lifecycle.generation,
      };
    case 'starting':
      return {
        phase: 'starting',
        ...preparation,
        sessionId: lifecycle.sessionId,
        generation: lifecycle.generation,
        document: { ...lifecycle.document },
        ...(lifecycle.target === undefined ? {} : { target: targetIdentity(lifecycle.target) }),
        browserGeneration: lifecycle.browserGeneration,
      };
    case 'running':
      return {
        phase: 'running',
        ...preparation,
        sessionId: lifecycle.sessionId,
        generation: lifecycle.generation,
        document: { ...lifecycle.document },
        target: targetIdentity(lifecycle.target),
        browserGeneration: lifecycle.browserGeneration,
      };
    case 'failed':
      return {
        phase: 'failed',
        ...preparation,
        sessionId: lifecycle.sessionId,
        generation: lifecycle.generation,
        ...(lifecycle.document === undefined ? {} : { document: { ...lifecycle.document } }),
        ...(lifecycle.target === undefined ? {} : { target: targetIdentity(lifecycle.target) }),
        failure: workspaceFailureSnapshot(lifecycle.failure),
        ...(lifecycle.browserGeneration === undefined
          ? {}
          : { browserGeneration: lifecycle.browserGeneration }),
      };
    default: {
      const exhaustive: never = lifecycle;
      return exhaustive;
    }
  }
}

function workspaceFailureSnapshot(value: unknown): EngineWorkspaceProjectFailure {
  if (value instanceof Error) {
    const details = value as Error & {
      code?: unknown;
      expected?: unknown;
      hint?: unknown;
      detail?: unknown;
    };
    return {
      code: typeof details.code === 'string' ? details.code : 'engine-workspace-project-failed',
      expected: typeof details.expected === 'string' ? details.expected : value.message,
      hint: typeof details.hint === 'string' ? details.hint : value.message,
      ...workspaceFailureDetail(details.detail),
    };
  }
  if (value && typeof value === 'object') {
    const details = value as Record<string, unknown>;
    return {
      code: typeof details.code === 'string' ? details.code : 'engine-workspace-project-failed',
      expected:
        typeof details.expected === 'string' ? details.expected : 'Project startup to succeed',
      hint: typeof details.hint === 'string' ? details.hint : String(value),
      ...workspaceFailureDetail(details.detail),
    };
  }
  return {
    code: 'engine-workspace-project-failed',
    expected: 'Project startup to succeed',
    hint: String(value),
  };
}

function workspaceFailureDetail(
  value: unknown,
): Pick<EngineWorkspaceProjectFailure, 'detail' | 'detailOmitted'> | Record<string, never> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {
      detailOmitted: {
        reason: 'not-a-record',
        summary: 'The original failure detail remains available from its owning project session.',
      },
    };
  }
  const detail = value as Record<string, unknown>;
  const seen = new Set<object>();
  const jsonCompatible = (current: unknown): boolean => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean')
      return true;
    if (typeof current === 'number') return Number.isFinite(current);
    if (typeof current !== 'object' || seen.has(current)) return false;
    const prototype = Object.getPrototypeOf(current);
    if (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null)
      return false;
    seen.add(current);
    return Array.isArray(current)
      ? current.every(jsonCompatible)
      : Object.values(current).every(jsonCompatible);
  };
  if (!jsonCompatible(detail)) {
    return {
      detailOmitted: {
        reason: 'non-json-value',
        summary:
          'The original failure detail contains non-JSON values and remains available from its owning project session.',
      },
    };
  }
  try {
    return { detail: JSON.parse(JSON.stringify(detail)) as Record<string, unknown> };
  } catch {
    return {
      detailOmitted: {
        reason: 'non-json-value',
        summary:
          'The original failure detail could not be serialized and remains available from its owning project session.',
      },
    };
  }
}

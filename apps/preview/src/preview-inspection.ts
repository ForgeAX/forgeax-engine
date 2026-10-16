import type {
  App,
  GameActionDef,
  GameProjectionRegistrar,
  GameProjectionValue,
  GameReadDef,
} from '@forgeax/engine-app';
import type { RenderErrorCode } from '@forgeax/engine-render';

type PreviewInspectionErrorCode =
  | 'projection-action-not-found'
  | 'projection-read-not-found'
  | 'projection-action-failed'
  | 'projection-read-failed'
  | 'projection-result-not-serializable'
  | 'rhi-debug-unavailable'
  | 'rhi-capture-failed'
  | 'rhi-artifact-upload-failed'
  | 'recover-not-needed'
  | 'recover-not-implemented'
  | 'recover-adapter-unavailable'
  | 'recover-device-unavailable'
  | 'recover-lifecycle-failed'
  | 'recover-disposed-during-rebuild'
  | RenderErrorCode;

export type PreviewInspectionError = {
  readonly code: PreviewInspectionErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: GameProjectionValue;
};

export type PreviewInspectionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PreviewInspectionError };

export type PreviewProjectionDescriptor = {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly argsSchema?: GameActionDef['argsSchema'];
};

export type PreviewInspection = {
  readonly version: 1;
  readonly list: () => {
    readonly actions: readonly PreviewProjectionDescriptor[];
    readonly reads: readonly PreviewProjectionDescriptor[];
  };
  readonly read: (id: string) => Promise<PreviewInspectionResult<GameProjectionValue>>;
  readonly run: (
    id: string,
    args?: GameProjectionValue,
  ) => Promise<PreviewInspectionResult<GameProjectionValue>>;
  readonly renderer: {
    readonly health: () => GameProjectionValue;
    readonly recover: () => Promise<PreviewInspectionResult<GameProjectionValue>>;
  };
  /** Test-only frame progress used to diagnose bounded Preview teardown failures. */
  readonly frameProgress: () => ReturnType<App['execution']['report']>['frame'];
  /** Test-only access to the live registry used by browser transport gates. */
  readonly assets: App['assets'];
  readonly captureFrame: (frames?: number) => Promise<PreviewInspectionResult<GameProjectionValue>>;
};

const hostKey = '__forgeaxPreviewInspection';

function error(
  code: PreviewInspectionErrorCode,
  expected: string,
  hint: string,
  detail?: PreviewInspectionError['detail'],
): PreviewInspectionError {
  return detail === undefined ? { code, expected, hint } : { code, expected, hint, detail };
}

function serialise(
  value: unknown,
):
  | { readonly ok: true; readonly value: GameProjectionValue }
  | { readonly ok: false; readonly cause: string } {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return { ok: false, cause: 'JSON.stringify returned undefined' };
    return { ok: true, value: JSON.parse(json) as GameProjectionValue };
  } catch (cause) {
    return { ok: false, cause: String(cause) };
  }
}

const PREVIEW_DETAIL_MAX_DEPTH = 8;
const PREVIEW_DETAIL_MAX_ENTRIES = 64;

/** Project renderer details into bounded JSON-shaped data without dropping nested fields. */
function projectJsonSafe(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
  depth = 0,
): GameProjectionValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined') return null;
  if (typeof value === 'function' || typeof value === 'symbol') return String(value);
  if (depth >= PREVIEW_DETAIL_MAX_DEPTH) return '[truncated]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value
        .slice(0, PREVIEW_DETAIL_MAX_ENTRIES)
        .map((entry) => projectJsonSafe(entry, seen, depth + 1));
    }

    const source = value as Record<string, unknown>;
    const projected: Record<string, GameProjectionValue> = {};
    const entries = Object.entries(
      value instanceof Error
        ? {
            name: value.name,
            message: value.message,
            ...Object.fromEntries(
              ['code', 'expected', 'hint', 'detail']
                .filter((key) => key in value)
                .map((key) => [key, source[key]]),
            ),
          }
        : source,
    );
    for (const [key, entry] of entries.slice(0, PREVIEW_DETAIL_MAX_ENTRIES)) {
      try {
        projected[key] = projectJsonSafe(entry, seen, depth + 1);
      } catch (cause) {
        projected[key] = String(cause);
      }
    }
    return projected;
  } finally {
    seen.delete(value);
  }
}

function descriptor(def: GameActionDef | GameReadDef): PreviewProjectionDescriptor {
  return {
    id: def.id,
    title: def.title,
    ...(def.description === undefined ? {} : { description: def.description }),
    ...('argsSchema' in def && def.argsSchema !== undefined ? { argsSchema: def.argsSchema } : {}),
  };
}

function rendererHealth(app: App): GameProjectionValue {
  const inspection = app.renderer.inspect();
  const executionReport = app.execution?.report();
  const executionFrame = executionReport?.frame;
  const render = executionReport?.render;
  const frame = inspection.frame;
  const state = render?.state ?? inspection.state;
  const fault = executionReport?.fault;
  const retryable = fault?.retryable ?? false;
  const recoverable = render === undefined ? inspection.state === 'device-lost' : retryable;
  return {
    reason: state,
    recoverable,
    surface: inspection.surface,
    ...(render === undefined
      ? { capabilities: projectJsonSafe(inspection.capabilities) }
      : render.capabilities === undefined
        ? {}
        : { capabilities: projectJsonSafe(render.capabilities) }),
    ...(render === undefined
      ? inspection.limits === undefined
        ? {}
        : { limits: projectJsonSafe(inspection.limits) }
      : render.limits === undefined
        ? {}
        : { limits: projectJsonSafe(render.limits) }),
    frame: {
      frameId: frame.frameId,
      deviceGeneration: frame.deviceGeneration,
      ...(render === undefined
        ? {}
        : {
            epoch: render.epoch,
            submittedFrame: render.submittedFrame,
            completedFrame: render.completedFrame,
          }),
      ...(frame.pendingCompletionCount === undefined
        ? {}
        : { pendingCompletionCount: frame.pendingCompletionCount }),
      ...(frame.pendingCompletions === undefined
        ? {}
        : { pendingCompletions: projectJsonSafe(frame.pendingCompletions) }),
    },
    ...(executionFrame === undefined ? {} : { executionFrame: { ...executionFrame } }),
    ...(inspection.capabilities === undefined
      ? {}
      : { backendKind: inspection.capabilities.backendKind }),
    ...(executionReport?.engine === undefined
      ? {}
      : { executionEngineHealth: executionReport.engine.health }),
    features: [...inspection.features],
    ...(fault === null || fault === undefined ? {} : { lastError: projectJsonSafe(fault) }),
  };
}

/**
 * Create the Preview-only inspection boundary for one loaded game.
 *
 * The host owns transport and renderer lifecycle; game code owns the action/read
 * meanings. The returned registrar is passed through GameHost and is
 * cleared by registerCleanup, so a stopped run cannot leave stale closures on
 * the browser global.
 */
export function createPreviewInspection(
  app: App,
  registerCleanup: (cleanup: () => void) => void,
): { readonly registrar: GameProjectionRegistrar; readonly inspection: PreviewInspection } {
  const actions = new Map<string, GameActionDef>();
  const reads = new Map<string, GameReadDef>();

  const registrar: GameProjectionRegistrar = {
    registerAction(def) {
      if (actions.has(def.id) || reads.has(def.id)) {
        throw new Error(`preview: duplicate projection id '${def.id}'`);
      }
      actions.set(def.id, def);
      return () => {
        if (actions.get(def.id) === def) actions.delete(def.id);
      };
    },
    registerRead(def) {
      if (actions.has(def.id) || reads.has(def.id)) {
        throw new Error(`preview: duplicate projection id '${def.id}'`);
      }
      reads.set(def.id, def);
      return () => {
        if (reads.get(def.id) === def) reads.delete(def.id);
      };
    },
  };

  const read = async (id: string): Promise<PreviewInspectionResult<GameProjectionValue>> => {
    const def = reads.get(id);
    if (def === undefined) {
      return {
        ok: false,
        error: error(
          'projection-read-not-found',
          'a read projection registered by the loaded game',
          'call inspection.list() and use one of the returned read ids',
          { id },
        ),
      };
    }
    try {
      const result = serialise(await def.read());
      return result.ok
        ? result
        : {
            ok: false,
            error: error(
              'projection-result-not-serializable',
              'the read projection must return JSON-shaped data',
              'return only null, booleans, numbers, strings, arrays, and plain objects',
              { id, cause: result.cause },
            ),
          };
    } catch (cause) {
      return {
        ok: false,
        error: error(
          'projection-read-failed',
          'the registered read projection completed without throwing',
          'inspect the game-owned read implementation and retry',
          { id, cause: String(cause) },
        ),
      };
    }
  };

  const run = async (
    id: string,
    args: GameProjectionValue = null,
  ): Promise<PreviewInspectionResult<GameProjectionValue>> => {
    const def = actions.get(id);
    if (def === undefined) {
      return {
        ok: false,
        error: error(
          'projection-action-not-found',
          'an action projection registered by the loaded game',
          'call inspection.list() and use one of the returned action ids',
          { id },
        ),
      };
    }
    try {
      const result = serialise(await def.run(args));
      return result.ok
        ? result
        : {
            ok: false,
            error: error(
              'projection-result-not-serializable',
              'the action result must be JSON-shaped data',
              'return only null, booleans, numbers, strings, arrays, and plain objects',
              { id, cause: result.cause },
            ),
          };
    } catch (cause) {
      return {
        ok: false,
        error: error(
          'projection-action-failed',
          'the registered action completed without throwing',
          'inspect the game-owned action implementation and retry',
          { id, cause: String(cause) },
        ),
      };
    }
  };

  const inspection: PreviewInspection = {
    version: 1,
    list: () => ({
      actions: [...actions.values()].map(descriptor),
      reads: [...reads.values()].map(descriptor),
    }),
    read,
    run,
    renderer: {
      health: () => rendererHealth(app),
      recover: async () => {
        const result = await app.renderer.recover();
        const healthValue = rendererHealth(app);
        const resultError = result.ok ? undefined : result.error;
        const resultDetail = (resultError as { readonly detail?: unknown } | undefined)?.detail;
        return result.ok
          ? { ok: true, value: { recovered: true, health: healthValue } }
          : {
              ok: false,
              error: {
                code: result.error.code,
                expected: result.error.expected,
                hint: result.error.hint,
                ...(resultDetail === undefined ? {} : { detail: projectJsonSafe(resultDetail) }),
              },
            };
      },
    },
    frameProgress: () => app.execution.report().frame,
    assets: app.assets,
    captureFrame: async (frames = 1) => {
      if (frames !== 1) {
        return {
          ok: false,
          error: error(
            'rhi-capture-failed',
            'one capture request must produce one single-file rhi-tape ArtifactRef',
            'request exactly one frame and use the returned ArtifactRef for summary and inspect',
            { id: 'frames', cause: `requested ${frames}` },
          ),
        };
      }
      const capture = app.rhiCapture;
      if (capture === undefined) {
        return {
          ok: false,
          error: error(
            'rhi-debug-unavailable',
            'Preview must be started with the RHI debug dev plugin',
            'use the Preview dev host and keep the debug plugin enabled before requesting capture',
          ),
        };
      }
      try {
        const captured = await capture.captureFrame();
        if (!captured.ok) {
          return {
            ok: false,
            error: error('rhi-capture-failed', captured.error.expected, captured.error.hint, {
              cause: captured.error.code,
              capture: projectJsonSafe(captured.error.detail),
            }),
          };
        }
        const runId = `preview-${globalThis.crypto.randomUUID().replaceAll('-', '')}`;
        const uploaded = await capture.upload(captured.value, { runId });
        if (
          !uploaded.ok ||
          uploaded.value.digest !== captured.value.digest ||
          typeof uploaded.value.path !== 'string'
        ) {
          return {
            ok: false,
            error: error(
              'rhi-artifact-upload-failed',
              'the Vite RHI debug provider must verify one chunked v7 .rhitape and return its ArtifactRef',
              'start the Preview dev host with the RHI debug plugin and retry the capture',
              { cause: JSON.stringify(uploaded.ok ? uploaded.value : uploaded.error) },
            ),
          };
        }
        return {
          ok: true,
          value: {
            kind: 'rhi-tape',
            digest: captured.value.digest,
            source: 'rhi.capture',
            path: uploaded.value.path,
          },
        };
      } catch (cause) {
        return {
          ok: false,
          error: error(
            'rhi-artifact-upload-failed',
            'the active renderer must produce an uploadable RHI tape and the dev provider must be reachable',
            'inspect the Preview dev server and retry after the next healthy frame',
            { cause: String(cause) },
          ),
        };
      }
    },
  };

  const host = globalThis as Record<string, unknown>;
  registerCleanup(() => {
    actions.clear();
    reads.clear();
    if (host[hostKey] === inspection) delete host[hostKey];
  });
  return { registrar, inspection };
}

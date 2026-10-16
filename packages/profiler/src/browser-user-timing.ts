import type { Profiler } from './profiler.js';
import type { ProfileDetail, RecorderSession } from './recorder.js';
import type { ProfileCapture, ProfilePhaseStart, ProfileSource } from './types.js';

/** The small browser API surface used by the opt-in User Timing adapter. */
type UserTiming = { readonly mark: (name: string) => void };

/** Configuration shared by editor and standalone Play browser hosts. */
export interface UserTimingProfilerOptions {
  /** Global flag that enables marks. Defaults to the harness diagnostic flag. */
  readonly diagnosticsKey?: string;
  /** Stable id written into the optional Profiler capture projection. */
  readonly captureId?: string;
  /** Host callback invoked after an owner phase closes. */
  readonly onPhaseEnd?: (phase: { readonly source: ProfileSource; readonly phase: string }) => void;
}

type DiagnosticGlobal = Record<string, unknown>;
type PhaseCatalog = ProfileCapture['phaseCatalog'];

function partialCapture(captureId: string, phaseCatalog: PhaseCatalog): ProfileCapture {
  return {
    schemaVersion: '1.0',
    captureId,
    timeUnit: 'microseconds',
    frameLimit: 1,
    eventLimit: 1,
    phaseCatalog,
    records: [],
    completeness: {
      status: 'partial',
      retainedEventCount: 0,
      droppedEventCount: 0,
      incompleteReason: 'user-timing-transport',
    },
  };
}

function diagnosticsEnabled(key: string): boolean {
  const value = (globalThis as unknown as DiagnosticGlobal)[key];
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { readonly enabled?: unknown }).enabled === true
  );
}

function diagnosticsDetail(key: string): ProfileDetail {
  const value = (globalThis as unknown as DiagnosticGlobal)[key];
  if (typeof value !== 'object' || value === null) return 'owner';
  const detail = (value as { readonly detail?: unknown }).detail;
  return detail === 'nested' || detail === 'passes' ? detail : 'owner';
}

/**
 * Creates a zero-cost-while-disabled browser projection of the engine Profiler.
 *
 * The engine frame loop remains the phase owner. This adapter only translates
 * the already-open phases to User Timing marks when a host explicitly enables
 * the diagnostic flag before app creation. Normal game/editor frames therefore
 * do not allocate a profiler or call performance.mark().
 */
export function createUserTimingProfiler(
  options: UserTimingProfilerOptions = {},
): Profiler | undefined {
  const diagnosticsKey = options.diagnosticsKey ?? '__forgeaxFramePhaseDiagnostics';
  const captureId = options.captureId ?? 'forgeax-user-timing';
  const timingEnabled = diagnosticsEnabled(diagnosticsKey);
  const detail = diagnosticsDetail(diagnosticsKey);
  const performanceApi = timingEnabled
    ? (globalThis as unknown as { readonly performance?: UserTiming }).performance
    : undefined;
  if (!timingEnabled && options.onPhaseEnd === undefined) return undefined;
  if (
    timingEnabled &&
    (performanceApi === undefined || typeof performanceApi.mark !== 'function')
  ) {
    if (options.onPhaseEnd === undefined) return undefined;
  }

  let phaseCatalog: PhaseCatalog = { app: [], render: [] };
  let frameId: number | undefined;
  let active = true;
  let latest: ProfileCapture | undefined;
  const openPhases: Array<{ readonly source: ProfileSource; readonly phase: string }> = [];

  function mark(name: string): void {
    if (performanceApi === undefined) return;
    try {
      performanceApi.mark(name);
    } catch {
      // Diagnostics must not change the host frame-loop behavior.
    }
  }

  function timingSource(source: ProfileSource): 'frame' | 'render' {
    return source === 'app' ? 'frame' : 'render';
  }

  const session = {
    captureId,
    detail,
    beginFrame(nextFrameId: number) {
      frameId = nextFrameId;
      openPhases.length = 0;
      return { ok: true as const, value: undefined };
    },
    beginPhase(inputOrSource: ProfilePhaseStart | ProfileSource, phaseName?: string) {
      if (frameId === undefined) return { ok: true as const, value: undefined };
      const input =
        typeof inputOrSource === 'string'
          ? { source: inputOrSource, phase: phaseName as string }
          : inputOrSource;
      openPhases.push(input);
      mark(`forgeax.${timingSource(input.source)}.phase.${frameId}.${input.phase}.begin`);
      return { ok: true as const, value: undefined };
    },
    endPhase() {
      const phase = openPhases.pop();
      if (phase !== undefined) options.onPhaseEnd?.(phase);
      if (frameId !== undefined && phase !== undefined) {
        mark(`forgeax.${timingSource(phase.source)}.phase.${frameId}.${phase.phase}.end`);
      }
      return { ok: true as const, value: undefined };
    },
    recordSkip(input: {
      readonly source: ProfileSource;
      readonly phase: string;
      readonly reason: string;
    }) {
      if (frameId !== undefined) {
        mark(
          `forgeax.${timingSource(input.source)}.phase.${frameId}.${input.phase}.skip.${input.reason}`,
        );
      }
      return { ok: true as const, value: undefined };
    },
    endFrame() {
      frameId = undefined;
      openPhases.length = 0;
      return { ok: true as const, value: undefined };
    },
    finish() {
      latest = partialCapture(captureId, phaseCatalog);
      active = false;
      frameId = undefined;
      openPhases.length = 0;
      return { ok: true as const, value: latest };
    },
  } satisfies RecorderSession;

  return {
    registerPhaseCatalog(source, phases) {
      const definition = [...phases];
      phaseCatalog = { ...phaseCatalog, [source]: definition };
      let registered = true;
      return {
        ok: true,
        value: () => {
          if (!registered) return;
          registered = false;
          if (phaseCatalog[source] !== definition) return;
          phaseCatalog = { ...phaseCatalog, [source]: [] };
        },
      };
    },
    startCapture() {
      active = true;
      latest = undefined;
      return { ok: true, value: session };
    },
    activeCaptureId() {
      return active ? captureId : undefined;
    },
    activeSession() {
      return active ? session : undefined;
    },
    latestCapture() {
      return latest;
    },
    get phaseCatalog() {
      return phaseCatalog;
    },
  };
}

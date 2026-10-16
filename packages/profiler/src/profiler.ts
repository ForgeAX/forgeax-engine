import { createProfileClock, type ProfileClock } from './clock.js';
import type { ProfilerError, ProfilerResult } from './errors.js';
import type { RecorderPhaseCatalog } from './recorder.js';
import { createRecorder, type RecorderLimits, type RecorderSession } from './recorder.js';
import type { ProfileAllocationReport, ProfileCapture, ProfileSink } from './types.js';

export interface ProfilerOptions {
  readonly clock?: ProfileClock;
  readonly sink?: ProfileSink;
  readonly enabled?: boolean;
  readonly phaseCatalog?: RecorderPhaseCatalog;
  readonly allocationReport?: ProfileAllocationReport;
}

export type ProfilerCatalogSource = keyof RecorderPhaseCatalog;

export interface Profiler {
  registerPhaseCatalog(
    source: ProfilerCatalogSource,
    phases: readonly string[],
  ): ProfilerResult<() => void>;
  startCapture(limits: RecorderLimits): ProfilerResult<RecorderSession>;
  activeCaptureId(): string | undefined;
  activeSession(): RecorderSession | undefined;
  latestCapture(): ProfileCapture | undefined;
  readonly phaseCatalog: RecorderPhaseCatalog;
}

export function createProfiler(options: ProfilerOptions = {}): Profiler {
  const clock = options.clock ?? createProfileClock();
  const enabled = options.enabled ?? true;
  const sink = options.sink;
  const phaseCatalog: RecorderPhaseCatalog =
    options.phaseCatalog === undefined
      ? { app: [], render: [] }
      : { app: [...options.phaseCatalog.app], render: [...options.phaseCatalog.render] };
  const registeredSources = new Set<ProfilerCatalogSource>();
  if (options.phaseCatalog !== undefined) {
    registeredSources.add('app');
    registeredSources.add('render');
  }
  let nextCaptureNumber = 1;
  let active: RecorderSession | undefined;
  let latest: ProfileCapture | undefined;

  return {
    registerPhaseCatalog(source, phases) {
      if (registeredSources.has(source)) {
        return {
          ok: false,
          error: {
            code: 'phase-catalog-conflict',
            expected: `one ${source} phase catalog definition`,
            hint: 'Use the owner declaration already registered on this profiler.',
            detail: {
              source,
              expected: [...phaseCatalog[source]],
              actual: [...phases],
            },
          },
        };
      }
      const definition = [...phases];
      Object.assign(phaseCatalog, { [source]: definition });
      registeredSources.add(source);
      let active = true;
      return {
        ok: true,
        value: () => {
          if (!active) return;
          active = false;
          if (phaseCatalog[source] !== definition) return;
          Object.assign(phaseCatalog, { [source]: [] });
          registeredSources.delete(source);
        },
      };
    },
    startCapture(limits) {
      if (!enabled) {
        return {
          ok: false,
          error: {
            code: 'profiler-not-enabled',
            expected: 'an explicitly enabled profiler',
            hint: 'Enable the development profiler capability before starting capture.',
            detail: { enabled: false },
          },
        };
      }
      if (active !== undefined) {
        return {
          ok: false,
          error: {
            code: 'capture-already-active',
            expected: 'no active capture',
            hint: 'Finish or stop the active capture before starting another one.',
            detail: { captureId: active.captureId },
          },
        };
      }
      const captureId = `capture-${String(nextCaptureNumber).padStart(4, '0')}`;
      nextCaptureNumber += 1;
      const result = createRecorder(
        captureId,
        limits,
        clock,
        phaseCatalog,
        options.allocationReport,
      );
      if (!result.ok) return result;
      const session = wrapSink(result.value, sink, limits.frameLimit, (capture) => {
        latest = capture;
        active = undefined;
      });
      active = session;
      return { ok: true, value: session };
    },
    activeCaptureId() {
      return active?.captureId;
    },
    activeSession() {
      return active;
    },
    latestCapture() {
      return latest;
    },
    get phaseCatalog() {
      return phaseCatalog;
    },
  };
}

function wrapSink(
  session: RecorderSession,
  sink: ProfileSink | undefined,
  frameLimit: number,
  complete: (capture: ProfileCapture) => void,
): RecorderSession {
  let frameCount = 0;
  let terminal: ProfilerResult<ProfileCapture> | undefined;

  function finish(): ProfilerResult<ProfileCapture> {
    if (terminal !== undefined) return terminal;
    const result = session.finish();
    if (!result.ok) return result;
    complete(result.value);
    if (sink === undefined) {
      terminal = result;
      return result;
    }
    let failureMessage: string | undefined;
    try {
      const sinkResult = sink.write(result.value);
      if (sinkResult !== undefined && !sinkResult.ok)
        failureMessage = sinkResult.error.detail?.message ?? 'sink rejected artifact';
    } catch (caught) {
      failureMessage = caught instanceof Error ? caught.message : 'sink threw a non-Error value';
    }
    terminal =
      failureMessage === undefined
        ? result
        : {
            ok: false,
            error: {
              code: 'profile-sink-failed',
              expected: 'a sink that accepts a partial or complete artifact',
              hint: 'Replace the sink or retain the returned partial artifact for offline retry.',
              detail: { message: failureMessage },
            },
          };
    return terminal;
  }

  return {
    ...session,
    beginFrame(frameId) {
      const result = session.beginFrame(frameId);
      if (result.ok) frameCount += 1;
      return result;
    },
    endFrame() {
      const result = session.endFrame();
      if (result.ok && frameCount >= frameLimit) finish();
      return result;
    },
    finish() {
      return finish();
    },
  };
}

export type { ProfileCapture, ProfilerError };

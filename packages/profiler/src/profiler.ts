import { createProfileClock, type ProfileClock } from './clock.js';
import type { ProfilerError, ProfilerResult } from './errors.js';
import type { RecorderPhaseCatalog } from './recorder.js';
import {
  createRecorder,
  type RecorderLimits,
  type RecorderSession,
  validateRecorderLimits,
} from './recorder.js';
import type {
  ProfileAllocationReport,
  ProfileCapture,
  ProfileCompletionCpuObservation,
  ProfileReceiptCompletionIdentity,
  ProfileSink,
} from './types.js';

export interface ProfilerOptions {
  readonly clock?: ProfileClock;
  readonly sink?: ProfileSink;
  readonly enabled?: boolean;
  readonly phaseCatalog?: RecorderPhaseCatalog;
  readonly allocationReport?: ProfileAllocationReport;
}

export type ProfilerCatalogSource = keyof RecorderPhaseCatalog;
export type ProfilerPhaseCatalogProvider = () => readonly string[];

export interface Profiler {
  registerPhaseCatalog(
    source: ProfilerCatalogSource,
    phases: readonly string[],
    dynamicPhases?: ProfilerPhaseCatalogProvider,
  ): ProfilerResult<() => void>;
  startCapture(limits: RecorderLimits): ProfilerResult<RecorderSession>;
  activeCaptureId(): string | undefined;
  activeSession(): RecorderSession | undefined;
  latestCapture(): ProfileCapture | undefined;
  hasCompletionCpuObservers(): boolean;
  /** Observe App's synchronous completion notification for exact profiled receipts. */
  observeCompletionCpu(
    listener: (observation: ProfileCompletionCpuObservation) => void,
  ): () => void;
  /** Time only the synchronous callback body; never the receipt Promise wait. */
  observeReceiptCompletion<T>(receipt: ProfileReceiptCompletionIdentity, callback: () => T): T;
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
  const completionListeners = new Set<(observation: ProfileCompletionCpuObservation) => void>();
  const staticPhaseCatalog: RecorderPhaseCatalog = {
    app: [...phaseCatalog.app],
    render: [...phaseCatalog.render],
  };
  const dynamicPhaseProviders: Partial<
    Record<ProfilerCatalogSource, ProfilerPhaseCatalogProvider>
  > = {};
  let captureStarting = false;
  let catalogRevision = 0;

  return {
    registerPhaseCatalog(source, phases, dynamicPhases) {
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
      Object.assign(staticPhaseCatalog, { [source]: definition });
      if (dynamicPhases !== undefined) dynamicPhaseProviders[source] = dynamicPhases;
      registeredSources.add(source);
      catalogRevision += 1;
      let registrationActive = true;
      return {
        ok: true,
        value: () => {
          if (!registrationActive) return;
          registrationActive = false;
          if (staticPhaseCatalog[source] !== definition) return;
          Object.assign(phaseCatalog, { [source]: [] });
          Object.assign(staticPhaseCatalog, { [source]: [] });
          delete dynamicPhaseProviders[source];
          registeredSources.delete(source);
          catalogRevision += 1;
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
      if (active !== undefined || captureStarting) {
        return {
          ok: false,
          error: {
            code: 'capture-already-active',
            expected: 'no active capture or capture-admission callback',
            hint: 'Finish the active capture or retry after phase providers return.',
            detail: { captureId: active?.captureId ?? '<capture-starting>' },
          },
        };
      }
      const frameLimit = limits.frameLimit;
      const eventLimit = limits.eventLimit;
      const detail = limits.detail;
      const admittedLimits: RecorderLimits = {
        frameLimit,
        eventLimit,
        ...(detail === undefined ? {} : { detail }),
      };
      const limitsResult = validateRecorderLimits(admittedLimits);
      if (!limitsResult.ok) return limitsResult;
      captureStarting = true;
      const admissionRevision = catalogRevision;
      try {
        const dynamicCatalog: Record<ProfilerCatalogSource, readonly string[]> = {
          app: [],
          render: [],
        };
        for (const source of ['app', 'render'] as const) {
          const provideDynamicPhases = dynamicPhaseProviders[source];
          try {
            const dynamic = provideDynamicPhases?.() ?? [];
            if (
              !Array.isArray(dynamic) ||
              dynamic.some((phase) => typeof phase !== 'string' || phase.length === 0)
            )
              throw new TypeError('phase provider must return non-empty phase names');
            dynamicCatalog[source] = [...new Set([...staticPhaseCatalog[source], ...dynamic])];
          } catch (cause) {
            return {
              ok: false,
              error: {
                code: 'phase-catalog-provider-failed',
                expected: 'the source owner returns its current stable dynamic phase names',
                hint: 'Fix the source phase owner and retry capture.',
                detail: {
                  source,
                  message: cause instanceof Error ? cause.message : 'phase provider failed',
                },
              },
            };
          }
        }
        if (catalogRevision !== admissionRevision) {
          return {
            ok: false,
            error: {
              code: 'phase-catalog-provider-failed',
              expected: 'phase owners remain stable during capture admission',
              hint: 'Retry capture after phase owner lifecycle changes settle.',
              detail: { source: 'app', message: 'phase catalog changed during provider execution' },
            },
          };
        }
        Object.assign(phaseCatalog, dynamicCatalog);
        const admittedCatalog: RecorderPhaseCatalog = Object.freeze({
          app: Object.freeze([...dynamicCatalog.app]),
          render: Object.freeze([...dynamicCatalog.render]),
        });
        const captureId = `capture-${String(nextCaptureNumber).padStart(4, '0')}`;
        const result = createRecorder(
          captureId,
          admittedLimits,
          clock,
          admittedCatalog,
          options.allocationReport,
          (capture) => {
            latest = capture;
            active = undefined;
            return publishCapture(capture, sink);
          },
        );
        if (!result.ok) return result;
        nextCaptureNumber += 1;
        active = result.value;
        return result;
      } finally {
        captureStarting = false;
      }
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
    hasCompletionCpuObservers() {
      return completionListeners.size > 0;
    },
    observeCompletionCpu(listener) {
      completionListeners.add(listener);
      let observing = true;
      return () => {
        if (!observing) return;
        observing = false;
        completionListeners.delete(listener);
      };
    },
    observeReceiptCompletion(receipt, callback) {
      if (completionListeners.size === 0) return callback();
      const listeners = [...completionListeners];
      let identity:
        | {
            readonly captureId: string;
            readonly profileFrameId: number;
            readonly receiptFrameId: number;
            readonly deviceGeneration: number;
          }
        | undefined;
      try {
        const profileFrame = receipt.profileFrame;
        if (profileFrame !== undefined) {
          const captureId = profileFrame.captureId;
          const profileFrameId = profileFrame.frameId;
          const receiptFrameId = receipt.frameId;
          const deviceGeneration = receipt.deviceGeneration;
          if (
            typeof captureId === 'string' &&
            Number.isSafeInteger(profileFrameId) &&
            profileFrameId > 0 &&
            Number.isSafeInteger(receiptFrameId) &&
            Number.isSafeInteger(deviceGeneration)
          )
            identity = { captureId, profileFrameId, receiptFrameId, deviceGeneration };
        }
      } catch {}
      if (identity === undefined) return callback();
      let startMicros: number;
      try {
        startMicros = clock.nowMicros();
      } catch {
        return callback();
      }
      let callbackStatus: ProfileCompletionCpuObservation['callbackStatus'] = 'returned';
      try {
        return callback();
      } catch (cause) {
        callbackStatus = 'threw';
        throw cause;
      } finally {
        let endMicros: number | undefined;
        try {
          endMicros = Math.max(startMicros, clock.nowMicros());
        } catch {}
        if (endMicros !== undefined) {
          try {
            const observation: ProfileCompletionCpuObservation = Object.freeze({
              ...identity,
              callbackStatus,
              startMicros,
              endMicros,
              durationMicros: endMicros - startMicros,
            });
            for (const listener of listeners) {
              try {
                listener(observation);
              } catch {
                // Completion diagnostics cannot change the application callback result.
              }
            }
          } catch {}
        }
      }
    },
    get phaseCatalog() {
      return phaseCatalog;
    },
  };
}

function publishCapture(
  capture: ProfileCapture,
  sink: ProfileSink | undefined,
): ProfilerResult<ProfileCapture> {
  if (sink === undefined) return { ok: true, value: capture };
  let failureMessage: string | undefined;
  try {
    const sinkResult = sink.write(capture);
    if (sinkResult !== undefined && !sinkResult.ok)
      failureMessage = sinkResult.error.detail?.message ?? 'sink rejected artifact';
  } catch (caught) {
    failureMessage = caught instanceof Error ? caught.message : 'sink threw a non-Error value';
  }
  return failureMessage === undefined
    ? { ok: true, value: capture }
    : {
        ok: false,
        error: {
          code: 'profile-sink-failed',
          expected: 'a sink that accepts a partial or complete artifact',
          hint: 'Replace the sink or retain the returned partial artifact for offline retry.',
          detail: { message: failureMessage },
        },
      };
}

export type { ProfileCapture, ProfilerError };

import {
  buildProfileModel,
  createProfiler,
  validateProfileCapture,
} from '@forgeax/engine-profiler';

/**
 * Short, intrusive CPU attribution. Pass this exact profiler to both Renderer
 * construction and App options. The caller owns readiness, input and teardown.
 * `now` is the actual Platform's millisecond clock, evaluated only in phases.
 */
export function createPhoneGameplayCpu({ now } = {}) {
  if (typeof now !== 'function') throw new TypeError('CPU capture requires Platform.now');
  let session, limits, firstFailure;
  let failureCount = 0;
  function failed(operation, error) {
    failureCount += 1;
    firstFailure ??= {
      operation,
      error: error instanceof Error ? { name: error.name, message: error.message } : error,
    };
    return { ok: false, error };
  }
  const profiler = createProfiler({
    clock: {
      nowMicros() {
        try {
          const milliseconds = now();
          if (!Number.isFinite(milliseconds) || milliseconds < 0)
            throw new TypeError('Platform.now must return finite nonnegative milliseconds');
          // Match the Profiler clock contract: timestamps are integer microseconds.
          return Math.floor(milliseconds * 1000);
        } catch (error) {
          failed('clock', error);
          throw error;
        }
      },
    },
  });
  return {
    profiler,
    start({ frameLimit = 120, eventLimit = frameLimit * 128 } = {}) {
      if (![120, 240].includes(frameLimit) || eventLimit > 65_536) {
        return failed('start', {
          code: 'phone-cpu-boundary-invalid',
          expected: '120 or 240 frames and at most 65536 events',
          detail: { frameLimit, eventLimit },
        });
      }
      const requested = { frameLimit, eventLimit, detail: 'nested' };
      const result = profiler.startCapture(requested);
      if (!result.ok) return failed('start', result.error);
      limits = requested;
      session = result.value;
      return result;
    },
    stop() {
      if (!session)
        return failed('stop', {
          code: 'phone-cpu-not-started',
          expected: 'a started CPU capture',
        });
      const result = session.finish();
      return result.ok ? result : failed('stop', result.error);
    },
    /** Call after the bounded window; validation and projection are offline work. */
    read() {
      const latest = profiler.latestCapture();
      const capture = latest && latest.captureId === session?.captureId ? latest : null;
      const validation = capture ? validateProfileCapture(capture) : null;
      const projected = validation?.ok ? buildProfileModel(validation.value) : null;
      const model = projected?.ok ? projected.value : null;
      const appFrames = new Set();
      const renderFrames = new Set();
      for (const record of capture?.records ?? []) {
        if (record.kind !== 'phase') continue;
        if (record.source === 'app' && record.parentPhase === undefined)
          appFrames.add(record.frameId);
        if (record.source === 'render') renderFrames.add(record.frameId);
      }
      const ownerCoverageComplete =
        !!model && appFrames.size === limits.frameLimit && renderFrames.size === limits.frameLimit;
      const phaseTimings = model?.phases.map((phase) => {
        let totalMicros = 0;
        let maxMicros = null;
        for (const record of capture.records) {
          if (
            record.kind !== 'phase' ||
            record.source !== phase.source ||
            record.phase !== phase.phase ||
            record.parentSource !== phase.parentSource ||
            record.parentPhase !== phase.parentPhase
          )
            continue;
          totalMicros += record.durationMicros;
          maxMicros = Math.max(maxMicros ?? 0, record.durationMicros);
        }
        return {
          ...phase,
          totalMicros: phase.count ? totalMicros : null,
          meanMicros: phase.count ? totalMicros / phase.count : null,
          maxMicros,
        };
      });
      let status = session ? 'recording' : 'not-started';
      if (capture) status = capture.completeness.status;
      if (status === 'complete' && !ownerCoverageComplete) status = 'partial';
      if (firstFailure || validation?.ok === false || projected?.ok === false) status = 'failed';
      return {
        schemaVersion: 'forgeax-phone-gameplay-cpu/1',
        diagnosticOnly: true,
        cleanFpsEvidence: false,
        clock: 'platform.now milliseconds -> microseconds',
        scope:
          'Inclusive elapsed CPU phases from the shared App/Renderer profiler. Parent and child times overlap; do not add them. Frame completion means App CPU endFrame, not GPU receipt or presentation. No individual ECS-system or GPU timing is measured.',
        status,
        limits: limits ?? null,
        failureCount,
        firstFailure: firstFailure ?? null,
        capture,
        validation: validation?.ok ? { ok: true } : validation,
        // The raw capture already carries every event; do not serialize a second
        // copy through model.frames. Per-frame models can be rebuilt offline.
        model: model ? { summary: model.summary, phases: model.phases } : null,
        modelError: projected?.ok === false ? projected.error : null,
        coverage: {
          completedAppFrames: appFrames.size,
          rendererFrames: renderFrames.size,
          ownerCoverageComplete,
        },
        timing: {
          app: phaseTimings?.filter((phase) => phase.source === 'app') ?? [],
          render: phaseTimings?.filter((phase) => phase.source === 'render') ?? [],
        },
      };
    },
  };
}

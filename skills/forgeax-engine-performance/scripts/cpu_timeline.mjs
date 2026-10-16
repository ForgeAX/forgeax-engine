import { requireFact } from './lib.mjs';

// Reconstruct timestamp/sample pairs before ordering, matching CDP/DevTools.
// A negative raw delta is not a negative duration assigned to a function.
export function cpuSampleTimeline(profile) {
  requireFact(
    Array.isArray(profile.samples) &&
      profile.samples.length > 0 &&
      Array.isArray(profile.timeDeltas) &&
      profile.samples.length === profile.timeDeltas.length,
    'Require nonempty matching CPU samples/timeDeltas',
  );
  requireFact(
    Number.isFinite(profile.startTime) &&
      Number.isFinite(profile.endTime) &&
      profile.endTime > profile.startTime,
    'Invalid CPU interval',
  );
  let clock = profile.startTime,
    negativeDeltaCount = 0,
    negativeDeltaUs = 0;
  const ordered = profile.samples
    .map((id, index) => {
      const delta = profile.timeDeltas[index];
      requireFact(Number.isFinite(delta), 'Invalid CPU sample delta');
      if (delta < 0) {
        negativeDeltaCount++;
        negativeDeltaUs -= delta;
      }
      clock += delta;
      requireFact(
        Number.isFinite(clock) && clock >= profile.startTime && clock <= profile.endTime + 1,
        'CPU sample timestamp exceeds profile interval',
      );
      return { id, index, timestamp: Math.min(clock, profile.endTime) };
    })
    .sort((a, b) => a.timestamp - b.timestamp || a.index - b.index);
  let previous = profile.startTime,
    reorderedSamples = 0,
    reorderedUs = 0;
  const intervals = ordered.map((sample, position) => {
    const result = {
      ...sample,
      position,
      startTime: previous,
      endTime: sample.timestamp,
      delta: sample.timestamp - previous,
    };
    previous = sample.timestamp;
    if (sample.index !== position) {
      reorderedSamples++;
      reorderedUs += result.delta;
    }
    return result;
  });
  return {
    intervals,
    audit: {
      method: 'timestamp-ordered-ending-sample',
      negativeDeltaCount,
      negativeDeltaMs: negativeDeltaUs / 1000,
      reorderedSamples,
      reorderedIntervalMs: reorderedUs / 1000,
      attributionSensitive: reorderedSamples > 0,
      note: 'Raw timestamps/sample IDs are paired before stable ordering. No tail sample is fabricated. The first interval is unsampled startup.',
    },
  };
}

import type { ProfileCapture } from '@forgeax/engine/profiler';

export function sampleCapture(captureId: string, durations: readonly number[]): ProfileCapture {
  let start = 1000;
  const records = durations.map((durationMicros, index) => {
    const record = {
      kind: 'phase' as const,
      source: 'app' as const,
      frameId: index + 1,
      phase: 'frame-total',
      startMicros: start,
      endMicros: start + durationMicros,
      durationMicros,
    };
    start += durationMicros + 10;
    return record;
  });
  return {
    schemaVersion: '1.0',
    captureId,
    timeUnit: 'microseconds',
    frameLimit: durations.length,
    eventLimit: 8,
    phaseCatalog: {
      app: [
        'frame-total',
        'world-update-primary',
        'draw-source',
        'world-update-injected',
        'renderer-draw',
      ],
      render: ['extract', 'bind-groups', 'features', 'sort', 'record'],
    },
    records,
    completeness: { status: 'complete', retainedEventCount: records.length, droppedEventCount: 0 },
  };
}

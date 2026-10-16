import { describe, expect, it } from 'vitest';

// @ts-expect-error The regression intentionally imports the built .mjs artifact;
// TypeScript does not map an explicit .mjs path to the sibling generated .d.ts.
import { createProfiler, validateProfileCapture } from '../../dist/index.mjs';

describe('published profiler browser entry', () => {
  it('loads the built ESM entry and validates a real capture', () => {
    const profiler = createProfiler({
      phaseCatalog: { app: ['frame-total'], render: [] },
    });
    const started = profiler.startCapture({ frameLimit: 1, eventLimit: 8 });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const session = started.value;
    expect(session.beginFrame(1).ok).toBe(true);
    expect(session.beginPhase({ source: 'app', phase: 'frame-total' }).ok).toBe(true);
    expect(session.endPhase().ok).toBe(true);
    expect(session.endFrame().ok).toBe(true);

    const capture = profiler.latestCapture();
    expect(capture?.records.length).toBeGreaterThan(0);
    const validated = validateProfileCapture(capture);
    expect(validated.ok).toBe(true);
  });
});

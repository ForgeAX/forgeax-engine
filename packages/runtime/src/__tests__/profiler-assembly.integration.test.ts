import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createProfiler } from '@forgeax/engine-profiler';
import type { RendererOptions } from '@forgeax/engine-render';
import { describe, expect, it } from 'vitest';

describe('runtime profiler assembly', () => {
  it('accepts the host profiler capability without creating a second owner', () => {
    const profiler = createProfiler();
    const options = { profiler } satisfies RendererOptions;

    expect(options.profiler).toBe(profiler);
    expect(profiler.activeSession()).toBeUndefined();
  });

  it('forwards the explicit capability and keeps runtime free of Remote and CLI ownership', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../createRenderer.ts', import.meta.url)),
      'utf8',
    );

    expect(source).toContain('constructRuntimeRendererHost(canvas, options, bundler)');
    expect(source).not.toContain('@forgeax/engine-remote');
    expect(source).not.toContain('phaseCatalog');
    expect(source).not.toContain('createProfiler');
  });

  it('preserves capture completeness across stop and overflow boundaries', () => {
    const stopped = createProfiler();
    const stoppedSession = stopped.startCapture({ frameLimit: 2, eventLimit: 8 });
    expect(stoppedSession.ok).toBe(true);
    if (!stoppedSession.ok) return;
    expect(stoppedSession.value.beginFrame(1).ok).toBe(true);
    expect(stoppedSession.value.endFrame().ok).toBe(true);
    const partial = stoppedSession.value.finish();
    expect(partial.ok).toBe(true);
    if (partial.ok) expect(partial.value.completeness.status).toBe('partial');

    const overflow = createProfiler({ phaseCatalog: { app: [], render: ['record'] } });
    const overflowSession = overflow.startCapture({ frameLimit: 2, eventLimit: 1 });
    expect(overflowSession.ok).toBe(true);
    if (!overflowSession.ok) return;
    for (const frameId of [1, 2]) {
      expect(overflowSession.value.beginFrame(frameId).ok).toBe(true);
      expect(
        overflowSession.value.recordSkip({ source: 'render', phase: 'record', reason: 'no-render' })
          .ok,
      ).toBe(true);
      expect(overflowSession.value.endFrame().ok).toBe(true);
    }
    const artifact = overflowSession.value.finish();
    expect(artifact.ok).toBe(true);
    if (artifact.ok) expect(artifact.value.completeness.status).toBe('overflow');
  });

  it('isolates sink Result.err and thrown failures without losing latest capture', () => {
    for (const sink of [
      { write: () => ({ ok: false as const, error: { code: 'sink-rejected' } }) },
      {
        write: () => {
          throw new Error('sink-threw');
        },
      },
    ]) {
      const profiler = createProfiler({ sink });
      const session = profiler.startCapture({ frameLimit: 1, eventLimit: 4 });
      expect(session.ok).toBe(true);
      if (!session.ok) continue;
      const result = session.value.finish();
      expect(result.ok).toBe(false);
      expect(profiler.latestCapture()).toBeDefined();
    }
  });
});

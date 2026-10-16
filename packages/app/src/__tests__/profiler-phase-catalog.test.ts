import { readFileSync } from 'node:fs';
import { createProfiler } from '@forgeax/engine-profiler';
import { describe, expect, it } from 'vitest';

import { APP_PHASE_CATALOG } from '../types';

describe('App profiler phase catalog ownership', () => {
  it('matches the profiler receiver set by definition and has five unique phases', () => {
    const profiler = createProfiler();
    expect(profiler.registerPhaseCatalog('app', APP_PHASE_CATALOG).ok).toBe(true);
    expect(APP_PHASE_CATALOG).toHaveLength(9);
    expect(new Set(APP_PHASE_CATALOG).size).toBe(APP_PHASE_CATALOG.length);
    expect(new Set(APP_PHASE_CATALOG)).toEqual(new Set(profiler.phaseCatalog.app));
  });

  it('rejects a second App catalog definition', () => {
    const profiler = createProfiler();
    expect(profiler.registerPhaseCatalog('app', APP_PHASE_CATALOG).ok).toBe(true);
    const duplicate = profiler.registerPhaseCatalog('app', APP_PHASE_CATALOG);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.code).toBe('phase-catalog-conflict');
  });

  it('keeps the phase declaration in the App owner module', () => {
    const source = readFileSync(new URL('../types.ts', import.meta.url), 'utf8');
    expect(source.match(/'frame-total'/g)).toHaveLength(1);
    expect(source).not.toContain('FramePhaseObserver');
    expect(source).not.toContain('frameSeq');
  });
});

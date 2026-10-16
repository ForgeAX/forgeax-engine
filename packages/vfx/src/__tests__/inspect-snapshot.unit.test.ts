import { describe, expect, it } from 'vitest';
import { createVfxInspectSnapshot } from '../gpu-runtime.js';

describe('public VFX inspect snapshot', () => {
  it('projects every Batch B observation surface without particle readback', () => {
    const snapshot = createVfxInspectSnapshot({
      layoutFingerprint: 'sha256:layout',
      parameterGeneration: 4,
      patchCount: 2,
      dataInterfaces: { readiness: 'ready', generation: 4, requirements: ['vfx:camera'] },
      channels: { impact: { capacity: 8, dropped: 1 } },
      stages: { readiness: 'ready', dependencies: ['update'] },
      renderers: { topology: 'ribbon', produced: 4, dropped: 0 },
      hmr: { candidateGeneration: 5, lastKnownGoodGeneration: 4, state: 'last-known-good' },
      gpuTiming: { frameMs: 1.25, samples: 4 },
    });

    expect(snapshot).toMatchObject({
      layout: { fingerprint: 'sha256:layout' },
      values: { generation: 4, patchCount: 2 },
      dataInterfaces: { readiness: 'ready' },
      channels: { impact: { capacity: 8, dropped: 1 } },
      stages: { readiness: 'ready' },
      renderers: { topology: 'ribbon' },
      hmr: { lastKnownGoodGeneration: 4 },
      gpuTiming: { frameMs: 1.25 },
    });
    expect(JSON.stringify(snapshot)).not.toContain('particles');
  });

  it('preserves owner-local structured recovery data', () => {
    const snapshot = createVfxInspectSnapshot({
      layoutFingerprint: 'sha256:layout',
      parameterGeneration: 4,
      patchCount: 2,
      error: {
        code: 'vfx-data-interface-missing',
        expected: 'vfx:scene-depth',
        hint: 'register the scene depth provider',
        detail: { token: 'vfx:scene-depth' },
      },
    });

    expect(snapshot.error).toMatchObject({
      code: 'vfx-data-interface-missing',
      expected: 'vfx:scene-depth',
      hint: 'register the scene depth provider',
      detail: { token: 'vfx:scene-depth' },
    });
  });
});

import { describe, expect, it } from 'vitest';
import { createVfxRenderInspectSnapshot } from '../feature/gpu-particle-feature.js';

describe('VFX render inspect projection', () => {
  it('reports topology counters, stage readiness, provider state, and timing', () => {
    const snapshot = createVfxRenderInspectSnapshot({
      topology: 'beam',
      capacity: 12,
      produced: 6,
      dropped: 1,
      stageReadiness: [{ id: 'turbulence', state: 'ready', generation: 3 }],
      providerReadiness: { ok: true, value: { generation: 3, resources: [] } },
      gpuTiming: { frameMs: 0.8, samples: 8 },
    });

    expect(snapshot).toEqual(
      expect.objectContaining({
        topology: 'beam',
        counters: { capacity: 12, produced: 6, dropped: 1 },
        stageReadiness: expect.arrayContaining([expect.objectContaining({ id: 'turbulence' })]),
        providerReadiness: { ok: true, value: { generation: 3, resources: [] } },
        gpuTiming: { frameMs: 0.8, samples: 8 },
      }),
    );
  });
});

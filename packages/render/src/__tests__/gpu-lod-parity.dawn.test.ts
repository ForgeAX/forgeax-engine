import { describe, expect, it } from 'vitest';
import { buildGpuLodRows, encodeGpuLodRows } from '../scene/visibility/gpu-lod';
import { runGpuLodDawnEvidence } from './gpu-lod-evidence';

describe('GPU LOD Dawn byte parity', () => {
  it('defines the byte artifact consumed by the real Dawn readback gate', () => {
    const rows = buildGpuLodRows({
      generation: 19,
      hysteresis: 0.08,
      ranges: [
        { firstIndex: 0, indexCount: 96, baseVertex: 0 },
        { firstIndex: 96, indexCount: 48, baseVertex: 0 },
      ],
      coverages: [1, 0.5],
      ready: [true, true],
    });
    const bytes = encodeGpuLodRows(rows);
    expect(Array.from(bytes.slice(0, 8))).toEqual([19, 0, 0, 0, 0, 0, 0, 0]);
    expect(bytes.byteLength).toBe(64);
  });

  it('matches CPU bytes after a real queue copy and mapped readback', async () => {
    const evidence = await runGpuLodDawnEvidence();
    expect(evidence.status).toBe('available');
    if (evidence.status === 'unavailable') return;
    expect(evidence.dawnBytes).toEqual(evidence.cpuBytes);
    expect(evidence.identity.view).toContain('lod-evidence-view');
  });
});

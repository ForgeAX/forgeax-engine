import { describe, expect, it } from 'vitest';
import { runComputeJob } from '../compute/job';
import { tsSkinBackend } from '../compute/skin-ts';
import { encodeSnapshot } from '../fxem';
import { model } from '../model';

const maxRssMb = () => process.resourceUsage().maxRSS / 1024;

describe('skin.bind meters memory before allocating it', () => {
  it('skin.bind fails on a small budget without allocating the dense vertex x bone weights', () => {
    const m = model();
    m.sphere({ radius: 1, widthSegments: 120, heightSegments: 120 });
    const bones = Array.from({ length: 2000 }, (_, i) => ({
      root: [Math.sin(i) * 0.5, Math.cos(i * 0.7) * 0.5, Math.sin(i * 1.3) * 0.5] as [
        number,
        number,
        number,
      ],
      tips: [] as [number, number, number][],
    }));
    const dense = (m.editMesh.vertexCount * bones.length * 8) / 1e6;
    const inputs = [encodeSnapshot(m.editMesh)];
    const before = maxRssMb();
    const r = runComputeJob(
      {
        kind: 'skin.bind' as const,
        inputs,
        params: {
          bones,
          resolution: 4,
          stiffness: 0.2,
          smoothing: 0,
          smoothingStrength: 0.5,
          maxInfluences: 4,
          prune: 0,
        },
      },
      tsSkinBackend,
      { budget: 2_000_000 },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('model-work-budget');
    expect(dense).toBeGreaterThan(200);
    expect(maxRssMb() - before).toBeLessThan(dense / 2);
  });
});

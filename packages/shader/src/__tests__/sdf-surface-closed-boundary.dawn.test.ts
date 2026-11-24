import { expect, it } from 'vitest';
import { runSurfaceBufferWork } from '../../../render/src/__tests__/raytracing/sdf-surface-intersection.fixture';
import { compileShader } from '../../../shader-compiler/src/index';
import {
  assessClosedBoundary,
  closedBoundaryCases,
  closedBoundaryInput,
  closedBoundaryVariants,
} from './sdf-surface-closed-boundary.fixture';

it('certifies closed triangle edges without accepting an exterior or uncertain interval', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Actual closed-boundary adapter required');
  const device = await adapter.requestDevice();
  try {
    for (const variant of closedBoundaryVariants()) {
      const code = (await compileShader(variant.source, { id: variant.name })).unwrap().wgsl;
      const raw = await runSurfaceBufferWork(
        device,
        code,
        closedBoundaryInput(),
        'closedBoundary',
        closedBoundaryCases().length,
        16,
      );
      const assessment = assessClosedBoundary(raw);
      if (variant.negative) expect(assessment.failures.length).toBeGreaterThan(0);
      else expect(assessment.failures).toEqual([]);
    }
  } finally {
    device.destroy();
  }
}, 60_000);

import { expect, it } from 'vitest';
import { verifyPostProcessDepth } from './post-process-depth.gpu-fixture';

it('keeps real after-tonemap geometry coverage stable through 60 TAA frames per projection', async () => {
  expect(await verifyPostProcessDepth()).toHaveLength(2);
}, 120_000);

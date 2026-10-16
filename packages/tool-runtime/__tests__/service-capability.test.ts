import { describe, expect, it } from 'vitest';
import { createServiceCapability } from '../src/capability.js';

const expected = {
  toolId: 'project.preview',
  descriptorDigest: 'sha256:descriptor',
  recipeDigest: 'sha256:recipe',
  workloadClass: 'preview.real-project-webgpu',
  codeDigest: 'sha256:code',
  browserVersion: 'Chromium 140',
  backend: 'webgpu' as const,
};

describe('service capability contract', () => {
  it('keeps an absent service explicit and serializable', () => {
    expect(createServiceCapability(undefined, expected)).toEqual({
      available: false,
      code: 'tool-service-capability-absent',
      expected: 'an admitted acceleration service',
      hint: 'Use the private executor and rerun benchmark admission before enabling service.',
      detail: { reason: 'no workload-scoped admission report was supplied' },
    });
  });
});

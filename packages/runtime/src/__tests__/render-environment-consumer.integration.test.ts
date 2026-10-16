import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const environmentSource = readFileSync(
  fileURLToPath(new URL('../../../render/src/extract/environment.ts', import.meta.url)),
  'utf8',
);
const vfxSource = readFileSync(
  fileURLToPath(
    new URL('../../../vfx-render/src/feature/gpu-particle-feature.ts', import.meta.url),
  ),
  'utf8',
);

describe('runtime Environment consumer ownership', () => {
  it('consumes extracted Environment facts without a second Fog resource topology', () => {
    expect(environmentSource).toContain('createEnvironmentExtractionContext');
    expect(environmentSource).not.toContain('createFullscreenRenderFeature');
    expect(vfxSource).not.toMatch(/fog.*(history|counter|upload)/i);
  });

  it('indexes the public recovery sequence without exposing graph or device state', () => {
    const runtimeReadme = readFileSync(
      fileURLToPath(new URL('../../README.md', import.meta.url)),
      'utf8',
    );
    expect(runtimeReadme).toContain('inspect()');
    expect(runtimeReadme).toContain('typed `detail`');
    expect(runtimeReadme).toMatch(/retry the same\s+request/);
    expect(runtimeReadme).toContain('graph, device, or');
  });
});

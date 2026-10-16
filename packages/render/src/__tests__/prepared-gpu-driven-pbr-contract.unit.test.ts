import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const extractSource = readFileSync(
  fileURLToPath(new URL('../extract/gpu-driven.ts', import.meta.url)),
  'utf8',
);
const shaderArtifactSource = readFileSync(
  fileURLToPath(new URL('../../../shader/src/material/artifact-types.ts', import.meta.url)),
  'utf8',
);

describe('prepared GPU-driven Standard PBR contract', () => {
  it('requires one receipt to expose direct and scene-index entries', () => {
    expect(shaderArtifactSource).toContain('direct');
    expect(shaderArtifactSource).toContain('sceneIndex');
    expect(shaderArtifactSource).toContain('materialRow');
    expect(shaderArtifactSource).toContain('resourceSlots');
  });

  it('keeps the ABI facts explicit instead of inferring them from shader names', () => {
    for (const field of ['uvSets', 'vertexInputs', 'alphaMask', 'reflection', 'generation']) {
      expect(shaderArtifactSource, `artifact must expose ${field}`).toContain(field);
    }
    expect(extractSource).toContain('PreparedGpuDrivenDraw');
    expect(extractSource).toContain('GpuDrivenPreparationError');
  });

  it.each([
    ['missing UV', 'uv'],
    ['reflection mismatch', 'reflection'],
    ['vertex semantic mismatch', 'vertex'],
    ['missing alpha mask subset', 'alpha'],
    ['stale generation', 'generation'],
  ])('has a named rejection path for %s', (_label, token) => {
    expect(extractSource.toLowerCase()).toContain(token);
  });
});

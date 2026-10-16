import { describe, expect, it } from 'vitest';
import {
  makeShaderPreviewKey,
  type ShaderPreviewSelection,
  selectedRasterStages,
  validateShaderPreviewSelection,
} from '../shader-preview/session';

const rasterSelection: ShaderPreviewSelection = {
  tapeDigest: 'sha256:tape',
  workIndex: 2,
  stage: 'fragment',
  shaderModuleId: 'shader:fragment',
  entryPoint: 'fs_main',
  source: '@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0); }',
  pipelineKind: 'render',
};

describe('shader preview contract', () => {
  it('keys editor state by tape, work, stage, and module identity', () => {
    const key = makeShaderPreviewKey(rasterSelection);
    expect(key).toBe('sha256:tape/2/fragment/shader:fragment');
    expect(makeShaderPreviewKey({ ...rasterSelection, workIndex: 3 })).not.toBe(key);
    expect(makeShaderPreviewKey({ ...rasterSelection, shaderModuleId: 'shader:other' })).not.toBe(
      key,
    );
  });

  it.each([
    ['compute', { ...rasterSelection, pipelineKind: 'compute' as const }],
    ['missing stage', { ...rasterSelection, stage: null }],
    ['no entry', { ...rasterSelection, entryPoint: null }],
  ])('rejects %s as preview-not-applicable', (_name, selection) => {
    const result = validateShaderPreviewSelection(selection);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('preview-not-applicable');
  });

  it('keeps preview provenance and canonical facts distinguishable', () => {
    const result = validateShaderPreviewSelection(rasterSelection);
    expect(result).toEqual({ ok: true, value: rasterSelection });
    if (result.ok) {
      const preview = { ...result.value, provenance: 'preview' as const, generation: 1 };
      expect(preview.provenance).toBe('preview');
      expect(preview).not.toHaveProperty('tape');
      expect(preview).not.toHaveProperty('model');
      expect(preview).not.toHaveProperty('session');
    }
  });

  it('rejects a selected shader without the other canonical raster stage', () => {
    const result = selectedRasterStages(rasterSelection);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('preview-pipeline-incompatible');

    const incomplete = selectedRasterStages({
      ...rasterSelection,
      stages: {
        fragment: {
          source: rasterSelection.source,
          entryPoint: rasterSelection.entryPoint,
        },
      },
    });
    expect(incomplete.ok).toBe(false);
    if (!incomplete.ok) expect(incomplete.error.code).toBe('preview-pipeline-incompatible');

    const paired = selectedRasterStages({
      ...rasterSelection,
      stages: {
        vertex: {
          source:
            '@vertex fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(0.0); }',
          entryPoint: 'vs_main',
        },
      },
    });
    expect(paired.ok).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { previewError } from '../shader-preview/errors';
import {
  initialShaderPreviewState,
  reduceShaderPreview,
  type ShaderPreviewAction,
} from '../shader-preview/reducer';
import { ShaderPreviewSession } from '../shader-preview/session';

describe('shader preview lifecycle reducer', () => {
  it('drops stale generations and never publishes a success canvas for them', () => {
    let state = initialShaderPreviewState();
    state = reduceShaderPreview(state, { type: 'apply-start', generation: 2 });
    state = reduceShaderPreview(state, {
      type: 'apply-success',
      generation: 1,
      provenance: 'preview',
      pixels: new Uint8Array([255, 0, 0, 255]),
    });
    expect(state.status).toBe('applying');
    expect(state.preview).toBeNull();
  });

  it('clears preview on Reset and records abort as a structured terminal state', () => {
    let state = initialShaderPreviewState();
    const actions: ShaderPreviewAction[] = [
      { type: 'apply-start', generation: 1 },
      {
        type: 'apply-success',
        generation: 1,
        provenance: 'preview',
        pixels: new Uint8Array([1, 2, 3, 4]),
      },
      { type: 'reset', generation: 2 },
      { type: 'apply-start', generation: 3 },
      {
        type: 'apply-error',
        generation: 3,
        error: previewError('preview-aborted', 'cancelled', 'apply the current selection again'),
      },
    ];
    for (const action of actions) state = reduceShaderPreview(state, action);
    expect(state.status).toBe('error');
    expect(state.preview).toBeNull();
    expect(state.error?.code).toBe('preview-aborted');
  });

  it('aborts the viewer-private session without changing the selection facts', async () => {
    const session = new ShaderPreviewSession();
    const selection = {
      tapeDigest: 'sha256:stable',
      workIndex: 0,
      stage: 'fragment' as const,
      shaderModuleId: 'shader:fragment',
      entryPoint: 'main',
      source: '@fragment fn main() -> @location(0) vec4f { return vec4f(1.0); }',
      pipelineKind: 'render' as const,
    };
    const before = JSON.stringify(selection);
    const result = await session.apply(selection, selection.source, { webgpuAvailable: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('preview-not-applicable');
    session.dispose();
    expect(JSON.stringify(selection)).toBe(before);
  });
});

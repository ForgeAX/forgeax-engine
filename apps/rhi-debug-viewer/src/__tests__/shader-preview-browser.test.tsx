import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CodeMirrorShader } from '../components/CodeMirrorShader';

const selection = {
  tapeDigest: 'sha256:browser',
  workIndex: 1,
  stage: 'fragment' as const,
  shaderModuleId: 'shader:browser',
  entryPoint: 'fs_main',
  source: '@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0); }',
  pipelineKind: 'render' as const,
};

describe('shader preview browser boundary', () => {
  it('keeps the editor viewer-only and reports unavailable preview without a success canvas', async () => {
    const { container } = render(<CodeMirrorShader selection={selection} />);
    expect(container.querySelector('[data-forgeax-shader-editor]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: /Apply/ }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('preview-not-applicable'),
    );
    expect(container.querySelector('[data-forgeax-preview-canvas]')).toBeNull();
    expect(container.textContent).toContain(
      'No tape, model, replay, or canonical pixels are written.',
    );
  });
});

import type { Renderer } from '@forgeax/engine-render';
import { describe, expect, it, vi } from 'vitest';
import { applyRendererOrderDiagnostic } from '../execution/renderer-order-diagnostic';

describe('execution startup ordering diagnostic', () => {
  it.each([
    false,
    true,
  ])('applies explicit read-only depth experiment %s without replacing other profile fields', (enabled) => {
    const profile = {
      pipelineId: 'forgeax::standard',
      renderPath: 'deferred',
      ssao: true,
      lightCount: 256,
    };
    const inspect = vi.fn(() => ({ profile })),
      setProfile = vi.fn(() => ({ ok: true, value: undefined }));
    applyRendererOrderDiagnostic(
      { inspect, setProfile } as unknown as Renderer,
      undefined,
      enabled,
    );
    expect(setProfile).toHaveBeenCalledWith({
      ...profile,
      featureReadOnlyDepthBatchDiagnostic: enabled,
    });
    expect(profile).not.toHaveProperty('featureReadOnlyDepthBatchDiagnostic');
  });
  it('does nothing, including no inspection, when absent', () => {
    const inspect = vi.fn(),
      setProfile = vi.fn();
    applyRendererOrderDiagnostic({ inspect, setProfile } as unknown as Renderer, undefined);
    expect(inspect).not.toHaveBeenCalled();
    expect(setProfile).not.toHaveBeenCalled();
  });
  it('merges into the actual project-selected profile and preserves Renderer validation errors', () => {
    const profile = {
      pipelineId: 'forgeax::standard',
      renderPath: 'deferred',
      ssao: { enabled: true },
      lightCount: 256,
    };
    const config = { order: 'near' as const, programDigests: [`sha256:${'a'.repeat(64)}`] };
    const inspect = vi.fn(() => ({ profile })),
      setProfile = vi.fn(() => ({ ok: true, value: undefined }));
    const renderer = { inspect, setProfile } as unknown as Renderer;
    applyRendererOrderDiagnostic(renderer, config);
    expect(setProfile).toHaveBeenCalledWith({ ...profile, gbufferBatchOrderDiagnostic: config });
    expect(profile).not.toHaveProperty('gbufferBatchOrderDiagnostic');
    const failure = Error('validation failed');
    setProfile.mockReturnValue({ ok: false, error: failure } as never);
    expect(() => applyRendererOrderDiagnostic(renderer, config)).toThrow(failure);
  });
});

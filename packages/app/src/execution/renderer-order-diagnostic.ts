import type { Renderer, RenderProfile } from '@forgeax/engine-render';

/** Startup only, after project configuration; the existing Renderer validates the full profile. */
export function applyRendererOrderDiagnostic(
  renderer: Pick<Renderer, 'inspect' | 'setProfile'>,
  diagnostic: RenderProfile['gbufferBatchOrderDiagnostic'],
  featureReadOnlyDepthBatchDiagnostic?: boolean,
): void {
  if (diagnostic === undefined && featureReadOnlyDepthBatchDiagnostic === undefined) return;
  const applied = renderer.setProfile({
    ...renderer.inspect().profile,
    ...(diagnostic === undefined ? {} : { gbufferBatchOrderDiagnostic: diagnostic }),
    ...(featureReadOnlyDepthBatchDiagnostic === undefined
      ? {}
      : { featureReadOnlyDepthBatchDiagnostic }),
  });
  if (!applied.ok) throw applied.error;
}

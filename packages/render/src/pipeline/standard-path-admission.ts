import { RenderGraphError } from '@forgeax/engine-render-graph';
import { type Antialias, isMultisampleAntialias } from '../components/camera';

/** Shared by public view admission and direct Standard graph construction. */
export function standardDeferredAntialiasError(
  antialias: Antialias | undefined,
): RenderGraphError | undefined {
  if (!isMultisampleAntialias(antialias)) return undefined;
  return new RenderGraphError({
    code: 'resource-descriptor-invalid',
    expected: 'Standard Deferred uses single-sample geometry',
    hint: 'select Forward or auto for MSAA; select FXAA, SMAA, TAA or TSR for Deferred',
    detail: {
      resourceLabel: 'forgeax::standard',
      field: 'camera.antialias',
      expected: 'single-sample antialias mode for Deferred',
      actual: antialias,
    },
  });
}

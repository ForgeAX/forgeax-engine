import type { RendererOptions } from '@forgeax/engine-render';

/** App options or realm init messages that may carry the renderer backend preference. */
interface RenderBackendCarrier {
  readonly renderBackend?: RendererOptions['renderBackend'];
}

/** Forward the carried backend preference into the next realm's init message. */
export function forwardRenderBackend(carrier: RenderBackendCarrier): {
  readonly renderBackend?: NonNullable<RendererOptions['renderBackend']>;
} {
  return carrier.renderBackend === undefined ? {} : { renderBackend: carrier.renderBackend };
}

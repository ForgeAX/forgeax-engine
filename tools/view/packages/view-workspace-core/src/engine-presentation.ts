import type { EngineWorkspacePresentation } from '@forgeax/engine/app';
import type { Context } from '@forgeax/engine-plugin';
export type PreviewOwner = { panelId: string; pageType: string };
export type ViewPresentation = Omit<EngineWorkspacePresentation, 'attach'> & { owner?: PreviewOwner; attach?: (input: Parameters<NonNullable<EngineWorkspacePresentation['attach']>>[0] & { owner?: PreviewOwner }) => ReturnType<NonNullable<EngineWorkspacePresentation['attach']>> };
export type PresentationConfig = { presentation?: ViewPresentation; targetPresentation?: ViewPresentation };

export function readEnginePresentation(config: PresentationConfig = {}, ctx?: Context): ViewPresentation | undefined {
  return config.presentation
    ?? config.targetPresentation
    ?? (ctx?.get?.('engineWorkspacePresentation', false) || undefined);
}

/** Resolve Engine presentation at call time so either side can appear first. */
export function liveEnginePresentation(ctx: Context, config: PresentationConfig = {}): ViewPresentation {
  const read = () => readEnginePresentation(config, ctx);
  return {
    get surfacePlacement() {
      return read()?.surfacePlacement;
    },
    createSurface(input) {
      return read()?.createSurface?.(input);
    },
    attach(input) {
      return read()?.attach?.(input);
    },
    detach(input) {
      return read()?.detach?.(input);
    },
  };
}

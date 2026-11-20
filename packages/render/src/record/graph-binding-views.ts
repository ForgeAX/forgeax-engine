import type { CompiledRenderGraph, GraphTextureView } from '@forgeax/engine-render-graph';
import type { TextureView } from '@forgeax/engine-rhi';
import type { RenderPipelineFrame } from '../render-pipeline';

type GraphBindingViewRole = 'backdrop' | 'raw-depth' | 'nearest-layer' | 'nearest-depth' | 'ssao';

/** Borrowed fixed graph allocations; never a frame resolver or a resource lease. */
export interface GraphBindingViews {
  readonly graph: CompiledRenderGraph<RenderPipelineFrame>;
  readonly views: readonly (readonly [GraphBindingViewRole, GraphTextureView, TextureView])[];
}

export function graphBindingViewsCurrent(facts: GraphBindingViews): boolean {
  return (
    facts.views.length > 0 &&
    facts.views.every(([_role, port, view]) => facts.graph.createdTextureView(port) === view)
  );
}

/** Every native view requested by the consumer must have the matching semantic port. */
export function graphBindingViewsMatch(
  facts: GraphBindingViews | undefined,
  inputs: readonly (readonly [GraphBindingViewRole, TextureView | null | undefined])[],
): boolean {
  const bound = inputs.filter(([, view]) => view != null);
  if (facts === undefined) return bound.length === 0;
  return (
    bound.length === facts.views.length &&
    bound.every(
      ([role, view], index) => facts.views[index]?.[0] === role && facts.views[index]?.[2] === view,
    ) &&
    graphBindingViewsCurrent(facts)
  );
}

export function sameGraphBindingViews(
  a: GraphBindingViews | undefined,
  b: GraphBindingViews | undefined,
): boolean {
  return (
    a === b ||
    (a !== undefined &&
      b !== undefined &&
      a.graph === b.graph &&
      a.views.length === b.views.length &&
      a.views.every(([role, port, view], index) => {
        const other = b.views[index];
        return other !== undefined && other[0] === role && other[1] === port && other[2] === view;
      }))
  );
}

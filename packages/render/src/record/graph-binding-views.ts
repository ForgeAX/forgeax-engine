import type { CompiledRenderGraph, GraphTextureView } from '@forgeax/engine-render-graph';
import type { TextureView } from '@forgeax/engine-rhi';
import type { RenderPipelineFrame } from '../render-pipeline';

type GraphBindingViewRole = 'backdrop' | 'raw-depth' | 'nearest-layer' | 'nearest-depth' | 'ssao';

/** A private pass operand retains its physical view only while its owning image is live. */
export interface NativeMaterialView {
  readonly view: TextureView;
  currentTextureView(): TextureView | undefined;
}

type BindingPort = GraphTextureView | NativeMaterialView;

function viewAt(facts: GraphBindingViews, port: BindingPort): TextureView | undefined {
  return 'currentTextureView' in port
    ? facts.graph.isRetired()
      ? undefined
      : port.currentTextureView()
    : facts.graph.createdTextureView(port);
}

/** Borrowed fixed graph allocations; never a frame resolver or a resource lease. */
export interface GraphBindingViews {
  readonly graph: CompiledRenderGraph<RenderPipelineFrame>;
  readonly views: readonly (readonly [GraphBindingViewRole, BindingPort, TextureView])[];
}

export function graphBindingViewsCurrent(facts: GraphBindingViews): boolean {
  return (
    facts.views.length > 0 &&
    facts.views.every(([_role, port, view]) => viewAt(facts, port) === view)
  );
}

type MaterialView = TextureView | null | undefined;

function currentSlot(
  facts: GraphBindingViews | undefined,
  index: number,
  role: GraphBindingViewRole,
  view: TextureView,
): boolean {
  const slot = facts?.views[index];
  return (
    slot !== undefined &&
    slot[0] === role &&
    slot[2] === view &&
    facts !== undefined &&
    viewAt(facts, slot[1]) === view
  );
}

/** Compare the draw's four physical material inputs in their declared order.
 * The scalar operands belong to the draw. Only actual graph inputs read an owner. */
export function materialBindingViewsCurrent(
  facts: GraphBindingViews | undefined,
  backdrop: MaterialView,
  rawDepth: MaterialView,
  nearestLayer: MaterialView,
  nearestDepth: MaterialView,
): boolean {
  let index = 0;
  if (backdrop != null && !currentSlot(facts, index++, 'backdrop', backdrop)) return false;
  if (rawDepth != null && !currentSlot(facts, index++, 'raw-depth', rawDepth)) return false;
  if (nearestLayer != null && !currentSlot(facts, index++, 'nearest-layer', nearestLayer))
    return false;
  if (nearestDepth != null && !currentSlot(facts, index++, 'nearest-depth', nearestDepth))
    return false;
  return facts === undefined ? index === 0 : index > 0 && index === facts.views.length;
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

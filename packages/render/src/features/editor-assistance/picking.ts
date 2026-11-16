import type { EditorAssistanceHit } from './projection';
import type { EditorAssistanceAction } from './state';

/** Bounded detached metadata issued only for a submitted assistance frame. */
export interface SubmittedEditorAssistanceFrame {
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly sourceIdentity: string;
  readonly sourceMutationEpoch: number;
  readonly revision: number;
  readonly views: readonly {
    readonly identity: string;
    readonly width: number;
    readonly height: number;
    readonly hits: readonly EditorAssistanceHit[];
  }[];
}
export interface EditorAssistancePickRequest {
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly sourceIdentity: string;
  readonly sourceMutationEpoch: number;
  readonly viewIdentity: string;
  /** Physical pixels in the submitted scene view, after display-warp inversion. */
  readonly x: number;
  readonly y: number;
}
export type EditorAssistancePick =
  | { readonly status: 'hit'; readonly action: EditorAssistanceAction }
  | { readonly status: 'miss' }
  | {
      readonly status: 'unavailable';
      readonly reason:
        | 'missing-frame'
        | 'stale-frame'
        | 'missing-view'
        | 'invalid-position'
        | 'depth-not-observed';
    };

function contains(triangle: EditorAssistanceHit['triangle'], x: number, y: number): boolean {
  const [ax, ay, bx, by, cx, cy] = triangle;
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (Math.abs(area) < 1e-8) return false;
  const u = ((bx - x) * (cy - y) - (by - y) * (cx - x)) / area;
  const v = ((cx - x) * (ay - y) - (cy - y) * (ax - x)) / area;
  return u >= 0 && v >= 0 && u + v <= 1;
}
/** Never consults latest World poses or waits for the GPU from an input handler. */
export function pickSubmittedEditorAssistance(
  frame: SubmittedEditorAssistanceFrame | undefined,
  request: EditorAssistancePickRequest,
): EditorAssistancePick {
  if (frame === undefined) return { status: 'unavailable', reason: 'missing-frame' };
  if (
    frame.frameId !== request.frameId ||
    frame.deviceGeneration !== request.deviceGeneration ||
    frame.sourceIdentity !== request.sourceIdentity ||
    frame.sourceMutationEpoch !== request.sourceMutationEpoch
  )
    return { status: 'unavailable', reason: 'stale-frame' };
  const view = frame.views.find((view) => view.identity === request.viewIdentity);
  if (view === undefined) return { status: 'unavailable', reason: 'missing-view' };
  if (
    !Number.isFinite(request.x) ||
    !Number.isFinite(request.y) ||
    request.x < 0 ||
    request.y < 0 ||
    request.x >= view.width ||
    request.y >= view.height
  )
    return { status: 'unavailable', reason: 'invalid-position' };
  for (const kind of ['gizmo', 'entity'] as const) {
    // The last drawn helper wins within a priority class.
    for (let index = view.hits.length - 1; index >= 0; index--) {
      const hit = view.hits[index] as EditorAssistanceHit;
      if (hit.action.kind !== kind || !contains(hit.triangle, request.x, request.y)) continue;
      if (hit.depth === 'occluded') return { status: 'unavailable', reason: 'depth-not-observed' };
      return { status: 'hit', action: hit.action };
    }
  }
  return { status: 'miss' };
}

const ownedFrames = new WeakSet<SubmittedEditorAssistanceFrame>();
const ownedViews = new WeakSet<SubmittedEditorAssistanceFrame['views']>();
/** Re-establish immutability after structured cloning, without copying owned frames again. */
export function freezeSubmittedEditorAssistanceFrame(
  frame: SubmittedEditorAssistanceFrame,
): SubmittedEditorAssistanceFrame {
  if (ownedFrames.has(frame)) return frame;
  const fixed: SubmittedEditorAssistanceFrame = Object.freeze({
    ...frame,
    views: ownedViews.has(frame.views)
      ? frame.views
      : Object.freeze(
          frame.views.map((view) =>
            Object.freeze({
              ...view,
              hits: Object.freeze(
                view.hits.map((hit) =>
                  Object.freeze({
                    ...hit,
                    action: Object.freeze({ ...hit.action }),
                    triangle: Object.freeze([...hit.triangle]) as EditorAssistanceHit['triangle'],
                  }),
                ),
              ),
            }),
          ),
        ),
  });
  ownedViews.add(fixed.views);
  ownedFrames.add(fixed);
  return fixed;
}

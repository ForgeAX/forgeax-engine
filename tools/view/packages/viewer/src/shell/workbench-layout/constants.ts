import type { WorkbenchEdge, WorkbenchStage } from './types.ts';

/** Left / right / bottom edge sidebars managed by one Dockview instance. */
export const WORKBENCH_EDGES = Object.freeze(['left', 'right', 'bottom'] as const satisfies readonly WorkbenchEdge[]);
export const PAGE_WORKBENCH_EDGES = Object.freeze(['left', 'right'] as const satisfies readonly WorkbenchEdge[]);

export const EDGE_GROUP_ID = Object.freeze({
  left: 'fx-edge-left',
  right: 'fx-edge-right',
  bottom: 'fx-edge-bottom',
} as const);

/** Width pressure: tuck left/right peripherals */
export const WIDTH_ENTER_TUCK = 1280;
export const WIDTH_EXIT_TUCK = 1360;
/** Height pressure: tuck bottom peripherals */
export const HEIGHT_ENTER_TUCK = 740;
export const HEIGHT_EXIT_TUCK = 800;
/** Both axes must pass these to tuck all three sides */
export const WIDTH_ENTER_ALL = 1080;
export const HEIGHT_ENTER_ALL = 700;
export const WIDTH_EXIT_ALL = 1100;
export const HEIGHT_EXIT_ALL = 720;

export const EDGE_DEFAULT_PX = Object.freeze({
  left: 260,
  right: 280,
  bottom: 280,
});

/** Open flyout size when no user resize var is set (interface edgeDrawer readSize / CSS fallback). */
export const EDGE_DRAWER_OPEN_DEFAULT_PX = 300;

export const EDGE_DRAWER_SIZE_MIN_PX = 160;
export const EDGE_DRAWER_SIZE_MAX_PX = 900;

export const DEFAULT_COLLAPSED_SIZE = 32;

export function stageFromTargetSides(sides: readonly WorkbenchEdge[]): WorkbenchStage {
  if (sides.length === 0) return 'wide';
  if (sides.includes('bottom') && sides.includes('left') && sides.includes('right')) return 'narrow';
  return 'compact';
}

function sideSet(sides: readonly WorkbenchEdge[]) {
  return new Set(sides);
}

/**
 * 2D tuck profile with per-axis hysteresis.
 * Height tight alone → bottom; width tight alone → left+right; both all-thresholds → three sides.
 */
export function resolveTargetSides(
  width: number,
  height: number,
  active: readonly WorkbenchEdge[],
  edges: readonly WorkbenchEdge[] = WORKBENCH_EDGES,
): readonly WorkbenchEdge[] {
  const allowed = sideSet(edges);
  const was = sideSet(active.filter((side) => allowed.has(side)));

  const widthAll = was.has('left')
    ? width < WIDTH_EXIT_ALL
    : width < WIDTH_ENTER_ALL;
  const heightAll = was.has('bottom')
    ? height < HEIGHT_EXIT_ALL
    : height < HEIGHT_ENTER_ALL;
  const allThree = allowed.has('left') && allowed.has('right') && allowed.has('bottom')
    && widthAll && heightAll;

  const heightTight = allowed.has('bottom') && (was.has('bottom')
    ? height < HEIGHT_EXIT_TUCK
    : height < HEIGHT_ENTER_TUCK);
  const widthTight = was.has('left')
    ? width < WIDTH_EXIT_TUCK
    : width < WIDTH_ENTER_TUCK;

  const next = new Set<WorkbenchEdge>();
  if (allThree) {
    next.add('bottom');
    next.add('left');
    next.add('right');
  } else {
    if (heightTight) next.add('bottom');
    if (widthTight && allowed.has('left')) {
      next.add('left');
      if (allowed.has('right')) next.add('right');
    }
  }

  const order: WorkbenchEdge[] = ['bottom', 'left', 'right'];
  return order.filter((s) => allowed.has(s) && next.has(s));
}

export function targetSidesEqual(a: readonly WorkbenchEdge[], b: readonly WorkbenchEdge[]) {
  return a.length === b.length && a.every((s) => b.includes(s));
}

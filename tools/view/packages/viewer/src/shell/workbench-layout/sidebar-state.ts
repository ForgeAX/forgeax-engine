import {
  resolveTargetSides,
  stageFromTargetSides,
  targetSidesEqual,
} from './constants.ts';
import type {
  WorkbenchEdge,
  WorkbenchSidebarEvent,
  WorkbenchSidebarState,
  WorkbenchStage,
} from './types.ts';

export function isWorkbenchEdge(value: unknown): value is import('./types.ts').WorkbenchEdge {
  return value === 'left' || value === 'right' || value === 'bottom';
}

export function createWorkbenchSidebarState(stage: WorkbenchStage = 'wide'): WorkbenchSidebarState {
  return {
    stage,
    targetSides: [],
    baselineSnapshot: null,
    autoTucked: {},
  };
}

export function resolveWorkbenchStage(
  width: number,
  height: number,
  current: WorkbenchSidebarState,
): { ignored: true } | { ignored: false; stage: WorkbenchStage; targetSides: readonly WorkbenchEdge[] } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { ignored: true };
  }

  const targetSides = resolveTargetSides(width, height, current.targetSides);
  const stage = stageFromTargetSides(targetSides);

  if (targetSidesEqual(targetSides, current.targetSides) && stage === current.stage) {
    return { ignored: true };
  }

  return { ignored: false, stage, targetSides };
}

export function reduceWorkbenchSidebar(
  state: WorkbenchSidebarState | null | undefined,
  event: WorkbenchSidebarEvent,
): WorkbenchSidebarState {
  const current = state ?? createWorkbenchSidebarState();

  if (event.type === 'auto-tucked') {
    return { ...current, autoTucked: event.autoTucked };
  }

  if (event.type === 'profile') {
    return {
      stage: event.stage,
      targetSides: [...event.targetSides],
      baselineSnapshot: event.baselineSnapshot !== undefined
        ? event.baselineSnapshot
        : current.baselineSnapshot,
      autoTucked: event.autoTucked !== undefined ? event.autoTucked : current.autoTucked,
    };
  }

  return current;
}

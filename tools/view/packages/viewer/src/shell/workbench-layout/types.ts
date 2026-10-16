import type { AutoTuckedMap, PresentationSnapshot } from './grid-layout-migration.ts';

export type WorkbenchEdge = 'left' | 'right' | 'bottom';
export type WorkbenchStage = 'wide' | 'compact' | 'narrow';

export type WorkbenchSidebarState = {
  /** Derived label for UI/debug; migration uses `targetSides`. */
  stage: WorkbenchStage;
  targetSides: readonly WorkbenchEdge[];
  baselineSnapshot: PresentationSnapshot | null;
  autoTucked: AutoTuckedMap;
};

export type WorkbenchSidebarEvent =
  | {
      type: 'profile';
      stage: WorkbenchStage;
      targetSides: readonly WorkbenchEdge[];
      baselineSnapshot?: PresentationSnapshot | null;
      autoTucked?: AutoTuckedMap;
    }
  | { type: 'auto-tucked'; autoTucked: AutoTuckedMap };

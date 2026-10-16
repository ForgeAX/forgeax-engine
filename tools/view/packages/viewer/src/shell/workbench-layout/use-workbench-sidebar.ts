import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';

import { applySidebarLayout } from './apply-sidebar-layout.ts';
import type { EdgeDrawerController } from './edge-drawer.ts';
import { applyStageMigration } from './grid-layout-migration.ts';
import {
  resolveTargetSides,
  stageFromTargetSides,
  targetSidesEqual,
} from './constants.ts';
import {
  createWorkbenchSidebarState,
  reduceWorkbenchSidebar,
  resolveWorkbenchStage,
} from './sidebar-state.ts';
import type { WorkbenchSidebarEvent, WorkbenchSidebarState } from './types.ts';

function asState(value: unknown): WorkbenchSidebarState {
  return value as WorkbenchSidebarState;
}

function validHostSize(width: number, height: number) {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
}

/** Profile already matches the resolved tuck intent for this host size. */
function profileMatchesResolvedSize(
  current: WorkbenchSidebarState,
  width: number,
  height: number,
) {
  const targetSides = resolveTargetSides(width, height, current.targetSides);
  const stage = stageFromTargetSides(targetSides);
  return targetSidesEqual(targetSides, current.targetSides) && stage === current.stage;
}

export function useWorkbenchSidebar({
  workbenchRef,
  dockHostRef,
  apiRef,
  layoutReady,
  presentationReady,
  edgeDrawerRef,
  responsiveAutoTuck = true,
}: {
  workbenchRef: RefObject<HTMLElement | null>;
  dockHostRef: RefObject<HTMLElement | null>;
  apiRef: RefObject<{ groups?: readonly unknown[]; layout?: (width: number, height: number) => void } | null>;
  layoutReady: boolean;
  /** Bumped after the first reconcile + layout pass with a real host extent. */
  presentationReady: number;
  edgeDrawerRef: RefObject<EdgeDrawerController | null>;
  responsiveAutoTuck?: boolean;
}) {
  const [state, setState] = useState<WorkbenchSidebarState>(() => asState(createWorkbenchSidebarState()));
  const stateRef = useRef(state);
  stateRef.current = state;
  const applyingRef = useRef(false);
  const presentationReadyRef = useRef(presentationReady);
  presentationReadyRef.current = presentationReady;
  /** Grid tuck was deferred (unsettled); retry always re-measures the host. */
  const migrationRetryPendingRef = useRef(false);

  const dispatch = useCallback((event: WorkbenchSidebarEvent) => {
    setState((current) => {
      const next = reduceWorkbenchSidebar(current, event);
      stateRef.current = next;
      return next;
    });
  }, []);

  const measureHost = useCallback(() => {
    const element = dockHostRef.current ?? workbenchRef.current;
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return null;
    return rect;
  }, [dockHostRef, workbenchRef]);

  const runStageMigration = useCallback((width: number, height: number) => {
    if (!responsiveAutoTuck) return;
    if (presentationReadyRef.current <= 0) return;

    const current = stateRef.current;

    if (validHostSize(width, height) && profileMatchesResolvedSize(current, width, height)) {
      migrationRetryPendingRef.current = false;
    }

    const resolved = resolveWorkbenchStage(width, height, current);
    if (resolved.ignored) return;

    const api = apiRef.current;
    const host = dockHostRef.current ?? workbenchRef.current;
    if (!api || !host) return;

    const outcome = applyStageMigration(
      api as never,
      host,
      current.targetSides,
      resolved.targetSides,
      current.baselineSnapshot,
      current.autoTucked,
    );

    if (!outcome.applied) {
      migrationRetryPendingRef.current = true;
      return;
    }

    migrationRetryPendingRef.current = false;
    edgeDrawerRef.current?.forceClose();

    dispatch({
      type: 'profile',
      stage: resolved.stage,
      targetSides: resolved.targetSides,
      baselineSnapshot: outcome.baseline,
      autoTucked: outcome.autoTucked,
    });
  }, [apiRef, responsiveAutoTuck, dispatch, dockHostRef, edgeDrawerRef, workbenchRef]);

  const runStageMigrationAtLatestSize = useCallback(() => {
    const rect = measureHost();
    if (!rect || !validHostSize(rect.width, rect.height)) return;
    runStageMigration(rect.width, rect.height);
  }, [measureHost, runStageMigration]);

  useLayoutEffect(() => {
    if (!layoutReady || !responsiveAutoTuck) return undefined;
    const element = dockHostRef.current ?? workbenchRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;

    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      runStageMigration(rect?.width ?? 0, rect?.height ?? 0);
    });
    observer.observe(element);

    const rect = element.getBoundingClientRect();
    runStageMigration(rect.width, rect.height);

    return () => observer.disconnect();
  }, [responsiveAutoTuck, dockHostRef, layoutReady, runStageMigration, workbenchRef]);

  useLayoutEffect(() => {
    if (!layoutReady || !responsiveAutoTuck || presentationReady <= 0) return undefined;
    let cancelled = false;
    let outer = 0;
    let inner = 0;
    const schedule = (attemptsLeft: number) => {
      outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => {
          if (cancelled) return;
          runStageMigrationAtLatestSize();
          if (migrationRetryPendingRef.current && attemptsLeft > 1) {
            schedule(attemptsLeft - 1);
          }
        });
      });
    };
    schedule(4);
    return () => {
      cancelled = true;
      if (outer) cancelAnimationFrame(outer);
      if (inner) cancelAnimationFrame(inner);
    };
  }, [responsiveAutoTuck, layoutReady, presentationReady, runStageMigrationAtLatestSize]);

  useLayoutEffect(() => {
    if (!layoutReady || !responsiveAutoTuck || presentationReady <= 0) return;
    if (!migrationRetryPendingRef.current) return;
    runStageMigrationAtLatestSize();
  }, [responsiveAutoTuck, layoutReady, presentationReady, runStageMigrationAtLatestSize]);

  const applyNow = useCallback(() => {
    if (applyingRef.current) return;
    applyingRef.current = true;
    try {
      applySidebarLayout(apiRef.current);
    } finally {
      applyingRef.current = false;
    }
  }, [apiRef]);

  useLayoutEffect(() => {
    if (!layoutReady) return;
    applyNow();
  }, [applyNow, layoutReady, state.stage, state.targetSides.join(',')]);

  return {
    state,
    applyNow,
    dispatch,
  };
}

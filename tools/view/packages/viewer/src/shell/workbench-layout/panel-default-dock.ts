import type { PanelLayout } from '@forgeax/view-workspace-core/frontend-contract';
import { PANEL_LAYOUT as CONTENT_BROWSER_LAYOUT } from '@forgeax/view-plugin-content-browser/identity';
import { PANEL_LAYOUT as INSPECTOR_LAYOUT } from '@forgeax/view-plugin-inspector/identity';
import { PANEL_LAYOUT as SCENE_TREE_LAYOUT } from '@forgeax/view-plugin-scene-tree/identity';
import { PANEL_LAYOUT as VIEWPORT_LAYOUT } from '@forgeax/view-plugin-viewport/identity';

/** Stable default dock roles from plugin `PANEL_LAYOUT` (not localized titles). */
const DEFAULT_DOCK_BY_PANEL_ID: Readonly<Record<string, PanelLayout['dock']>> = Object.freeze({
  viewport: VIEWPORT_LAYOUT.dock,
  'scene-tree': SCENE_TREE_LAYOUT.dock,
  inspector: INSPECTOR_LAYOUT.dock,
  'content-browser': CONTENT_BROWSER_LAYOUT.dock,
});

export function defaultDockForPanel(panelId: string): PanelLayout['dock'] | undefined {
  return DEFAULT_DOCK_BY_PANEL_ID[panelId];
}

export function isFillCorePanel(panelId: string): boolean {
  return defaultDockForPanel(panelId) === 'fill';
}

/** Panels eligible for responsive auto-tuck (never fill/core). */
export function isAutoTuckCandidatePanel(panelId: string): boolean {
  const dock = defaultDockForPanel(panelId);
  return dock !== undefined && dock !== 'fill';
}

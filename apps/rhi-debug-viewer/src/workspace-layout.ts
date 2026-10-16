export const LAYOUT_SCHEMA_VERSION = 3;
export const LAYOUT_STORAGE_KEY = 'forgeax-rhi-debug-viewer-layout';

export const PANEL_IDS = [
  'event-browser',
  'pipeline-state',
  'draw-call-viewer',
  'resource-inspector',
] as const;

export type WorkspacePanelId = (typeof PANEL_IDS)[number];

export interface WorkspaceLayout {
  readonly schemaVersion: typeof LAYOUT_SCHEMA_VERSION;
  readonly topology: unknown;
}

export type LayoutRecoveryCode =
  | 'layout-corrupt'
  | 'layout-schema-mismatch'
  | 'layout-unknown-panel'
  | 'layout-storage-failed';

export interface LayoutRecovery {
  readonly code: LayoutRecoveryCode;
  readonly detail: string;
}

export type LayoutResult =
  | { readonly ok: true; readonly value: WorkspaceLayout }
  | {
      readonly ok: false;
      readonly error: LayoutRecovery;
    };

export interface WorkspaceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const panelIdSet = new Set<string>(PANEL_IDS);

export const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayout = {
  schemaVersion: LAYOUT_SCHEMA_VERSION,
  topology: {
    groups: [
      { id: 'events', type: 'split', direction: 'vertical', size: 0.25 },
      { id: 'draw', type: 'split', direction: 'vertical', size: 0.45 },
      { id: 'inspection', type: 'stack', size: 0.3, activePanel: 'pipeline-state' },
    ],
    panels: PANEL_IDS.map((id) => ({
      id,
      group: id === 'event-browser' ? 'events' : id === 'draw-call-viewer' ? 'draw' : 'inspection',
    })),
    activeTab: 'draw-call-viewer',
  },
};

function recovery(code: LayoutRecoveryCode, detail: string): LayoutResult {
  return { ok: false, error: { code, detail } };
}

function hasUnknownPanel(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const unknown = hasUnknownPanel(item);
      if (unknown) return unknown;
    }
    return null;
  }
  if (value === null || typeof value !== 'object') return null;

  for (const [key, child] of Object.entries(value)) {
    if (key === 'panels' || key === 'views') {
      if (Array.isArray(child)) {
        for (const panel of child) {
          if (panel && typeof panel === 'object') {
            const id = (panel as { id?: unknown }).id;
            if (typeof id === 'string' && !panelIdSet.has(id)) return id;
          }
        }
      }
    } else if (key === 'panel' || key === 'panelId' || key === 'activePanel') {
      const id = typeof child === 'string' ? child : null;
      if (id && !panelIdSet.has(id)) return id;
    }
    const unknown = hasUnknownPanel(child);
    if (unknown) return unknown;
  }
  return null;
}

export function encodeWorkspaceLayout(value: unknown): string {
  const layout =
    value && typeof value === 'object' && 'schemaVersion' in value && 'topology' in value
      ? value
      : { schemaVersion: LAYOUT_SCHEMA_VERSION, topology: value };
  return JSON.stringify(layout);
}

export function decodeWorkspaceLayout(raw: string | null): LayoutResult {
  if (typeof raw !== 'string') return recovery('layout-corrupt', 'No saved layout was found.');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return recovery('layout-corrupt', 'Saved layout is not valid JSON.');
  }

  if (parsed === null || typeof parsed !== 'object') {
    return recovery('layout-corrupt', 'Saved layout must be an object.');
  }
  const candidate = parsed as { schemaVersion?: unknown; topology?: unknown };
  if (candidate.schemaVersion !== LAYOUT_SCHEMA_VERSION) {
    return recovery('layout-schema-mismatch', 'Saved layout uses an unsupported schema version.');
  }
  if (!('topology' in candidate)) {
    return recovery('layout-corrupt', 'Saved layout is missing its topology.');
  }
  const unknownPanel = hasUnknownPanel(candidate.topology);
  if (unknownPanel) {
    return recovery('layout-unknown-panel', `Saved layout contains panel ${unknownPanel}.`);
  }
  return {
    ok: true,
    value: {
      schemaVersion: LAYOUT_SCHEMA_VERSION,
      topology: candidate.topology,
    },
  };
}

export function resetWorkspaceLayout(storage: WorkspaceStorage): void {
  storage.setItem(LAYOUT_STORAGE_KEY, encodeWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT));
}

export function readWorkspaceLayout(storage: WorkspaceStorage): {
  readonly layout: WorkspaceLayout;
  readonly recovery: LayoutRecovery | null;
} {
  try {
    const raw = storage.getItem(LAYOUT_STORAGE_KEY);
    if (raw === null) return { layout: DEFAULT_WORKSPACE_LAYOUT, recovery: null };
    const result = decodeWorkspaceLayout(raw);
    if (result.ok) return { layout: result.value, recovery: null };
    return { layout: DEFAULT_WORKSPACE_LAYOUT, recovery: result.error };
  } catch (error) {
    return {
      layout: DEFAULT_WORKSPACE_LAYOUT,
      recovery: {
        code: 'layout-storage-failed',
        detail: error instanceof Error ? error.message : 'Layout storage is unavailable.',
      },
    };
  }
}

export function writeWorkspaceLayout(storage: WorkspaceStorage, topology: unknown): LayoutResult {
  try {
    storage.setItem(LAYOUT_STORAGE_KEY, encodeWorkspaceLayout(topology));
    return { ok: true, value: { schemaVersion: LAYOUT_SCHEMA_VERSION, topology } };
  } catch (error) {
    return recovery(
      'layout-storage-failed',
      error instanceof Error ? error.message : 'Layout storage is unavailable.',
    );
  }
}

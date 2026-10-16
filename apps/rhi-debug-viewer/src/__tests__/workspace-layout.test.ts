import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE_LAYOUT,
  decodeWorkspaceLayout,
  encodeWorkspaceLayout,
  LAYOUT_SCHEMA_VERSION,
  PANEL_IDS,
  resetWorkspaceLayout,
} from '../workspace-layout';

const topology = {
  groups: [
    { type: 'split', direction: 'horizontal', size: 0.35 },
    { type: 'stack', activePanel: 'pipeline-state' },
    { type: 'float', panel: 'resource-inspector', width: 420, height: 320 },
  ],
  panels: PANEL_IDS.map((id) => ({ id, group: 'main', width: 320 })),
  activeTab: 'pipeline-state',
};

describe('viewer-only workspace layout', () => {
  it('round-trips a versioned topology with the fixed panel allowlist', () => {
    const raw = encodeWorkspaceLayout(topology);
    const decoded = decodeWorkspaceLayout(raw);

    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.schemaVersion).toBe(LAYOUT_SCHEMA_VERSION);
      expect(decoded.value.topology).toEqual(topology);
    }
    expect(PANEL_IDS).toEqual([
      'event-browser',
      'pipeline-state',
      'draw-call-viewer',
      'resource-inspector',
    ]);
  });

  it.each([
    ['corrupt JSON', '{'],
    ['schema mismatch', JSON.stringify({ schemaVersion: 999, topology })],
    [
      'unknown panel',
      JSON.stringify({
        schemaVersion: LAYOUT_SCHEMA_VERSION,
        topology: { panels: [{ id: 'unknown' }] },
      }),
    ],
  ])('rejects %s with structured recovery', (_name, raw) => {
    const result = decodeWorkspaceLayout(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toMatch(/layout-/);
  });

  it('keeps layout bytes separate from tape, model, session, and selection facts', () => {
    const raw = encodeWorkspaceLayout(topology);
    expect(raw).not.toMatch(/tape|FrameModel|ReplaySession|selection|inspection/i);
  });

  it('resets to the default topology without requiring tape state', () => {
    const storage = {
      value: encodeWorkspaceLayout(topology) as string | null,
      getItem() {
        return this.value;
      },
      setItem(_key: string, value: string) {
        this.value = value;
      },
      removeItem() {
        this.value = null;
      },
    };
    resetWorkspaceLayout(storage);
    expect(decodeWorkspaceLayout(storage.value)).toEqual({
      ok: true,
      value: DEFAULT_WORKSPACE_LAYOUT,
    });
  });
});

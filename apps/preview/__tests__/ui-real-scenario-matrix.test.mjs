import { describe, expect, it } from 'vitest';
import {
  REAL_UI_ASSETS,
  REAL_UI_SCENARIOS,
  REAL_UI_SETTINGS_DEFAULTS,
  REAL_UI_VIEWPORTS,
} from '../scripts/ui-real-scenario-matrix.mjs';

describe('real Preview UI scenario matrix', () => {
  it('uses the two fixed viewports and the three required consumer scenarios', () => {
    expect(REAL_UI_VIEWPORTS).toEqual([
      { id: 'compact', width: 320, height: 180, deviceScaleFactor: 1 },
      { id: 'desktop', width: 960, height: 540, deviceScaleFactor: 1 },
    ]);
    expect(REAL_UI_SCENARIOS.map(({ id }) => id)).toEqual([
      'default',
      'extreme-data',
      'modal-focus',
    ]);
    expect(new Set(REAL_UI_SCENARIOS.map(({ id }) => id)).size).toBe(3);
  });

  it('binds both real Pack identities and authored Settings defaults', () => {
    expect(REAL_UI_ASSETS.hud).toMatchObject({
      guid: '9e976cdd-1923-57d9-b08c-4ab0bd18a16b',
      name: 'hud.pack.json',
    });
    expect(REAL_UI_ASSETS.settings).toMatchObject({
      guid: 'b0ac90e0-bd8f-5875-9b22-eda3b885c21b',
      name: 'settings.pack.json',
    });
    expect(REAL_UI_SETTINGS_DEFAULTS).toEqual({
      music: 70,
      musicMuted: false,
      highContrast: false,
      antialias: 'fxaa',
      bloom: true,
      depthOfField: false,
      clearColor: 'sky',
    });
  });
});

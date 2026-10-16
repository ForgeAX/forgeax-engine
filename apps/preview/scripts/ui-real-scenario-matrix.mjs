export const REAL_UI_ASSETS = Object.freeze({
  hud: Object.freeze({
    guid: '9e976cdd-1923-57d9-b08c-4ab0bd18a16b',
    name: 'hud.pack.json',
    marker: 'data-ui-slot="score"',
  }),
  settings: Object.freeze({
    guid: 'b0ac90e0-bd8f-5875-9b22-eda3b885c21b',
    name: 'settings.pack.json',
    marker: 'data-ui-setting="music"',
  }),
});

export const REAL_UI_VIEWPORTS = Object.freeze([
  Object.freeze({ id: 'compact', width: 320, height: 180, deviceScaleFactor: 1 }),
  Object.freeze({ id: 'desktop', width: 960, height: 540, deviceScaleFactor: 1 }),
]);

export const REAL_UI_SCENARIOS = Object.freeze([
  Object.freeze({
    id: 'default',
    description: 'Fresh game-default data projects through the real HUD and Settings assets.',
    scoreActions: 0,
    expectedScore: 0,
    expectedMission: 'Mission 1/3',
  }),
  Object.freeze({
    id: 'extreme-data',
    description: 'Public score actions drive a large HUD projection before modal interaction.',
    scoreActions: 5,
    expectedScore: 50,
    expectedMission: 'Mission 2/3',
  }),
  Object.freeze({
    id: 'modal-focus',
    description: 'The real Settings asset owns focus, sibling inertness, and close action.',
    scoreActions: 0,
    expectedScore: 0,
    expectedMission: 'Mission 1/3',
  }),
]);

export const REAL_UI_SETTINGS_DEFAULTS = Object.freeze({
  music: 70,
  musicMuted: false,
  highContrast: false,
  antialias: 'fxaa',
  bloom: true,
  depthOfField: false,
  clearColor: 'sky',
});

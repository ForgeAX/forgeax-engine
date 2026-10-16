export const DISPLAY_UI_SCHEMA_VERSION = 'forgeax.view.display.ui/1';

export const DISPLAY_ACTIONS = Object.freeze({
  setTool: 'display.tool.set',
  setCoordinateSpace: 'display.coordinate-space.set',
  setSnap: 'display.snap.set',
  setCamera: 'display.camera.set',
  setShading: 'display.shading.set',
  setLayout: 'display.layout.set',
  setPreferences: 'display.preferences.set',
  play: 'display.play',
  stop: 'display.stop',
  undo: 'display.undo',
  redo: 'display.redo',
  captureFrame: 'display.capture-frame',
  openStandalone: 'display.open-standalone',
  maximize: 'display.maximize',
});

export const DISPLAY_MODEL_SCHEMA = Object.freeze({
  $id: DISPLAY_UI_SCHEMA_VERSION,
  type: 'object',
  required: ['status', 'tool', 'coordinateSpace', 'shading', 'playing'],
  properties: {
    status: { enum: ['idle', 'running', 'error'] },
    tool: { enum: ['move', 'rotate', 'scale'] },
    coordinateSpace: { enum: ['world', 'local'] },
    shading: { enum: ['lit', 'unlit', 'wireframe'] },
    playing: { type: 'boolean' },
    fps: { type: 'number', minimum: 0 },
    error: { type: ['string', 'null'] },
  },
});

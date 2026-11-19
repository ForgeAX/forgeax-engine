import { defineComponent } from '@forgeax/engine-ecs';

/** World-space MSDF label (camera-facing by default; `worldOriented` follows the entity transform). Font edits update shared runtime content; the Renderer
 * lays out visible candidates without adding MeshFilter, MeshRenderer or derived assets.
 * Color is linear RGBA, including HDR values. Font size scales the metric units. */
export const GlyphText = defineComponent('GlyphText', {
  // The layout/render owner re-resolves the font asset on the target world;
  // authoring text and style remain portable simulation state.
  fontHandle: {
    type: 'asset<font>',
    default: 0 as never,
    simulationTransient: true,
  },
  text: { type: 'string', default: '' },
  fontSize: { type: 'f32', default: 16 },
  // false: camera-facing billboard (translation only). true: the label keeps its full world
  // transform, so it can sit on a wall, floor or signboard and rotate / scale with its entity.
  worldOriented: { type: 'bool', default: false },
  // color carries an explicit layer-2 default [1,1,1,1] (opaque white); the
  // array layer-3 fallback is all-zero, so the default MUST be explicit (D-5).
  color: { type: 'array<f32, 4>', default: new Float32Array([1, 1, 1, 1]) },
});

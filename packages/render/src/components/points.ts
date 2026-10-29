import { defineComponent } from '@forgeax/engine-ecs';

/** Public point raster shapes backed by the ECS enum column. */
export type PointShape = keyof typeof PointShapeValue;

/**
 * Numeric labels stored by the public Points shape enum field. `soft` is a
 * round sprite whose alpha falls smoothly to zero at its edge (a glow or
 * particle without a texture file).
 */
export const PointShapeValue = Object.freeze({
  square: 0,
  circle: 1,
  soft: 2,
} as const);

/** Units of the Points size: physical output pixels or world-space diameter. */
export type PointSizeUnits = keyof typeof PointSizeUnitsValue;

/** Numeric labels stored by the public Points sizeUnits enum field. */
export const PointSizeUnitsValue = Object.freeze({
  pixels: 0,
  world: 1,
} as const);

/** Decode the Points shape column without treating an unknown value as valid. */
export function pointShapeFromU32(value: number): PointShape | undefined {
  switch (value) {
    case PointShapeValue.square:
      return 'square';
    case PointShapeValue.circle:
      return 'circle';
    case PointShapeValue.soft:
      return 'soft';
    default:
      return undefined;
  }
}

/** Decode the Points sizeUnits column without treating an unknown value as valid. */
export function pointSizeUnitsFromU32(value: number): PointSizeUnits | undefined {
  switch (value) {
    case PointSizeUnitsValue.pixels:
      return 'pixels';
    case PointSizeUnitsValue.world:
      return 'world';
    default:
      return undefined;
  }
}

/**
 * Camera-facing point sprites for point-list meshes (Three.js `Points` +
 * `PointsMaterial`). The mesh `color` stream tints each point, `uv1.x`
 * scales each point's size, and the material's base-colour texture maps
 * across each sprite.
 */
export const Points = defineComponent(
  'Points',
  {
    size: { type: 'f32', default: 4 },
    sizeUnits: { type: 'enum', default: PointSizeUnitsValue.pixels, labels: PointSizeUnitsValue },
    shape: { type: 'enum', default: PointShapeValue.square, labels: PointShapeValue },
  },
  {
    meta: {
      quickStart:
        "Attach Points to a point-list mesh; sizeUnits 'world' attenuates with distance (Three.js sizeAttenuation), shape 'soft' draws a round glow, a color stream tints each point.",
      diagnostics: 'Inspect size, sizeUnits and shape; decode enums with pointShapeFromU32.',
      recovery: 'Use points-lines-invalid-style for non-finite or non-positive size values.',
      boundaries:
        'Points owns raster size and shape only; MeshFilter and MeshRenderer own geometry and material.',
    },
  },
);

import { defineComponent } from '@forgeax/engine-ecs';

/** Public point raster shapes backed by the ECS enum column. */
export type PointShape = keyof typeof PointShapeValue;

/** Numeric labels stored by the public Points shape enum field. */
export const PointShapeValue = Object.freeze({
  square: 0,
  circle: 1,
} as const);

/** Decode the Points shape column without treating an unknown value as valid. */
export function pointShapeFromU32(value: number): PointShape | undefined {
  switch (value) {
    case PointShapeValue.square:
      return 'square';
    case PointShapeValue.circle:
      return 'circle';
    default:
      return undefined;
  }
}

/** Screen-space point style. Geometry and material remain on their own owners. */
export const Points = defineComponent(
  'Points',
  {
    sizePx: { type: 'f32', default: 4 },
    shape: { type: 'enum', default: PointShapeValue.square, labels: PointShapeValue },
  },
  {
    meta: {
      quickStart: 'Attach Points to render point-list MeshAsset vertices in screen pixels.',
      diagnostics: 'Inspect sizePx and decode shape with pointShapeFromU32.',
      recovery: 'Use points-lines-invalid-style for non-finite or non-positive sizePx values.',
      boundaries:
        'Points owns raster size and shape only; MeshFilter and MeshRenderer own geometry and material.',
    },
  },
);

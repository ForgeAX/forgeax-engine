import { defineComponent } from '@forgeax/engine-ecs';

/** Units of the Lines width: physical output pixels or world-space distance. */
export type LineWidthUnits = keyof typeof LineWidthUnitsValue;

/** Numeric labels stored by the public Lines widthUnits enum field. */
export const LineWidthUnitsValue = Object.freeze({
  pixels: 0,
  world: 1,
} as const);

/** Shape of open path ends; round also rounds interior strip joins. */
export type LineCap = keyof typeof LineCapValue;

/** Numeric labels stored by the public Lines cap enum field. */
export const LineCapValue = Object.freeze({
  butt: 0,
  round: 1,
} as const);

/** Decode the Lines widthUnits column without treating an unknown value as valid. */
export function lineWidthUnitsFromU32(value: number): LineWidthUnits | undefined {
  switch (value) {
    case LineWidthUnitsValue.pixels:
      return 'pixels';
    case LineWidthUnitsValue.world:
      return 'world';
    default:
      return undefined;
  }
}

/** Decode the Lines cap column without treating an unknown value as valid. */
export function lineCapFromU32(value: number): LineCap | undefined {
  switch (value) {
    case LineCapValue.butt:
      return 'butt';
    case LineCapValue.round:
      return 'round';
    default:
      return undefined;
  }
}

/** Line width, cap and local-space dash pattern for lists and strips. */
export const Lines = defineComponent(
  'Lines',
  {
    width: { type: 'f32', default: 1 },
    widthUnits: { type: 'enum', default: LineWidthUnitsValue.pixels, labels: LineWidthUnitsValue },
    cap: { type: 'enum', default: LineCapValue.butt, labels: LineCapValue },
    dashSize: { type: 'f32', default: 1 },
    gapSize: { type: 'f32', default: 0 },
    dashOffset: { type: 'f32', default: 0 },
  },
  {
    meta: {
      quickStart:
        "Attach Lines to line-list or line-strip meshes; widthUnits 'world' keeps a world-space width, cap 'round' rounds ends and joins, gapSize > 0 enables dashes.",
      diagnostics:
        'Inspect width, widthUnits, cap, dashSize, gapSize and dashOffset at points-lines admission.',
      recovery:
        'Use finite width > 0, a known widthUnits/cap label, dashSize > 0, gapSize >= 0 and finite dashOffset.',
      boundaries:
        'Lines owns width, cap and dash style; MeshFilter and MeshRenderer own geometry and material.',
    },
  },
);

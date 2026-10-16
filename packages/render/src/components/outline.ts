import { defineComponent, type SchemaOf, type ShapeOf } from '@forgeax/engine-ecs';
import { err, ok, type Result } from '@forgeax/engine-types';
import { OutlineInvalidParameterError } from '../errors/render';

/** Camera-local selection. Entity handles refer to the camera's World. */
export const Outline = defineComponent('Outline', {
  entities: 'array<entity>',
  visibleColor: { type: 'array<f32, 3>', default: new Float32Array([1, 0.5, 0]) },
  hiddenColor: { type: 'array<f32, 3>', default: new Float32Array([0.15, 0.05, 0.02]) },
  width: { type: 'f32', default: 2 },
  occlusion: { type: 'u32', default: 0 },
});
export const OutlineOcclusionValue = Object.freeze({ visible: 0, hidden: 1, all: 2 } as const);
export type OutlineData = ShapeOf<SchemaOf<typeof Outline>>;
export interface OutlineSnapshot {
  readonly entities: readonly number[];
  readonly visibleColor: readonly number[];
  readonly hiddenColor: readonly number[];
  readonly width: number;
  readonly occlusion: number;
}
export function resolveOutline(
  input: OutlineData | undefined,
): Result<OutlineSnapshot | undefined, OutlineInvalidParameterError> {
  if (input === undefined) return ok(undefined);
  if (!Number.isInteger(input.width) || input.width < 0 || input.width > 8)
    return err(
      new OutlineInvalidParameterError('width', input.width, 'integer physical pixels in [0, 8]'),
    );
  if (![0, 1, 2].includes(input.occlusion))
    return err(
      new OutlineInvalidParameterError(
        'occlusion',
        input.occlusion,
        'OutlineOcclusionValue.visible, hidden or all',
      ),
    );
  for (const field of ['visibleColor', 'hiddenColor'] as const) {
    for (const value of input[field])
      if (!Number.isFinite(value) || value < 0 || value > 1)
        return err(new OutlineInvalidParameterError(field, value, 'linear RGB channels in [0, 1]'));
  }
  if (input.width === 0 || input.entities.length === 0) return ok(undefined);
  return ok({
    entities: Array.from(new Set(input.entities)),
    visibleColor: Array.from(input.visibleColor),
    hiddenColor: Array.from(input.hiddenColor),
    width: input.width,
    occlusion: input.occlusion,
  });
}

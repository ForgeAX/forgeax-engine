import type { RenderFeatureResourceDeclaration, RenderFeatureWork } from '@forgeax/engine-render';

/** Relative fields use one for a flat interface; light-scaled fields additionally carry sun intensity. */
export interface WaterCausticsField {
  readonly name: string;
  readonly resolution: number;
  readonly sourceGrid: number;
  readonly encoding: 'relative-irradiance' | 'light-scaled-irradiance';
}

export const DEFAULT_WATER_CAUSTICS_FIELD: WaterCausticsField = Object.freeze({
  name: 'water-caustics-field',
  resolution: 512,
  sourceGrid: 192,
  encoding: 'light-scaled-irradiance',
});

/** Declares storage; the Render graph owns allocation, replacement and retirement. */
export function waterCausticsFieldResource(
  field: WaterCausticsField,
): RenderFeatureResourceDeclaration {
  return {
    kind: 'graph-texture',
    name: field.name,
    allocationKey: `${field.name}.${field.resolution}`,
    materialSource: true,
    descriptor: {
      format: 'rgba16float',
      sampleCount: 1,
      size: { width: field.resolution, height: field.resolution, depthOrArrayLayers: 1 },
    },
  };
}

export const WATER_CAUSTICS_ADDITIVE_BLEND = Object.freeze({
  color: { operation: 'add', srcFactor: 'one', dstFactor: 'one' },
  alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one' },
} as const);

/** Only the response lane is writable; geometry motion/depth keep their existing owner. */
export const WATER_CAUSTICS_REACTIVITY_OUTPUT = Object.freeze({
  name: 'reactivity',
  format: 'rgba16float',
  writeMask: 8,
  blend: {
    color: { operation: 'add', srcFactor: 'zero', dstFactor: 'one' },
    alpha: { operation: 'max', srcFactor: 'one', dstFactor: 'one' },
  },
} as const);

/** A projected triangle grid, or a fullscreen texture producer, sharing the same field. */
export function waterCausticsFieldPass(input: {
  readonly field: WaterCausticsField;
  readonly name: string;
  readonly program: string;
  readonly bindings: readonly string[];
  readonly mode?: 'dynamic' | 'texture' | 'off';
}): RenderFeatureWork['passes'][number] {
  return {
    kind: 'raster',
    name: input.name,
    colorAttachments: [{ target: input.field.name, loadOp: 'clear', storeOp: 'store' }],
    draws:
      input.mode === 'off'
        ? []
        : [
            {
              program: input.program,
              bindings: input.bindings,
              vertexLayout: 'none',
              vertexData: [],
              draw: {
                kind: 'draw',
                vertexCount:
                  input.mode === 'texture'
                    ? 3
                    : input.field.sourceGrid * input.field.sourceGrid * 6,
                instanceCount: 1,
              },
            },
          ],
  };
}

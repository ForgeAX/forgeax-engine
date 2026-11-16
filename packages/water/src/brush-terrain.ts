import { err, ok, type Result, type TerrainSource } from '@forgeax/engine-types';
import type { WaterBrushActorPassPlan, WaterBrushTerrainManifest } from './brush-manifest.js';
import type { WaterError } from './contracts.js';

export type WaterBrushTerrainReadback = Readonly<{
  widthPx: number;
  heightPx: number;
  heightsM: Float32Array;
  weightsByLayer: Readonly<Record<string, Float32Array>>;
}>;

/** Pick the RT UE supplies to CacheDistanceField, which can differ from the last RT written. */
export function selectWaterBrushCacheInput<T>(
  actorPass: Pick<WaterBrushActorPassPlan, 'jumpFloodCacheSelectedTarget'>,
  targets: Readonly<{ 'jump-flood-a': T; 'jump-flood-b': T }>,
): T {
  return targets[actorPass.jumpFloodCacheSelectedTarget];
}

const invalid = (expected: string, detail?: unknown): WaterError => ({
  code: 'invalid-source',
  expected,
  hint: 'keep the prior Terrain closure and repair the Brush readback mapping before publishing',
  ...(detail === undefined ? {} : { detail }),
});

function sampleClamp(
  values: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  const px = Math.max(0, Math.min(width - 1, x));
  const py = Math.max(0, Math.min(height - 1, y));
  const x0 = Math.floor(px),
    y0 = Math.floor(py);
  const x1 = Math.min(width - 1, x0 + 1),
    y1 = Math.min(height - 1, y0 + 1);
  const tx = px - x0,
    ty = py - y0;
  const a = values[y0 * width + x0];
  const b = values[y0 * width + x1];
  const c = values[y1 * width + x0];
  const d = values[y1 * width + x1];
  if (a === undefined || b === undefined || c === undefined || d === undefined)
    throw new Error('Validated Water Brush readback sample is missing');
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

function validateTerrainReadbackMapping(
  base: TerrainSource,
  manifest: WaterBrushTerrainManifest,
): WaterError | undefined {
  const { originLocalXZ, stepLocalXZ } = manifest.pixelCenterMapping;
  if (
    !originLocalXZ.every(Number.isFinite) ||
    !stepLocalXZ.every((step) => Number.isFinite(step) && step > 0)
  )
    return invalid('finite Terrain pixel-center origin and positive finite sample steps');
  const firstPixelX = (0 - originLocalXZ[0]) / stepLocalXZ[0];
  const lastPixelX = ((base.columns - 1) * base.spacing - originLocalXZ[0]) / stepLocalXZ[0];
  const firstPixelY = (0 - originLocalXZ[1]) / stepLocalXZ[1];
  const lastPixelY = ((base.rows - 1) * base.spacing - originLocalXZ[1]) / stepLocalXZ[1];
  const [expectedWidth, expectedHeight] = manifest.terrainCapture.resolutionPx;
  const tolerance = 1e-5;
  if (
    firstPixelX < -tolerance ||
    lastPixelX > expectedWidth - 1 + tolerance ||
    firstPixelY < -tolerance ||
    lastPixelY > expectedHeight - 1 + tolerance
  )
    return invalid('Terrain vertex domain is covered by the RT pixel-center sample range', {
      pixelRange: [
        [firstPixelX, lastPixelX],
        [firstPixelY, lastPixelY],
      ],
      sampleRange: [
        [0, expectedWidth - 1],
        [0, expectedHeight - 1],
      ],
    });
  return undefined;
}

function validateTerrainReadbackSamples(
  capture: WaterBrushTerrainManifest['terrainCapture'],
  readback: WaterBrushTerrainReadback,
): WaterError | undefined {
  const [width, height] = capture.resolutionPx;
  const weightSamples = Object.values(readback.weightsByLayer);
  if (
    weightSamples.some((values) => values.length !== width * height) ||
    Object.keys(readback.weightsByLayer).some(
      (layer) => !Object.hasOwn(capture.layerNameToIndex, layer),
    )
  )
    return invalid(
      'one correctly sized GPU weight readback for each named layer in the frozen mapping',
    );
  if (
    readback.heightsM.some((value) => !Number.isFinite(value)) ||
    weightSamples.some((values) => values.some((value) => !Number.isFinite(value)))
  )
    return invalid('finite GPU Terrain height and weight samples');
  if (weightSamples.some((values) => values.some((value) => value < 0 || value > 1)))
    return invalid('R8-unorm decoded weight samples in the closed [0, 1] range');
  return undefined;
}

/** Resample GPU height/weight readback at TerrainSource vertex positions using the manifest's pixel-center map. */
export function applyWaterBrushTerrainReadback(
  base: TerrainSource,
  manifest: WaterBrushTerrainManifest,
  readback: WaterBrushTerrainReadback,
): Result<TerrainSource, WaterError> {
  const capture = manifest.terrainCapture;
  const expectedWidth = capture.resolutionPx[0];
  const expectedHeight = capture.resolutionPx[1];
  if (
    readback.widthPx !== expectedWidth ||
    readback.heightPx !== expectedHeight ||
    readback.heightsM.length !== expectedWidth * expectedHeight
  )
    return err(
      invalid('GPU readback dimensions and height sample count equal the explicit RT resolution', {
        actual: [readback.widthPx, readback.heightPx],
        expected: [expectedWidth, expectedHeight],
        sampleCount: readback.heightsM.length,
      }),
    );
  if (
    base.columns < 2 ||
    base.rows < 2 ||
    !(base.spacing > 0) ||
    base.heights.length !== base.columns * base.rows ||
    base.weights.length !== base.columns * base.rows * base.layers.length
  )
    return err(invalid('valid base Terrain X-fast vertex arrays and positive sample spacing'));
  const sampleError = validateTerrainReadbackSamples(capture, readback);
  if (sampleError) return err(sampleError);
  const mappingError = validateTerrainReadbackMapping(base, manifest);
  if (mappingError) return err(mappingError);
  for (const [layer, layerIndex] of Object.entries(capture.layerNameToIndex)) {
    if (!Number.isSafeInteger(layerIndex) || layerIndex < 0 || layerIndex >= base.layers.length)
      return err(
        invalid('Terrain layer mapping indices resolve inside the base TerrainSource layer list', {
          layer,
          layerIndex,
          layerCount: base.layers.length,
        }),
      );
    if (!Object.hasOwn(readback.weightsByLayer, layer))
      return err(invalid('GPU weight readback for every frozen named layer', layer));
  }
  const heights = new Float32Array(base.heights.length);
  const weights = new Float32Array(base.weights);
  for (let row = 0; row < base.rows; row++)
    for (let column = 0; column < base.columns; column++) {
      const xM = column * base.spacing;
      const zM = row * base.spacing;
      const pixelX =
        (xM - manifest.pixelCenterMapping.originLocalXZ[0]) /
        manifest.pixelCenterMapping.stepLocalXZ[0];
      const pixelY =
        (zM - manifest.pixelCenterMapping.originLocalXZ[1]) /
        manifest.pixelCenterMapping.stepLocalXZ[1];
      const terrainIndex = row * base.columns + column;
      heights[terrainIndex] = sampleClamp(
        readback.heightsM,
        expectedWidth,
        expectedHeight,
        pixelX,
        pixelY,
      );
      for (const [layer, layerIndex] of Object.entries(capture.layerNameToIndex)) {
        const layerSamples = readback.weightsByLayer[layer];
        if (layerSamples === undefined)
          return err(invalid('GPU weight readback for every frozen named layer', layer));
        weights[terrainIndex * base.layers.length + layerIndex] = sampleClamp(
          layerSamples,
          expectedWidth,
          expectedHeight,
          pixelX,
          pixelY,
        );
      }
    }
  return ok(Object.freeze({ ...base, heights, weights }));
}

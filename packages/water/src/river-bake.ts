import { halfFloat } from '@forgeax/engine-math';
import { AssetGuid, type PackageId } from '@forgeax/engine-pack/source';
import {
  err,
  ok,
  type Result,
  type TextureAsset,
  type WaterAdvancedSimulationSource,
} from '@forgeax/engine-types';
import type {
  WaterAdvancedError,
  WaterAdvancedSimulation,
  WaterAdvancedTextureReadback,
} from './advanced-simulation';
import type { WaterBakedQueryGrid } from './contracts';
import { validateWaterAsset } from './validate';

type BakedRecipe = WaterAdvancedSimulationSource & { readonly kind: 'water-simulation-recipe' };
/** One loaded Pack texture snapshot and its Runtime owner identity/revision. */
export type WaterRiverBakeLoadedTexture = Readonly<{
  readonly kind: 'loaded-texture-asset';
  readonly handle: number;
  readonly guid: string;
  readonly revision: number;
  readonly asset: TextureAsset;
}>;
export interface WaterRiverBakeCandidate {
  readonly sourceKey: string;
  readonly gridTextureSourceKey: string;
  readonly normalTextureSourceKey: string;
  readonly recipe: BakedRecipe;
  readonly gridTexture: TextureAsset;
  readonly normalTexture: TextureAsset;
}
export type WaterRiverBakeLoadedTextures =
  | Readonly<{
      readonly version: 'water-river-bake/1';
      readonly grid: WaterRiverBakeLoadedTexture;
    }>
  | Readonly<{
      readonly version: 'water-river-bake/2';
      readonly grid: WaterRiverBakeLoadedTexture;
      readonly normal: WaterRiverBakeLoadedTexture;
    }>;

function matchesLoadedTextureRevision(
  value: WaterRiverBakeLoadedTexture | undefined,
  textureGuid: string,
): value is WaterRiverBakeLoadedTexture {
  if (
    value?.kind !== 'loaded-texture-asset' ||
    Number.isSafeInteger(value.handle) === false ||
    value.handle <= 0 ||
    typeof value.guid !== 'string' ||
    Number.isSafeInteger(value.revision) === false ||
    value.revision < 0
  )
    return false;
  const loadedGuid = AssetGuid.parse(value.guid);
  const expectedGuid = AssetGuid.parse(textureGuid);
  return loadedGuid.ok && expectedGuid.ok && AssetGuid.equals(loadedGuid.value, expectedGuid.value);
}

function validGridTextureAsset(
  texture: TextureAsset,
  metadata: NonNullable<BakedRecipe['riverBakeConfig']>['bakedGrid'],
): boolean {
  if (
    !metadata ||
    texture.kind !== 'texture' ||
    texture.shape.viewDimension !== '2d' ||
    texture.format !== 'rgba16float' ||
    texture.encoding !== undefined ||
    texture.mips.kind !== 'none' ||
    texture.colorSpace !== 'linear' ||
    texture.shape.extent.width !== metadata.width ||
    texture.shape.extent.height !== metadata.height ||
    texture.data.byteLength !== metadata.width * metadata.height * 8
  )
    return false;
  const bytes = new Uint8Array(texture.data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = Float32Array.from({ length: bytes.byteLength / 2 }, (_, index) =>
    halfFloat.f16ToF32(view.getUint16(index * 2, true)),
  );
  return (
    samples.every(Number.isFinite) && !samples.some((value, index) => index % 4 === 1 && value < 0)
  );
}

function validNormalTextureAsset(
  texture: TextureAsset,
  metadata: NonNullable<BakedRecipe['riverBakeConfig']>['bakedGrid'],
  expectedFormat: 'rgba16float' | 'rgba32float',
): boolean {
  if (
    !metadata ||
    texture.kind !== 'texture' ||
    texture.shape.viewDimension !== '2d' ||
    texture.format !== expectedFormat ||
    texture.encoding !== undefined ||
    texture.mips.kind !== 'none' ||
    texture.colorSpace !== 'linear' ||
    texture.shape.extent.width !== metadata.width ||
    texture.shape.extent.height !== metadata.height
  )
    return false;
  const bytesPerPixel = expectedFormat === 'rgba16float' ? 8 : 16;
  if (texture.data.byteLength !== metadata.width * metadata.height * bytesPerPixel) return false;
  const bytes = new Uint8Array(texture.data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const read = (index: number) =>
    expectedFormat === 'rgba16float'
      ? halfFloat.f16ToF32(view.getUint16(index * 2, true))
      : view.getFloat32(index * 4, true);
  const normalTolerance = expectedFormat === 'rgba16float' ? 0.002 : 0.00001;
  for (let pixel = 0; pixel < metadata.width * metadata.height; pixel++) {
    const offset = pixel * 4;
    const x = read(offset);
    const y = read(offset + 1);
    const z = read(offset + 2);
    const alpha = read(offset + 3);
    if (
      ![x, y, z, alpha].every(Number.isFinite) ||
      Math.abs(Math.hypot(x, y, z) - 1) > normalTolerance
    )
      return false;
  }
  return true;
}

function decodeGrid(
  recipe: BakedRecipe,
  loadedTextures: WaterRiverBakeLoadedTextures,
): WaterBakedQueryGrid | undefined {
  const metadata = recipe.riverBakeConfig?.bakedGrid;
  const shallow = recipe.shallowStageConfig;
  const loadedGrid = loadedTextures.grid;
  if (!metadata || !shallow || !matchesLoadedTextureRevision(loadedGrid, metadata.textureGuid))
    return undefined;
  if (!validGridTextureAsset(loadedGrid.asset, metadata)) return undefined;
  const texture = loadedGrid.asset;
  const bytes = new Uint8Array(texture.data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = Float32Array.from({ length: bytes.byteLength / 2 }, (_, index) =>
    halfFloat.f16ToF32(view.getUint16(index * 2, true)),
  );
  const acceptedTextureRevision = loadedGrid.revision;
  const decoded = {
    width: metadata.width,
    height: metadata.height,
    originXZ: Object.freeze([...metadata.originXZ]) as WaterBakedQueryGrid['originXZ'],
    originY: metadata.originYM,
    spacingXZ: Object.freeze([...metadata.spacingXZ]) as WaterBakedQueryGrid['spacingXZ'],
    samples,
  };
  const commonLineage = {
    textureGuid: metadata.textureGuid,
    textureRevision: acceptedTextureRevision,
    sourceRecipeGuid: metadata.sourceRecipeGuid,
    sourceRecipeVersion: metadata.sourceRecipeVersion,
    sourceBodyGuid: metadata.sourceBodyGuid,
    sourceBodyGeneration: metadata.sourceBodyGeneration,
    simulationGeneration: metadata.simulationGeneration,
    sequence: metadata.sequence,
    frameId: metadata.frameId,
    deviceGeneration: metadata.deviceGeneration,
    graphGeneration: metadata.graphGeneration,
  };
  if (metadata.version === 'water-river-bake/2') {
    if (
      loadedTextures.version !== 'water-river-bake/2' ||
      metadata.normalBasis !== 'lattice-axis0-axis1-up/1' ||
      !matchesLoadedTextureRevision(loadedTextures.normal, metadata.normalTextureGuid) ||
      !validNormalTextureAsset(loadedTextures.normal.asset, metadata, shallow.normalRtFormat)
    )
      return undefined;
    return {
      ...decoded,
      lineage: Object.freeze({
        ...commonLineage,
        version: metadata.version,
        normalTextureGuid: metadata.normalTextureGuid,
        normalTextureRevision: loadedTextures.normal.revision,
        normalTextureFormat: loadedTextures.normal.asset.format as 'rgba16float' | 'rgba32float',
        normalBasis: metadata.normalBasis,
        sourceWorldMatrixM: Object.freeze([...metadata.sourceWorldMatrixM]),
        sourceGeometryProjectionHash: metadata.sourceGeometryProjectionHash,
        sourceFrame: Object.freeze({ ...metadata.sourceFrame }),
      }),
    };
  }
  if (loadedTextures.version !== 'water-river-bake/1') return undefined;
  return {
    ...decoded,
    lineage: Object.freeze({ ...commonLineage, version: metadata.version }),
  };
}

function validBakePixelLayout(
  pixels: WaterAdvancedTextureReadback,
  resolution: readonly [number, number],
  expectedFormat: 'rgba16float' | 'rgba32float',
): boolean {
  const bytesPerPixel = expectedFormat === 'rgba16float' ? 8 : 16;
  return (
    pixels.width === resolution[0] &&
    pixels.height === resolution[1] &&
    pixels.format === expectedFormat &&
    pixels.width >= 3 &&
    pixels.height >= 3 &&
    Number.isSafeInteger(pixels.bytesPerRow) &&
    pixels.bytesPerRow >= pixels.width * bytesPerPixel &&
    pixels.bytes.length >= pixels.bytesPerRow * pixels.height
  );
}

function sameCompletion(
  left: WaterAdvancedTextureReadback['completion'],
  right: WaterAdvancedTextureReadback['completion'],
): boolean {
  return (
    left.frameId === right.frameId &&
    left.deviceGeneration === right.deviceGeneration &&
    left.graphGeneration === right.graphGeneration
  );
}

function sameSourceFrame(
  left: NonNullable<WaterAdvancedTextureReadback['sourceFrame']>,
  right: NonNullable<WaterAdvancedTextureReadback['sourceFrame']>,
): boolean {
  return (
    left.generation === right.generation &&
    left.sequence === right.sequence &&
    left.step === right.step &&
    left.timeSeconds === right.timeSeconds
  );
}

function packTextureRows(pixels: WaterAdvancedTextureReadback, bytesPerPixel: number): Uint8Array {
  const data = new Uint8Array(pixels.width * pixels.height * bytesPerPixel);
  for (let row = 0; row < pixels.height; row++)
    data.set(
      pixels.bytes.subarray(
        row * pixels.bytesPerRow,
        row * pixels.bytesPerRow + pixels.width * bytesPerPixel,
      ),
      row * pixels.width * bytesPerPixel,
    );
  return data;
}

/** Create ordinary Pack outputs only from a current, completed GPU capture. */
export function prepareWaterRiverBake(
  simulation: WaterAdvancedSimulation,
  packageId: PackageId,
): Result<WaterRiverBakeCandidate, WaterAdvancedError> {
  const invalid = () =>
    err<WaterAdvancedError>(
      simulation.failure(
        'water-advanced-bake-unavailable',
        'the current completed River Bake grid and paired finite solver-normal capture on the original world-aligned lattice',
      ),
    );
  const capture = simulation.bakeReadback();
  if (!capture) return invalid();
  const { frame, gridPixels, normalPixels, completion: bakeCompletion } = capture;
  const state = simulation.inspect();
  const config = frame.recipe.asset.riverBakeConfig;
  const shallow = frame.recipe.asset.shallowStageConfig;
  const completion = state.completion;
  const bakeCapture = frame.bakeCapture;
  const sourceFrame = gridPixels.sourceFrame;
  const normalSourceFrame = normalPixels.sourceFrame;
  const matchesCapturedSourceFrame = (): boolean =>
    Boolean(
      bakeCapture &&
        sourceFrame &&
        normalSourceFrame &&
        shallow &&
        !(
          sourceFrame.generation !== bakeCapture.sourceFrame.generation ||
          sourceFrame.sequence !== bakeCapture.sourceFrame.sequence ||
          sourceFrame.step !== bakeCapture.sourceFrame.step ||
          sourceFrame.timeSeconds !== bakeCapture.sourceFrame.timeSeconds ||
          !sameSourceFrame(sourceFrame, normalSourceFrame) ||
          !validBakePixelLayout(
            gridPixels,
            [bakeCapture.lattice.width, bakeCapture.lattice.height],
            'rgba16float',
          ) ||
          !validBakePixelLayout(
            normalPixels,
            [bakeCapture.lattice.width, bakeCapture.lattice.height],
            shallow.normalRtFormat,
          )
        ),
    );
  const matchesBakeCaptureOwner = (): boolean =>
    Boolean(
      bakeCapture &&
        !(
          bakeCapture.sourceBodyGuid.toLowerCase() !== frame.body.sourceAssetGuid.toLowerCase() ||
          bakeCapture.sourceBodyGeneration !== frame.body.generation ||
          bakeCapture.sourceFrame.generation !== frame.generation ||
          bakeCapture.sourceFrame.sequence !== frame.sequence ||
          bakeCapture.sourceFrame.step !== frame.step ||
          bakeCapture.sourceFrame.timeSeconds !== frame.timeSeconds
        ),
    );
  const matchesBakeOwnerState = (): boolean =>
    Boolean(
      config &&
        !(
          config.sourceBodyGuid !== frame.body.sourceAssetGuid ||
          state.generation !== frame.generation ||
          frame.body.guid !== simulation.body.guid ||
          frame.body.generation !== simulation.body.generation ||
          state.completedSequence < frame.sequence ||
          state.bake.status !== 'captured' ||
          state.bake.request !== frame.bakeRequest
        ),
    );
  if (
    !config ||
    !shallow ||
    !matchesBakeOwnerState() ||
    !completion ||
    !sameCompletion(gridPixels.completion, bakeCompletion) ||
    !sameCompletion(normalPixels.completion, bakeCompletion) ||
    !sameCompletion(gridPixels.completion, normalPixels.completion) ||
    !bakeCapture ||
    !sourceFrame ||
    !normalSourceFrame ||
    !matchesBakeCaptureOwner() ||
    !matchesCapturedSourceFrame()
  )
    return invalid();
  const invalidCaptureLattice = (): boolean =>
    frame.transform.yawRadians !== 0 ||
    config.bakeExtentM.some((value, index) => value !== frame.transform.extentM[index]) ||
    shallow.gridResolution[0] !== bakeCapture.lattice.width ||
    shallow.gridResolution[1] !== bakeCapture.lattice.height ||
    bakeCapture.lattice.spacingXZ[0] !== config.bakeExtentM[0] / bakeCapture.lattice.width ||
    bakeCapture.lattice.spacingXZ[1] !== config.bakeExtentM[1] / bakeCapture.lattice.height;
  if (invalidCaptureLattice()) return invalid();
  const gridTextureSourceKey = `${config.outputSourceKey}/grid`;
  const normalTextureSourceKey = `${config.outputSourceKey}/normal`;
  const textureGuid = AssetGuid.format(AssetGuid.derive(packageId, gridTextureSourceKey));
  const normalTextureGuid = AssetGuid.format(AssetGuid.derive(packageId, normalTextureSourceKey));
  const gridData = packTextureRows(gridPixels, 8);
  const normalBytesPerPixel = shallow.normalRtFormat === 'rgba16float' ? 8 : 16;
  const normalData = packTextureRows(normalPixels, normalBytesPerPixel);
  const includeBakeTextures = () => {
    const textureGuids = [...frame.recipe.asset.textureGuids];
    for (const guid of [textureGuid, normalTextureGuid])
      if (!textureGuids.some((value) => value.toLowerCase() === guid.toLowerCase()))
        textureGuids.push(guid);
    return textureGuids;
  };
  const textureGuids = includeBakeTextures();
  const recipe: BakedRecipe = {
    ...structuredClone(frame.recipe.asset),
    textureGuids,
    riverBakeConfig: {
      ...config,
      bakedGrid: {
        version: 'water-river-bake/2',
        textureGuid,
        normalTextureGuid,
        normalBasis: 'lattice-axis0-axis1-up/1',
        sourceRecipeGuid: frame.recipe.guid,
        sourceRecipeVersion: frame.recipe.contentVersion,
        sourceBodyGuid: bakeCapture.sourceBodyGuid,
        sourceBodyGeneration: bakeCapture.sourceBodyGeneration,
        simulationGeneration: frame.generation,
        sequence: frame.sequence,
        ...bakeCompletion,
        width: bakeCapture.lattice.width,
        height: bakeCapture.lattice.height,
        originXZ: Object.freeze([...bakeCapture.lattice.originXZ]) as readonly [number, number],
        originYM: bakeCapture.lattice.originYM,
        spacingXZ: Object.freeze([...bakeCapture.lattice.spacingXZ]) as readonly [number, number],
        sourceWorldMatrixM: bakeCapture.sourceWorldMatrixM,
        sourceGeometryProjectionHash: bakeCapture.sourceGeometryProjectionHash,
        sourceFrame: bakeCapture.sourceFrame,
      },
    },
  };
  const gridTexture: TextureAsset = {
    kind: 'texture',
    shape: {
      viewDimension: '2d',
      extent: { width: gridPixels.width, height: gridPixels.height },
    },
    format: 'rgba16float',
    data: gridData,
    colorSpace: 'linear',
    mips: { kind: 'none' },
  };
  const normalTexture: TextureAsset = {
    kind: 'texture',
    shape: {
      viewDimension: '2d',
      extent: { width: normalPixels.width, height: normalPixels.height },
    },
    format: shallow.normalRtFormat,
    data: normalData,
    colorSpace: 'linear',
    mips: { kind: 'none' },
  };
  const validation = validateWaterAsset(recipe);
  const metadata = recipe.riverBakeConfig?.bakedGrid;
  if (
    !validation.ok ||
    !validGridTextureAsset(gridTexture, metadata) ||
    !validNormalTextureAsset(normalTexture, metadata, shallow.normalRtFormat)
  )
    return invalid();
  return ok({
    sourceKey: config.outputSourceKey,
    gridTextureSourceKey,
    normalTextureSourceKey,
    recipe,
    gridTexture,
    normalTexture,
  });
}

/** Cold reload uses the exact same admitted recipe/texture bytes as first publication. */
export function decodeWaterRiverBake(
  recipe: BakedRecipe,
  loadedTextures: WaterRiverBakeLoadedTextures,
): Result<
  WaterBakedQueryGrid,
  { readonly code: 'water-river-bake-invalid'; readonly expected: string; readonly hint: string }
> {
  const metadata = recipe.riverBakeConfig?.bakedGrid;
  const grid =
    validateWaterAsset(recipe).ok && metadata ? decodeGrid(recipe, loadedTextures) : undefined;
  return grid
    ? ok(grid)
    : err({
        code: 'water-river-bake-invalid',
        expected:
          'a versioned River Bake recipe and its exact loaded grid texture, plus the required same-lattice solver-normal texture for /2',
        hint: 'load every referenced Bake texture from the accepted Runtime Pack/Catalog and pass each owning handle, GUID, revision and loaded value together before publishing the current Body query grid',
      });
}

import type { EngineShaderFile } from './load-engine-shader-entries.js';

type WaterInfoRasterEntries = {
  readonly waterInfoRasterWater: EngineShaderFile;
  readonly waterInfoRasterGround: EngineShaderFile;
  readonly waterInfoRasterDilation: EngineShaderFile;
};

export function waterInfoRasterEngineEntries<T extends WaterInfoRasterEntries>(entries: T) {
  return [
    entries.waterInfoRasterWater,
    entries.waterInfoRasterGround,
    entries.waterInfoRasterDilation,
  ] as const;
}

import type { BarrelDistortionInspection } from '../inspection-types';
import { projectBarrelDistortionInspection } from '../inspection-types';

export function inspectBarrelDistortion(
  disposed: boolean,
  deviceLost: boolean,
  surfaceReleased: boolean,
  frameId: number,
  deviceGeneration: number,
  inspection: BarrelDistortionInspection,
): BarrelDistortionInspection {
  if (disposed || deviceLost || surfaceReleased) {
    return projectBarrelDistortionInspection({
      effectiveMapping: undefined,
      frameId,
      deviceGeneration,
      graphGeneration: 0,
      lastKnownGood: false,
    });
  }
  return projectBarrelDistortionInspection({ ...inspection, frameId });
}

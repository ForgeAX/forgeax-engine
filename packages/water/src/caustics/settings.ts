import type { WaterCausticsField } from './field.js';

/** Receiving controls in metres, independent of the scene's UI and light selection. */
export interface WaterCausticsReceiverSettings {
  readonly mode?: 'dynamic' | 'texture';
  readonly gain?: number;
  readonly scale?: number;
  readonly lineWidth?: number;
  readonly softness?: number;
  readonly visibleDistanceM?: number;
  readonly maximumDepthM?: number;
  readonly maximumConcentration?: number;
  readonly incidentDirection: readonly [number, number, number] | Float32Array;
  readonly lightIntensity: number;
  readonly referencePlaneY: number;
  readonly timeSeconds?: number;
  readonly visibilityDiagnostic?: boolean;
  readonly encoding?: WaterCausticsField['encoding'];
}

/** The stock receiver uniform ABI. This packing belongs to Water, never scene code. */
export function waterCausticsReceiverValues(
  settings: WaterCausticsReceiverSettings,
): readonly number[] {
  return [
    settings.mode === 'texture' ? 1 : 2,
    settings.gain ?? 0.35,
    settings.scale ?? 1,
    settings.lineWidth ?? 0.25,
    settings.softness ?? 0.25,
    settings.visibleDistanceM ?? 40,
    settings.maximumDepthM ?? 6,
    settings.maximumConcentration ?? 6,
    ...settings.incidentDirection,
    settings.lightIntensity,
    settings.referencePlaneY,
    settings.timeSeconds ?? 0,
    settings.visibilityDiagnostic ? 1 : 0,
    settings.encoding === 'relative-irradiance' ? 1 : 0,
  ];
}

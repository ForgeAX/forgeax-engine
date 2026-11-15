import { degrees } from './terrain.ts';

export interface SunFields { readonly sunElevation: number; readonly sunAzimuth: number }

export function readSunFields(value: unknown): SunFields | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { sunElevation, sunAzimuth } = value as Record<string, unknown>;
  if (typeof sunElevation !== 'number' || !Number.isFinite(sunElevation) || sunElevation < -90 || sunElevation > 180 ||
    typeof sunAzimuth !== 'number' || !Number.isFinite(sunAzimuth) || sunAzimuth < -360 || sunAzimuth > 360) return undefined;
  return { sunElevation, sunAzimuth };
}

export function sunDirection(fields: SunFields): [number, number, number] {
  const elevation = fields.sunElevation * degrees;
  const azimuth = fields.sunAzimuth * degrees;
  return [-Math.sin(azimuth) * Math.cos(elevation), -Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation)];
}

export function sunFieldsFromDirection(direction: ArrayLike<number>, azimuthHint = 0, elevationHint?: number): SunFields {
  const horizontal = Math.hypot(direction[0] ?? 0, direction[2] ?? 0);
  const acute = Math.atan2(-(direction[1] ?? 0), horizontal) / degrees;
  const elevations = [acute, 180 - acute]
    .filter(value => value >= -90.00001 && value <= 180.00001)
    .map(value => Math.max(-90, Math.min(180, value)));
  const hint = elevationHint ?? acute;
  const sunElevation = elevations.reduce((best, value) => Math.abs(value - hint) < Math.abs(best - hint) ? value : best, elevations[0] ?? 0);
  if (horizontal <= 1e-8) return { sunElevation, sunAzimuth: azimuthHint };
  const canonical = Math.atan2(-(direction[0] ?? 0), -(direction[2] ?? 0)) / degrees;
  const authored = canonical + (sunElevation > 90 ? 180 : 0);
  const candidates = [-720, -360, 0, 360, 720].map(turn => authored + turn).filter(value => value >= -360 && value <= 360);
  const sunAzimuth = candidates.reduce((best, value) => Math.abs(value - azimuthHint) < Math.abs(best - azimuthHint) ? value : best, candidates[0] ?? canonical);
  return { sunElevation, sunAzimuth };
}

/** Independent double precision Beer-Lambert reference for a constant-density chord. */
export function uniformTransmittance(extinctionPerMeter: number, lengthMeters: number): number {
  return Math.exp(-extinctionPerMeter * lengthMeters);
}

import type { MediumSample } from '../contracts';
import type { ConservativeDensity } from './medium';
import { cloudDistanceFade, cloudModelPosition } from './medium';

type Vec2 = readonly [number, number];
type Vec3 = readonly [number, number, number];
type Vec4 = readonly [number, number, number, number];

export interface CloudDensityPoint {
  readonly positionMeters: Vec3;
  readonly cameraRelativeMeters: Vec3;
  readonly heightFraction: number;
  readonly windOffsetMeters: Vec3;
}

export interface CloudDensityControls {
  readonly layoutScaleMeters: number;
  readonly coverageBias: number;
  readonly extinctionPerMeter: number;
  readonly albedo: Vec4;
  readonly layoutWeight: number;
  readonly maskWeight: number;
  readonly profileWeight: number;
  readonly bodyWeight: number;
  readonly erosionWeight: number;
}

/** Role-specific linear LOD-0 reads using UE's shared repeat sampler. */
export interface ReferenceCloudTextures {
  pattern(uv: Vec2): Vec4;
  mask(uv: Vec2): Vec4;
  profile(uv: Vec2): Vec4;
  body(uvw: Vec3): Vec4;
}

const REFERENCE_MASK_STRENGTH = 0.01;

function mix(from: number, to: number, t: number): number {
  return from * (1 - t) + to * t;
}

/** Fixed StormClouds=0 graph, plus independently switchable Demo mask and erosion. */
export function evaluateReferenceConservative(
  point: CloudDensityPoint,
  controls: CloudDensityControls,
  textures: ReferenceCloudTextures,
  useDetail: boolean,
): ConservativeDensity {
  const h = point.heightFraction;
  if (!Number.isFinite(h)) return [0, 0, 0, 0];
  const p = cloudModelPosition(point.positionMeters);
  const offset = cloudModelPosition(point.windOffsetMeters);
  const scale = controls.layoutScaleMeters;
  const coord: Vec3 = [p[0] / scale + 0.5, p[1] / scale + 0.5, p[2] / scale];
  const wind: Vec3 = [offset[0] / scale, offset[1] / scale, offset[2] / scale];
  const uv: Vec2 = [coord[0] - 0.5, coord[1] - 0.5];
  const pattern = textures.pattern(uv);
  const layout: Vec3 = [
    mix(0.58, pattern[0], controls.layoutWeight),
    mix(0.58, pattern[1], controls.layoutWeight),
    mix(0.58, pattern[2], controls.layoutWeight),
  ];
  const carrier = Math.max(...layout);
  const mask = textures.mask([coord[0], coord[1]]);
  const vertical =
    mix(
      0.8,
      Math.max(
        textures.profile([h, layout[0]])[0],
        textures.profile([h, layout[1]])[1],
        textures.profile([h, layout[2]])[2],
      ),
      controls.profileWeight,
    ) - 0.5;
  const maskSupportT = Math.min(1, Math.max(0, vertical / REFERENCE_MASK_STRENGTH));
  const maskSupport = maskSupportT * maskSupportT * (3 - 2 * maskSupportT);
  const maskContribution =
    REFERENCE_MASK_STRENGTH *
    controls.maskWeight *
    maskSupport *
    (mask[0] * 0.4 + mask[1] * 0.35 + mask[2] * 0.25);
  const noise2 = textures.body([
    coord[0] * 60 - wind[0] * 6,
    coord[1] * 60 - wind[1] * 6,
    coord[2] * 75 - wind[2] * 6,
  ])[0];
  const distortion = (noise2 - 0.8) * 0.08 * controls.erosionWeight;
  const heightScale = 0.05 + h * 0.95;
  const hWarp = 2 * Math.abs(heightScale - 0.5);
  const body = textures.body([
    coord[0] * 4.167 + wind[0] * 7 + distortion * heightScale,
    coord[1] * 4.444 + wind[1] * 7 + distortion * heightScale,
    coord[2] * 9.091 + wind[2] * 7 + distortion * hWarp * hWarp,
  ])[1];
  let detail = 0.8 * ((body - 0.5) * controls.bodyWeight + controls.coverageBias);
  if (useDetail) {
    const noise3 = textures.body([
      coord[0] * 30 + wind[0] * 8,
      coord[1] * 40 + wind[1] * 8,
      coord[2] * 25 + wind[2] * 8,
    ])[2];
    const third = detail * (0.4 * noise3) + 0.03 * (controls.coverageBias + noise3 - 0.5);
    detail = mix(detail, third, controls.erosionWeight);
  }
  return [carrier + maskContribution, carrier, vertical, detail];
}

export function evaluateReferenceMedium(
  point: CloudDensityPoint,
  controls: CloudDensityControls,
  c4: ConservativeDensity,
): MediumSample {
  const density = Math.max(0, Math.max(c4[0] - c4[1], 0) + c4[1] * (c4[2] + c4[3]));
  const heightGate =
    point.heightFraction >= 0 &&
    point.heightFraction <= 1 &&
    Math.abs(point.heightFraction - 0.5) <= 0.48
      ? 1
      : 0;
  return {
    extinctionPerMeter: Math.min(
      1,
      heightGate *
        density *
        controls.extinctionPerMeter *
        cloudDistanceFade(point.cameraRelativeMeters),
    ),
    albedo: [controls.albedo[0], controls.albedo[1], controls.albedo[2]],
    emissivePerMeter: [0, 0, 0],
    materialAO: controls.albedo[3],
  };
}

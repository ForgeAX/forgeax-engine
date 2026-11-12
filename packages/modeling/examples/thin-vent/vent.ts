import { type Model, model, type ThinHolePlan, thinHole } from '@forgeax/engine-modeling';

/**
 * A 120 mm vent grille in a 1.5 mm plate, shipped as two flat quads and one baked cutout:
 * the plate quad wears the baked maps (opacity cuts the holes, normal and AO shade the
 * hole walls), and a dark quad 8 mm behind it is the only other geometry. The perforated
 * detail exists at build time only.
 */
export interface VentParameters {
  readonly width: number;
  readonly height: number;
  readonly diameter: number;
  readonly pitch: number;
  readonly thickness: number;
  readonly backing: number;
  readonly resolution: number;
}

export const VENT_DEFAULTS: VentParameters = {
  width: 0.12,
  height: 0.12,
  diameter: 0.007,
  pitch: 0.011,
  thickness: 0.0015,
  backing: 0.008,
  resolution: 512,
};

export function buildVent(p: VentParameters = VENT_DEFAULTS): {
  plan: ThinHolePlan;
  backing: Model;
} {
  const planned = thinHole({
    width: p.width,
    height: p.height,
    diameter: p.diameter,
    pitch: p.pitch,
    pattern: 'hex',
    thickness: p.thickness,
    resolution: p.resolution,
    maps: ['normal', 'ao'],
  });
  if (!planned.ok) throw planned.error;
  const backing = model();
  backing.plane({
    width: p.width,
    height: p.height,
    center: [p.width / 2, p.height / 2, -p.backing],
  });
  backing.uv.project({ mode: 'planar', axis: 'z', scale: p.width });
  return { plan: planned.value, backing };
}

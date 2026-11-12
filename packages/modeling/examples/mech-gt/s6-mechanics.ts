import { type Model, model, proceduralMaterials, sel, type StandardMaterialOptions, type TextureSink } from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';
import { buildS3Mech } from './s3-rough.ts';
import { buildS5Internals } from './s5-chassis.ts';
import { buildS5JointsStowed } from './s5-joints.ts';

/**
 * Case C-100 stage S6 (code name mech-gt): the final mechanics, in the car-form rest pose.
 * `internals` is the S5 chassis, suspension, powertrain and harness; `core` is the S3 mech
 * volumes with the S5 joint mechanisms stowed at their car-form joints. Part tags stay
 * `part:<id>` (joint hardware `part:hw-<joint>-<kind>`), so the rig binds the same parts.
 * Both carry procedural materials; their faces are mostly hidden in the car form, so they
 * get no bake: uv0 and uv1 are box projections in meters.
 */
export const S6_MECHANICS = ['internals', 'core'] as const;
export type S6Mechanics = (typeof S6_MECHANICS)[number];

export function buildS6Mechanics(group: S6Mechanics, session: SessionFactory = () => model()): Model {
  const m = session(group);
  if (group === 'internals') m.append(buildS5Internals().snapshot());
  else {
    m.append(buildS3Mech().snapshot());
    m.append(buildS5JointsStowed().snapshot());
  }
  // The B4 recipes use `paint` for cylinder barrels; here they are hydraulic red, distinct from the body paint.
  if (m.count(sel.material('paint')) > 0) m.assign(sel.material('paint'), 'hydraulic');
  m.checkpoint('parts');
  for (const channel of ['uv0', 'uv1'] as const) m.uv.project({ mode: 'box', scale: 1, faces: sel.all(), channel });
  return m;
}

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: Error }): T => {
  if (!r.ok) throw r.error;
  return r.value;
};

/** The mechanics material set: one Standard recipe per slot, tiling textures on uv1. */
export function s6MechanicsMaterials(options: { readonly mips?: boolean } = {}): Record<string, (texture: TextureSink) => StandardMaterialOptions> {
  const placement = { set: 1, ...(options.mips === false ? { mips: false } : {}) } as const;
  const plain = (color: readonly [number, number, number], metallic: number, roughness: number) => () => ({ baseColor: [color[0], color[1], color[2], 1], metallic, roughness }) as StandardMaterialOptions;
  return {
    carbon: (texture) => unwrap(proceduralMaterials.carbonFiber({ texture, placement })),
    steel: (texture) => unwrap(proceduralMaterials.metal({ finish: 'satin', texture, color: [0.56, 0.57, 0.6], placement, key: 'steel' })),
    chrome: () => unwrap(proceduralMaterials.metal({ finish: 'chrome' })),
    alu: (texture) => unwrap(proceduralMaterials.metal({ finish: 'brushed', texture, color: [0.78, 0.79, 0.8], placement, key: 'alu' })),
    disc: (texture) => unwrap(proceduralMaterials.metal({ finish: 'brushed', texture, color: [0.45, 0.45, 0.46], placement, key: 'brake' })),
    hub: () => unwrap(proceduralMaterials.metal({ finish: 'chrome' })),
    engine: (texture) => unwrap(proceduralMaterials.metal({ finish: 'satin', texture, color: [0.2, 0.2, 0.22], placement, key: 'engine' })),
    motor: (texture) => unwrap(proceduralMaterials.metal({ finish: 'satin', texture, color: [0.12, 0.2, 0.32], placement, key: 'motor' })),
    battery: plain([0.08, 0.09, 0.1], 0, 0.7),
    harness: plain([0.9, 0.42, 0.05], 0, 0.55),
    spring: plain([0.85, 0.7, 0.08], 0.6, 0.35),
    hydraulic: plain([0.72, 0.06, 0.05], 0.3, 0.35),
    core: (texture) => unwrap(proceduralMaterials.metal({ finish: 'satin', texture, color: [0.26, 0.28, 0.31], placement, key: 'armor' })),
  };
}

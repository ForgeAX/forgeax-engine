import type { Point2 } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { CONSOLE_RANGES, centerConsole, DASH_RANGES, dashboard, SEAT_RANGES, STEERING_RANGES, seat, steeringWheel } from '../s6c-cockpit';
import { diffuserFins, doorHandle, doorMirror, EXHAUST_RANGES, exhaust, FIN_RANGES, HANDLE_RANGES, HINGE_RANGES, intakeMesh, intakeVanes, LAMP_RANGES, lampCavity, MESH_RANGES, MIRROR_RANGES, scissorHinge, VANE_RANGES, WIPER_RANGES, wiper } from '../s6c-details';
import type { DetailPart } from '../s6c-kit';
import { FLOOR_RANGES, floorPanel, TOW_RANGES, towCover } from '../s6c-underbody';
import { archLiner, brakeDisc, CALIPER_RANGES, caliper, DISC_RANGES, forgedWheel, LINER_RANGES, WHEEL_RANGES } from '../s6c-wheels';

/**
 * C-100 stage S6c: every declared recipe range is its validated domain. Each range end
 * alone, then every parameter at its minimum and every one at its maximum, builds a
 * detail that validates with no issue above info.
 */
type Ranges = Readonly<Record<string, readonly [number, number]>>;
type Build = (p: Record<string, number>) => { ok: true; value: DetailPart } | { ok: false; error: Error };

function cases(ranges: Ranges): Record<string, number>[] {
  const keys = Object.keys(ranges);
  const out: Record<string, number>[] = [];
  for (const k of keys) for (const v of ranges[k] as readonly number[]) out.push({ [k]: v });
  out.push(Object.fromEntries(keys.map((k) => [k, (ranges[k] as readonly number[])[0] as number])));
  out.push(Object.fromEntries(keys.map((k) => [k, (ranges[k] as readonly number[])[1] as number])));
  return out;
}

function sweep(build: Build, ranges: Ranges): string[] {
  const failures: string[] = [];
  for (const p of cases(ranges)) {
    let r: ReturnType<Build>;
    try {
      r = build(p);
    } catch (e) {
      failures.push(`${JSON.stringify(p)} threw ${(e as Error).message.slice(0, 160)}`);
      continue;
    }
    if (!r.ok) {
      failures.push(`${JSON.stringify(p)} ${r.error.message.slice(0, 160)}`);
      continue;
    }
    const issues = r.value.model.validate().issues.filter((i) => i.severity !== 'info');
    if (issues.length > 0) failures.push(`${JSON.stringify(p)} ${[...new Set(issues.map((i) => i.code))].join(',')}`);
  }
  return failures;
}

const rect = (w: number, h: number): Point2[] => [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
const trap: Point2[] = [[-0.2, -0.05], [0.22, -0.04], [0.16, 0.06], [-0.18, 0.05]];
// A concave side-intake like the blueprint's: a thin band descending forward over a V-shaped opening.
const chevron: Point2[] = [[-0.36, 0.24], [0.34, 0.1], [0.34, 0.07], [0.25, -0.05], [0.1, -0.2], [0, -0.24], [-0.1, -0.2], [-0.2, -0.05], [-0.25, 0.183], [-0.36, 0.205]];
// The form line's blueprint side intake in its anchor frame (S6a lines batch).
const blueprintIntake: Point2[] = [[-0.2991, 0.3116], [-0.0733, 0.2509], [0.0649, 0.2114], [0.1032, 0.1979], [0.1185, 0.1899], [-0.1269, -0.0397], [-0.1556, -0.0676], [-0.1674, -0.0814], [-0.166, -0.0925], [-0.1475, -0.1133], [-0.1275, -0.1323], [-0.1019, -0.1515], [-0.0906, -0.1575], [-0.076, -0.1624], [-0.0626, -0.1644], [-0.0437, -0.1645], [0.008, -0.157], [0.0605, -0.143], [0.078, -0.1359], [0.0912, -0.1283], [0.1208, -0.1008], [0.367, 0.1675], [0.3619, 0.1779], [0.2679, 0.2056], [-0.0038, 0.2763]];
const OUTLINES = { small: rect(0.2, 0.08), wide: rect(0.5, 0.12), trapezoid: trap } as const;

// biome-ignore lint/suspicious/noExplicitAny: the sweep passes partial parameter sets to typed recipes
const any = (r: unknown) => r as any;

const RECIPES: Record<string, () => string[]> = {
  seat: () => sweep((p) => any(seat({ name: 's', ...p })), SEAT_RANGES),
  steeringWheel: () => sweep((p) => any(steeringWheel({ name: 'w', ...p })), STEERING_RANGES),
  dashboard: () => sweep((p) => any(dashboard({ name: 'd', ...p })), DASH_RANGES),
  centerConsole: () => sweep((p) => any(centerConsole({ name: 'c', ...p })), CONSOLE_RANGES),
  lampY: () => Object.values(OUTLINES).flatMap((outline) => sweep((p) => any(lampCavity({ name: 'l', outline, depth: 0.1, projectors: 1, signature: 'y', light: 'headlight', ...p })), LAMP_RANGES)),
  lampHex: () => Object.values(OUTLINES).flatMap((outline) => sweep((p) => any(lampCavity({ name: 'l', outline, depth: 0.1, projectors: 0, signature: 'hex', light: 'taillight', ...p })), LAMP_RANGES)),
  intakeMesh: () => Object.values(OUTLINES).flatMap((outline) => sweep((p) => any(intakeMesh({ name: 'm', outline, ...p })), MESH_RANGES)),
  intakeVanes: () => [...Object.values(OUTLINES), chevron, blueprintIntake].flatMap((outline) => sweep((p) => any(intakeVanes({ name: 'v', outline, ...p })), VANE_RANGES)),
  doorMirror: () => sweep((p) => any(doorMirror({ name: 'm', ...p })), MIRROR_RANGES),
  wiper: () => sweep((p) => any(wiper({ name: 'w', ...p })), WIPER_RANGES),
  exhaust: () => sweep((p) => any(exhaust({ name: 'e', ...p })), EXHAUST_RANGES),
  diffuserFins: () => sweep((p) => any(diffuserFins({ name: 'f', ...p })), FIN_RANGES),
  doorHandle: () => sweep((p) => any(doorHandle({ name: 'h', ...p })), HANDLE_RANGES),
  scissorHinge: () => sweep((p) => any(scissorHinge({ name: 'g', ...p })), HINGE_RANGES),
  forgedWheel: () => sweep((p) => any(forgedWheel({ name: 'w', diameter: 0.5, width: 0.26, ...p })), WHEEL_RANGES),
  brakeDisc: () => sweep((p) => any(brakeDisc({ name: 'd', radius: 0.18, ...p })), DISC_RANGES),
  caliper: () => sweep((p) => any(caliper({ name: 'c', disc: 0.18, thickness: 0.034, ...p })), CALIPER_RANGES),
  archLiner: () => sweep((p) => any(archLiner({ name: 'a', radius: 0.36, width: 0.3, ...p })), LINER_RANGES),
  floorPanel: () => sweep((p) => any(floorPanel({ name: 'f', width: 1, length: 1, ...p })), FLOOR_RANGES),
  towCover: () => sweep((p) => any(towCover({ name: 't', ...p })), TOW_RANGES),
};

describe('C-100 S6c recipe ranges are their validated domain', () => {
  it.each(Object.keys(RECIPES))('%s', { timeout: 300000 }, (name) => {
    expect((RECIPES[name] as () => string[])().join('\n')).toBe('');
  });
});

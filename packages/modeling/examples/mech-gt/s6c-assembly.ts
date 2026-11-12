import { type Model, model, sel, type StandardMaterialOptions, type TextureSink } from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';
import { gtPaintScheme, stencilMaterial, stencilSlot } from './s6b-paint.ts';
import { bodyAnchors, CABIN } from './s6c-anchors.ts';
import { centerConsole, dashboard, pedalBox, seat, steeringWheel } from './s6c-cockpit.ts';
import { diffuserFins, doorHandle, doorMirror, exhaust, intakeMesh, intakeVanes, lampCavity, scissorHinge, wiper } from './s6c-details.ts';
import { type Anchor, add3, type DetailPart, mount, S6C_STENCILS, scale3, unit3, unwrapPart } from './s6c-kit.ts';
import { floorPanel, towCover } from './s6c-underbody.ts';
import { archLiner, brakeDisc, caliper, forgedWheel } from './s6c-wheels.ts';
import { WHEELS } from './s2-body.ts';

/**
 * Case C-100 stage S6c (code name mech-gt): the cockpit and the exterior details placed on
 * the car, one Pack per group. Every face carries the host's `part:<id>` (so the S4/S7
 * rig binds it with that part), `detail:<name>` and, for mirrored pairs, `side:l|r`.
 */
export const S6C_GROUPS = ['cockpit', 'front', 'side', 'rear', 'wheels', 'underbody'] as const;
export type S6cGroup = (typeof S6C_GROUPS)[number];

/** A placed detail: the recipe result and its anchor; `pair` details are built left and mirrored. */
interface Placement {
  readonly detail: () => DetailPart;
  readonly anchor: Anchor;
  readonly pair: boolean;
}

function placements(group: S6cGroup): Placement[] {
  const body = bodyAnchors();
  const a = (key: string): Anchor => {
    const found = body[key];
    if (found === undefined) throw new Error(`no anchor ${key}`);
    return found;
  };
  const outline = (key: string) => a(key).outline ?? [];
  switch (group) {
    case 'cockpit':
      return [
        { detail: () => unwrapPart(seat({ name: 'seat-l', shell: 0.012 })), anchor: CABIN['seat-l'], pair: false },
        { detail: () => unwrapPart(seat({ name: 'seat-r', shell: 0.012 })), anchor: CABIN['seat-r'], pair: false },
        { detail: () => unwrapPart(steeringWheel({ name: 'steering-wheel', column: 0.12 })), anchor: CABIN.wheel, pair: false },
        { detail: () => unwrapPart(dashboard({ name: 'dashboard', width: 1.12 })), anchor: CABIN.dash, pair: false },
        { detail: () => unwrapPart(centerConsole({ name: 'console', length: 0.9, channel: 0.12, clearance: 0.25 })), anchor: CABIN.console, pair: false },
        { detail: () => unwrapPart(pedalBox({ name: 'pedals' })), anchor: CABIN.pedals, pair: false },
      ];
    case 'front':
      return [
        { detail: () => unwrapPart(lampCavity({ name: 'headlight', outline: outline('headlight-cavity-l'), depth: 0.11, projectors: 2, signature: 'y', light: 'headlight', lens: true })), anchor: a('headlight-cavity-l'), pair: true },
        { detail: () => unwrapPart(intakeMesh({ name: 'front-intake', outline: outline('front-intake-l'), pitch: 0.02 })), anchor: a('front-intake-l'), pair: true },
        { detail: () => unwrapPart(wiper({ name: 'wiper-driver', arm: 0.46, blade: 0.6 })), anchor: a('wiper-pivot-l'), pair: false },
        { detail: () => unwrapPart(wiper({ name: 'wiper-passenger', arm: 0.36, blade: 0.5 })), anchor: a('wiper-pivot-c'), pair: false },
      ];
    case 'side':
      return [
        { detail: () => unwrapPart(doorMirror({ name: 'mirror', reach: 0.06, width: 0.14, forward: 0.132, lift: 0.075, length: 0.24, height: 0.11 })), anchor: a('mirror-l'), pair: true },
        { detail: () => unwrapPart(doorHandle({ name: 'door-handle' })), anchor: a('door-handle-l'), pair: true },
        { detail: () => unwrapPart(scissorHinge({ name: 'door-hinge', stencil: S6C_STENCILS.hydraulic })), anchor: a('door-hinge-l'), pair: true },
        { detail: () => unwrapPart(intakeVanes({ name: 'side-intake', outline: outline('side-intake-l'), count: 6, chord: 0.07, angle: 18 })), anchor: a('side-intake-l'), pair: true },
      ];
    case 'wheels':
      return WHEELS.filter((w) => w.x > 0).flatMap((w): Placement[] => {
        const axle = w.z > 0 ? 'front' : 'rear';
        const anchor = (part: string): Anchor => ({ part, origin: [w.x, w.d / 2, w.z], normal: [1, 0, 0], tangent: [0, 0, 1] });
        const disc = w.rim / 2 - 0.08;
        const hub = (w.w / 2) * 0.92 - 0.05 - 0.05 - 0.001;
        const liner = { radius: w.d / 2 + 0.014, width: w.w + 0.05, offset: -0.03 };
        return [
          { detail: () => unwrapPart(forgedWheel({ name: `${axle}-wheel`, diameter: w.rim, width: w.w })), anchor: anchor(`${axle}-wheel-l`), pair: true },
          { detail: () => unwrapPart(brakeDisc({ name: `${axle}-disc`, radius: disc, offset: -0.03, hat: hub })), anchor: anchor(`${axle}-wheel-l`), pair: true },
          { detail: () => unwrapPart(caliper({ name: `${axle}-caliper`, disc, thickness: 0.034, offset: -0.03, pistons: axle === 'front' ? 3 : 2 })), anchor: anchor(`${axle}-wheel-l`), pair: true },
          ...(axle === 'front'
            ? // The front fender pops 0.15 m straight outboard while the wheel stays: its liner is the arch lip outboard of the tire's outer shoulder, so the slide clears the tread.
              [{ detail: () => unwrapPart(archLiner({ name: 'front-liner', radius: liner.radius, width: 0.03, offset: w.w / 2 + 0.005 + 0.015 })), anchor: anchor('front-fender-l'), pair: true }]
            : [
                { detail: () => unwrapPart(archLiner({ name: 'rear-liner-fore', ...liner, half: 'fore' })), anchor: anchor('rear-fender-l-front'), pair: true },
                { detail: () => unwrapPart(archLiner({ name: 'rear-liner-aft', ...liner, half: 'aft' })), anchor: anchor('rear-fender-l-rear'), pair: true },
              ]),
        ];
      });
    case 'underbody': {
      const floor = (part: string, z0: number, z1: number): Anchor => ({ part, origin: [0, 0.1265, (z0 + z1) / 2], normal: [0, -1, 0], tangent: [1, 0, 0] });
      return [
        { detail: () => unwrapPart(floorPanel({ name: 'floor-front', width: 1.2, length: 1.04, vortex: 8, fasteners: 6 })), anchor: floor('front-subframe', 1.05, 2.09), pair: false },
        // The band under the tub (|x| <= 0.6, z -0.42..0.98) is the robot's belly and chest (S6b): only the sill strips beside it here.
        { detail: () => unwrapPart(floorPanel({ name: 'floor-sill', width: 0.18, length: 1.38, channels: 0, fasteners: 9, stencil: S6C_STENCILS.noStep })), anchor: { ...floor('monocoque', -0.42, 0.98), origin: [0.71, 0.1265, 0.28] }, pair: true },
        { detail: () => unwrapPart(floorPanel({ name: 'floor-rear', width: 1.2, length: 1.48, strakes: 4, fasteners: 8 })), anchor: floor('rear-subframe', -2.1, -0.62), pair: false },
        { detail: () => unwrapPart(towCover({ name: 'tow-cover-front' })), anchor: a('tow-front'), pair: false },
        { detail: () => unwrapPart(towCover({ name: 'tow-cover-rear' })), anchor: a('tow-rear'), pair: false },
      ];
    }
    case 'rear':
      return [
        { detail: () => unwrapPart(lampCavity({ name: 'taillight', outline: outline('taillight-cavity-l'), depth: 0.08, signature: 'hex', light: 'taillight', lens: true })), anchor: a('taillight-cavity-l'), pair: true },
        // The rear centre splits on x = 0 (S4 v3: each half rides its own heel): one tip and three fins per half, clear of the shut line.
        { detail: () => unwrapPart(exhaust({ name: 'exhaust', tips: 1, size: 0.05, length: 0.14 })), anchor: across(a('exhaust'), 0.08), pair: true },
        { detail: () => unwrapPart(diffuserFins({ name: 'diffuser-fins', count: 3, length: 0.32, height: 0.06, spacing: 0.18, stencil: S6C_STENCILS.number })), anchor: across(a('diffuser-fins'), 0.245), pair: true },
      ];
  }
}

/** An anchor moved `d` along its tangent: a centred anchor's left-half spot. */
const across = (a: Anchor, d: number): Anchor => ({ ...a, origin: add3(a.origin, scale3(unit3(a.tangent), d)) });

/** The right-hand host part of a left-hand one (`door-l-outer` -> `door-r-outer`). */
const rightOf = (part: string) => part.replace(/-l(-|$)/, '-r$1');

/** One placed detail (a mirrored pair when `pair`), appended to `m`; returns its named pieces. */
function place(m: Model, p: Placement): { readonly name: string; readonly pieces: string[] } {
  const part = p.detail();
  if (!p.pair) {
    mount(m, part, p.anchor);
    return { name: part.name, pieces: [...part.pieces] };
  }
  const both = model();
  const left = model();
  mount(left, part, { ...p.anchor, part: '' });
  both.append(left);
  both.mirror({ axis: 'x' });
  const l = sel.side([0, 0, 0], [1, 0, 0], { by: 'centroid' });
  const r = sel.all().minus(l);
  both.tag(l, `part:${p.anchor.part}`);
  both.tag(l, 'side:l');
  // Mirroring would print the stencil text backwards: the right-hand copy drops its stencils.
  const stencils = Object.values(S6C_STENCILS).map((spec) => sel.material(stencilSlot(spec.key))).reduce((a, b) => a.or(b));
  if (both.count(r.and(stencils)) > 0) both.delete(r.and(stencils));
  both.tag(r, `part:${rightOf(p.anchor.part)}`);
  both.tag(r, 'side:r');
  if (both.poisoned !== undefined) throw both.poisoned;
  m.append(both);
  return { name: part.name, pieces: [...part.pieces.map((x) => `${x}-l`), ...part.pieces.filter((x) => !x.endsWith('-stencil')).map((x) => `${x}-r`)] };
}

/** One S6c group, every detail placed on its anchor; `pieces` lists the named sub-parts. */
export function buildS6c(group: S6cGroup, session: SessionFactory = () => model()): { readonly model: Model; readonly pieces: readonly string[] } {
  const m = session(`s6c-${group}`);
  const pieces: string[] = [];
  for (const p of placements(group)) {
    const placed = place(m, p);
    pieces.push(...placed.pieces);
    m.checkpoint(placed.name);
  }
  for (const [from, to] of Object.entries(S6C_TO_GT)) if (m.count(sel.material(from)) > 0) m.assign(sel.material(from), to);
  m.checkpoint('paint');
  if (m.poisoned !== undefined) throw m.poisoned;
  return { model: m, pieces };
}

/**
 * Criterion 12c: the recipes' working slots fold onto the shared mech-gt paint scheme
 * (`s6b-paint.ts`): paint, accent, structural grey, metal, glow, primer, glass. Two S6c
 * variants in the same family keep what the scheme lacks: white segmented lamps
 * (`gt-glow-white`, the S6 headlight recipe) and the quilted seat inserts
 * (`gt-paint-accent-quilt`, the accent with a quilt normal map).
 */
export const S6C_TO_GT: Readonly<Record<string, string>> = {
  paint: 'gt-paint',
  red: 'gt-paint-accent',
  caliper: 'gt-paint-accent',
  marker: 'gt-paint-accent',
  alcantara: 'gt-paint-accent-quilt',
  carbon: 'gt-frame',
  trim: 'gt-frame',
  mesh: 'gt-frame',
  rim: 'gt-metal',
  exhaust: 'gt-metal',
  steel: 'gt-metal-steel',
  chrome: 'gt-metal-steel',
  brake: 'gt-metal-steel',
  headlight: 'gt-glow-white',
  screen: 'gt-glow',
  taillight: 'gt-glow-red',
  amber: 'gt-glow-amber',
  leather: 'gt-primer',
  switch: 'gt-primer',
  rubber: 'gt-primer',
  liner: 'gt-primer',
  ceramic: 'gt-primer',
  glass: 'gt-glass',
};

/**
 * The S6 exterior's own slots on the same scheme, for renders that show the exterior with the
 * details (the case renderer publishes every cooked material, so the full S6 + S6c slot set
 * overflows it).
 */
export const S6_TO_GT: Readonly<Record<string, string>> = { ...S6C_TO_GT, louvre: 'gt-paint', 'number-l': 'gt-paint', 'number-r': 'gt-paint', badge: 'gt-metal-steel', underside: 'gt-frame', intake: 'gt-primer', tire: 'gt-primer', harness: 'gt-primer' };

/** The S6c material set: the shared gt-* scheme and the stencils S6c details carry. */
export function s6cMaterials(options: { readonly mips?: boolean; readonly weathered?: boolean } = {}): Record<string, (texture: TextureSink) => StandardMaterialOptions> {
  const out: Record<string, (texture: TextureSink) => StandardMaterialOptions> = { ...gtPaintScheme(options) };
  for (const spec of Object.values(S6C_STENCILS)) out[stencilSlot(spec.key)] = stencilMaterial(spec);
  return out;
}

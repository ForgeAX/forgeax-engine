import { executable } from '../../../../shader/src/__tests__/sdf-surface-root.fixture';
import {
  CARD_RADIOSITY_LINK_LAYOUT_WGSL,
  CARD_RADIOSITY_LINK_TRACE_WGSL,
} from '../../raytracing/card-radiosity-links';
import { GlobalSdfQueryStatus } from '../../raytracing/global-sdf-query';
import { irradianceFieldKernelWgsl } from '../../raytracing/irradiance-field';

/** Complete production-generated program, never an authored replacement trace. */
export function cardLinkStageSource(
  traversal: Parameters<typeof irradianceFieldKernelWgsl>[0],
): string {
  const source: unknown = Reflect.get(
    irradianceFieldKernelWgsl(traversal),
    'visibilityCardRadiosity',
  );
  if (typeof source !== 'string')
    throw new Error('Production visibilityCardRadiosity stage is missing');
  return source;
}

/** These two receiver pairs are from the unchanged source6e thin-wall readback.
 * This is an independent authored-slab oracle, not World traversal emulation. */
export const cardCrossWallLinks = [
  {
    name: 'filter-probe98-to97',
    a: [3.75, -1.375, -1.75],
    b: [3.75, -1.375, -3.75],
    formerSoftWeight: 0.7675000429153442,
  },
  {
    name: 'resolve-texel246-from97',
    a: [3.75, -1.375, -3.75],
    b: [3.25, -1.375, -2.75],
    formerSoftWeight: 0.30043102540331246,
  },
] as const;

export function authoredWallIntersects(a: readonly number[], b: readonly number[]): boolean {
  const low = [-4, -4, -3.24],
    high = [4, 4, -2.99];
  let first = 0,
    last = 1;
  for (let axis = 0; axis < 3; axis++) {
    const origin = a[axis] ?? NaN,
      direction = (b[axis] ?? NaN) - origin;
    if (!Number.isFinite(origin) || !Number.isFinite(direction))
      throw new Error('Oracle requires finite authored coordinates');
    const lo = low[axis] ?? NaN,
      hi = high[axis] ?? NaN;
    if (direction === 0) {
      if (origin < lo || origin > hi) return false;
    } else {
      first = Math.max(first, Math.min((lo - origin) / direction, (hi - origin) / direction));
      last = Math.min(last, Math.max((lo - origin) / direction, (hi - origin) / direction));
    }
  }
  return first <= last;
}

function functionBody(source: string, name: string): string {
  const at = source.indexOf(`fn ${name}(`);
  if (at < 0) throw new Error('Actual production helper missing');
  const first = source.indexOf('{', at);
  let depth = 1,
    end = first + 1;
  for (; depth > 0 && end < source.length; end++) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
  }
  if (depth !== 0) throw new Error('Unclosed production helper');
  return source.slice(first + 1, end - 1);
}

/** Execute the actual post-query scalar status suffix. The full vector guards,
 * endpoint bias and World query are compiled by Naga, not simulated by this test. */
export function cardLinkStatus(status: number): number {
  const body = functionBody(CARD_RADIOSITY_LINK_TRACE_WGSL, 'cardLinkVisible');
  const markers = [...body.matchAll(/let hit=traceWorld\([^;]+;/g)];
  if (markers.length !== 1) throw new Error('World query seam is not unique');
  const marker = markers[0];
  if (!marker || marker.index === undefined) throw new Error('World query seam missing');
  const suffix = body.slice(marker.index + marker[0].length);
  const actual = executable<number>(
    `fn actualCardLinkStatus(hit:Hit)->u32{${suffix}}`,
    'actualCardLinkStatus',
    'hit',
    {},
  );
  return actual({ state: { x: status } });
}

export interface CardLinkConsumerCase {
  readonly forward: number;
  readonly reverse: number;
  readonly texel: number;
  readonly epoch?: number;
  readonly model?: number;
  readonly ignoreStamp?: boolean;
  readonly removeMaskGuard?: boolean;
}

/** Actual production consumer predicates and stamp helper with controlled masks.
 * No SH/filter arithmetic, submitted GPU work or original contact is certified. */
export function cardLinkConsumer(
  stage: 'filterCardRadiosity' | 'resolveCardRadiosity',
  input: CardLinkConsumerCase,
): boolean {
  const source = irradianceFieldKernelWgsl('ray-query')[stage];
  const guards = [...source.matchAll(/if\((!cardLinksCurrent\(tile\)[\s\S]*?)\)\{continue;\}/g)];
  if (guards.length !== 1) throw new Error('Actual consumer link gate is not unique');
  let condition = guards[0]?.[1];
  if (!condition) throw new Error('Actual consumer gate missing');
  if (input.ignoreStamp) condition = condition.replace('!cardLinksCurrent(tile)||', 'false||');
  if (input.removeMaskGuard) condition = 'false';
  if (/[^\w\s.[\]()!<>=|&^+*/-]/.test(condition))
    throw new Error('Unsupported scalar mask predicate');
  const radiosity = { atlas: { y: 16, w: 16 }, sampling: { x: 4, w: 3 } };
  const row = (x: number, y: number, z: number, w: number) =>
    Object.assign([x, y, z, w], { x, y, z, w });
  const links = Array.from({ length: 273 }, () => row(0, 0, 0, 0));
  links[256] = row(input.forward, 0, 0, 0);
  links[257] = row(0, input.reverse, 0, 0);
  links[0] = row(input.texel, 0, 0, 0);
  links[272] = row(input.epoch ?? 3, 9, input.model ?? 3, 0);
  const probeBase = executable<number>(CARD_RADIOSITY_LINK_LAYOUT_WGSL, 'cardLinkProbeBase', '', {
    radiosity,
    cardProbeCount: () => 16,
  });
  const stamp = executable<number>(CARD_RADIOSITY_LINK_LAYOUT_WGSL, 'cardLinkStamp', 'tile', {
    radiosity,
    cardLinkProbeBase: probeBase,
  });
  const current = executable<boolean>(CARD_RADIOSITY_LINK_LAYOUT_WGSL, 'cardLinksCurrent', 'tile', {
    radiosity,
    links,
    cardLinkStamp: stamp,
  });
  const actual = Function(
    'tile,texel,tap,probe,index,neighbor,links,cardLinksCurrent,cardLinkProbeBase',
    `"use strict";return !(${condition.replace(/\b(\d+)u\b/g, '$1')});`,
  ) as (...args: unknown[]) => boolean;
  return actual(0, 0, 0, 0, 1, 0, links, current, probeBase);
}

export const unknownLinkStates = [
  GlobalSdfQueryStatus.stepBudget,
  GlobalSdfQueryStatus.missingField,
  GlobalSdfQueryStatus.outsideRegion,
  0xffffffff,
];

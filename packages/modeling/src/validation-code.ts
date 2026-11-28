export type ValidationCode =
  | 'topology-twin'
  | 'topology-loop'
  | 'topology-dead-reference'
  | 'face-degenerate'
  | 'face-nonplanar'
  | 'mesh-open'
  | 'mesh-inverted'
  | 'face-flipped'
  | 'self-intersection'
  | 'shell-overlap'
  | 'designed-contact'
  | 't-junction'
  | 'thin-wall'
  | 'isolated-vertex'
  | 'uv-missing'
  | 'uv-degenerate'
  | 'uv-overlap'
  | 'surface-quality'
  | 'edge-flow'
  | 'mesh-quality'
  | 'patch-layout'
  | 'shut-line'
  | 'bake'
  | 'surface'
  | 'texel-density'
  | 'drawing'
  | 'session-poisoned';

/** Every code, in union order; the exhaustive mapping below fails to compile when one is missing. */
export const VALIDATION_CODES = [
  'topology-twin',
  'topology-loop',
  'topology-dead-reference',
  'face-degenerate',
  'face-nonplanar',
  'mesh-open',
  'mesh-inverted',
  'face-flipped',
  'self-intersection',
  'shell-overlap',
  'designed-contact',
  't-junction',
  'thin-wall',
  'isolated-vertex',
  'uv-missing',
  'uv-degenerate',
  'uv-overlap',
  'surface-quality',
  'edge-flow',
  'mesh-quality',
  'patch-layout',
  'shut-line',
  'bake',
  'surface',
  'texel-density',
  'drawing',
  'session-poisoned',
] as const satisfies readonly ValidationCode[];

type Missing = Exclude<ValidationCode, (typeof VALIDATION_CODES)[number]>;
const assertComplete: [Missing] extends [never] ? true : never = true;
void assertComplete;

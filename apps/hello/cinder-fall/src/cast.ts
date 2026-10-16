import type { ParticleEffectSourceV3 } from '@forgeax/engine-vfx';

export const CINDER_STANDARD_MATERIAL = 'c1de0000-0000-7000-8000-000000000001';
export const CINDER_ADDITIVE_MATERIAL = 'c1de0000-0000-7000-8000-000000000002';
export const CINDER_ALPHA_MATERIAL = 'c1de0000-0000-7000-8000-000000000003';
const CINDER_SPHERE_MESH = '95730fd2-9846-5f84-8658-0b3c971eb263';

export type CinderFallPhase = 'release' | 'mid-travel' | 'impact' | 'burn' | 'fade' | 'complete';

export interface CinderFallCastInput {
  readonly seed: number;
  readonly origin: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  readonly impactAt: number;
}

export interface CinderFallSnapshot {
  readonly seed: number;
  readonly elapsed: number;
  readonly phase: CinderFallPhase;
  readonly impactCount: number;
  readonly impactAnchor?: readonly [number, number, number];
  readonly activeEffects: readonly ('cinder.travel' | 'cinder.impact' | 'cinder.burn')[];
}

const IMPACT_WINDOW = 0.35;
// Leave a fixed-tick observation inside the burn phase at roughly two seconds
// after impact for the browser checkpoint.
const BURN_WINDOW = 2.2;
const FADE_WINDOW = 8;

function lerp(
  origin: readonly [number, number, number],
  target: readonly [number, number, number],
  amount: number,
): readonly [number, number, number] {
  return [
    origin[0] + (target[0] - origin[0]) * amount,
    origin[1] + (target[1] - origin[1]) * amount,
    origin[2] + (target[2] - origin[2]) * amount,
  ];
}

/**
 * Project-private gameplay consumer. Its only clock is `advanceFixed`; the
 * renderer observes the resulting snapshot and never schedules gameplay.
 */
export class CinderFallCast {
  readonly #input: CinderFallCastInput;
  #elapsed = 0;
  #impactCount = 0;
  #impactAnchor: readonly [number, number, number] | undefined;

  constructor(input: CinderFallCastInput) {
    if (!Number.isFinite(input.seed) || !Number.isFinite(input.impactAt) || input.impactAt <= 0) {
      throw new TypeError('CinderFallCast requires a finite positive impactAt');
    }
    this.#input = {
      ...input,
      origin: [...input.origin] as [number, number, number],
      target: [...input.target] as [number, number, number],
    };
  }

  /** The authored world-space impact target used by the GPU parameter block. */
  get target(): readonly [number, number, number] {
    return this.#input.target;
  }

  advanceFixed(delta: number): CinderFallSnapshot {
    if (!Number.isFinite(delta) || delta < 0) throw new TypeError('CinderFallCast delta must be finite and non-negative');
    const previous = this.#elapsed;
    this.#elapsed += delta;
    if (this.#impactCount === 0 && previous < this.#input.impactAt && this.#elapsed >= this.#input.impactAt) {
      this.#impactCount = 1;
      this.#impactAnchor = [...this.#input.target] as [number, number, number];
    }
    return this.snapshot();
  }

  /** Reset the project-owned gameplay clock to the authored release state. */
  replay(): CinderFallSnapshot {
    this.#elapsed = 0;
    this.#impactCount = 0;
    this.#impactAnchor = undefined;
    return this.snapshot();
  }

  snapshot(): CinderFallSnapshot {
    const travelProgress = Math.min(1, this.#elapsed / this.#input.impactAt);
    const afterImpact = this.#elapsed - this.#input.impactAt;
    const isReleaseTick = this.#elapsed > 0 && this.#elapsed <= 1 / 60 + 1e-6;
    const phase: CinderFallPhase =
      this.#impactCount === 0
        ? this.#elapsed === 0
          ? 'release'
          : isReleaseTick
            ? 'release'
            : 'mid-travel'
        : afterImpact < IMPACT_WINDOW
          ? 'impact'
          : afterImpact < BURN_WINDOW
            ? 'burn'
            : afterImpact < FADE_WINDOW
              ? 'fade'
              : 'complete';
    const activeEffects: CinderFallSnapshot['activeEffects'] =
      phase === 'release' || phase === 'mid-travel'
        ? ['cinder.travel']
        : phase === 'impact'
          ? ['cinder.impact', 'cinder.burn']
          : phase === 'burn' || phase === 'fade'
            ? ['cinder.burn']
            : [];
    return {
      seed: this.#input.seed,
      elapsed: this.#elapsed,
      phase,
      impactCount: this.#impactCount,
      ...(this.#impactAnchor === undefined
        ? { impactAnchor: lerp(this.#input.origin, this.#input.target, travelProgress) }
        : { impactAnchor: this.#impactAnchor }),
      activeEffects,
    };
  }
}

/** The app's public V3 effect declaration; cooking remains a build-time concern. */
export const CINDER_FALL_SOURCE: ParticleEffectSourceV3 = {
  schemaVersion: 3,
  emitters: [
    {
      id: 'cinder.travel',
      capacity: 64,
      backend: { required: 'gpu' },
      space: 'world',
      bounds: { kind: 'sphere', center: [0, 0, 0], radius: 64 },
      schedule: { rate: 0, bursts: [{ time: 0, count: 8 }] },
      program: { module: 'cinder-travel' },
      channels: [{ id: 'impact', payload: 'impact', capacity: 8, overflow: 'drop-newest' }],
      events: [{ id: 'travel-impact', channel: 'impact', subEmitter: 'cinder.impact', fanOut: 1, recursionDepth: 1 }],
      renderers: [
        { kind: 'mesh', enabled: false, material: CINDER_STANDARD_MATERIAL, mesh: CINDER_SPHERE_MESH, lighting: 'standard', castShadows: true, receiveShadows: true },
        {
          kind: 'billboard',
          material: CINDER_ADDITIVE_MATERIAL,
          sorting: 'custom-ascending',
          attributes: { sort: { source: 'custom', name: 'heat' } },
          materialInputs: ['heat'],
        },
        {
          kind: 'billboard',
          enabled: false,
          material: CINDER_ADDITIVE_MATERIAL,
          sorting: 'custom-descending',
          attributes: { sort: { source: 'custom', name: 'heat' } },
          materialInputs: ['heat'],
        },
        { kind: 'trail', material: CINDER_ADDITIVE_MATERIAL, historyLength: 6, capacity: 32, width: 0.024, taper: 0.7 },
      ],
    },
    {
      id: 'cinder.impact',
      capacity: 128,
      backend: { required: 'gpu' },
      space: 'world',
      bounds: { kind: 'sphere', center: [0, 0, 0], radius: 16 },
      schedule: { rate: 0, bursts: [{ time: 0, count: 16 }] },
      program: { module: 'cinder-impact' },
      channels: [{ id: 'burn', payload: 'impact', capacity: 8, overflow: 'drop-newest' }],
      events: [{ id: 'impact-burn', channel: 'burn', subEmitter: 'cinder.burn', fanOut: 1, recursionDepth: 1 }],
      renderers: [
        { kind: 'mesh', material: CINDER_STANDARD_MATERIAL, mesh: CINDER_SPHERE_MESH, lighting: 'standard', castShadows: true, receiveShadows: true },
        {
          kind: 'billboard',
          material: CINDER_ADDITIVE_MATERIAL,
          sorting: 'custom-descending',
          attributes: { sort: { source: 'custom', name: 'heat' } },
          materialInputs: ['heat'],
        },
        {
          kind: 'ribbon',
          enabled: false,
          material: CINDER_ADDITIVE_MATERIAL,
          stripKey: 'alive-index',
          capacity: 32,
          facing: 'velocity',
          width: 0.008,
        },
        {
          kind: 'beam',
          enabled: false,
          material: CINDER_ADDITIVE_MATERIAL,
          endpointField: 'velocity',
          capacity: 16,
          width: 0.01,
        },
      ],
    },
    {
      id: 'cinder.burn',
      capacity: 64,
      backend: { required: 'gpu' },
      space: 'world',
      bounds: { kind: 'sphere', center: [0, 0, 0], radius: 12 },
      schedule: { rate: 1.5, bursts: [{ time: 0, count: 8 }] },
      program: { module: 'cinder-burn' },
      renderers: [
        // Keep the footprint in the billboard layer for now. A shared
        // sphere mesh would draw eight coplanar shells and over-composite
        // into a white ring; the alpha sprites provide the same grounded
        // signal without z-fighting.
        { kind: 'mesh', enabled: false, material: CINDER_ALPHA_MATERIAL, mesh: CINDER_SPHERE_MESH, lighting: 'standard', receiveShadows: true },
        { kind: 'billboard', material: CINDER_ALPHA_MATERIAL, sorting: 'view-depth' },
        {
          kind: 'billboard',
          enabled: false,
          material: CINDER_ADDITIVE_MATERIAL,
          sorting: 'custom-descending',
          attributes: { sort: { source: 'custom', name: 'heat' } },
          materialInputs: ['heat'],
        },
      ],
    },
  ],
};

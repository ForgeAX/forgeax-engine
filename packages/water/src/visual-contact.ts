import type { WaterSplashWakeEvent } from './buoyancy.js';

/** Confirmed CPU query contact; this does not represent a force or GPU fluid sample. */
export interface WaterVisualContact {
  readonly kind: 'visual-probe';
  readonly sourceIdentity: string;
  readonly sourcePhysicsStep: number;
  readonly queryTimeSeconds: number;
  readonly rootEntity: number;
  readonly rootGeneration: number;
  readonly probeId: string;
  readonly bodyGuid: string;
  readonly bodyGeneration: number;
  readonly phase: 'contact';
  readonly coverage: number;
  readonly contact: Extract<WaterSplashWakeEvent['contact'], { kind: 'water-plane-intersection' }>;
}

export interface WaterVisualContactState {
  readonly roots: readonly Readonly<{
    rootEntity: number;
    rootGeneration: number;
    sourceIdentity: string;
  }>[];
  readonly contacts: readonly WaterVisualContact[];
  readonly failures: readonly Readonly<{
    entity: number;
    code:
      | 'water-contact-probes-invalid'
      | 'water-contact-body-unavailable'
      | 'water-contact-dynamics-unavailable'
      | 'water-contact-query-failed';
    detail: unknown;
  }>[];
}

import { defineResource } from '@forgeax/engine-ecs';
import type { Result } from '@forgeax/engine-types';
import type {
  WaterBuoyancyFailure,
  WaterBuoyancyForceEvent,
  WaterBuoyancyStep,
  WaterSplashWakeEvent,
} from './buoyancy.js';
import type { WaterSystem } from './system.js';
import type { WaterVisualContactState } from './visual-contact.js';

export interface WaterBuoyancyState {
  /** Third enable gate, in addition to backend worker results and per-component opt-in. */
  asyncEnabled: boolean;
  async: Readonly<{
    execution: 'disabled' | 'worker-solver' | 'unsupported';
    submitted: number;
    completed: number;
    cancelled: number;
    rejected: number;
    pending: number;
    resultsTimeSeconds?: number;
    selections: readonly Readonly<{
      entity: number;
      currentTaskId?: number;
      nextTaskId?: number;
      alpha: number;
      sourceStep?: number;
      solveStep?: number;
      referenceTimeSeconds?: number;
      outputTimestampSeconds?: number;
    }>[];
  }>;
  /** Current pre-simulation attempts. An error never hides the last completed dynamics. */
  steps: readonly Readonly<{
    entity: number;
    result: Result<WaterBuoyancyStep, WaterBuoyancyFailure>;
  }>[];
  forceEvents: readonly WaterBuoyancyForceEvent[];
  /** Published after writeback/collision completion, for the next VFX consumer. */
  splashWakeEvents: readonly WaterSplashWakeEvent[];
}

/** Shared producer/consumer identities. Diagnostic names never select resources. */
export const WATER_SYSTEM_RESOURCE = defineResource<WaterSystem>('WaterSystem');
export const WATER_BUOYANCY_RESOURCE = defineResource<WaterBuoyancyState>('WaterBuoyancy');
export const WATER_VISUAL_CONTACTS_RESOURCE =
  defineResource<WaterVisualContactState>('WaterVisualContacts');

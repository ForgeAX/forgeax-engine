// action-state.ts — action mapping pure-function module for forgeax-engine.
//
// Derives per-frame ActionState[] from an InputBackendSample and an InputMap.
// Zero ECS/DOM dependencies; fully node-testable.
//
// charter awareness:
//   P3 explicit failure — unmapped action names return empty signal, never throw
//   P4 consistent abstraction — consumer only sees action name, never device

import type { GamepadAxisIndex, GamepadButtonIndex, InputBackendSample } from './input-snapshot';

// ─── Types ───────────────────────────────────────────────────────

/**
 * Closed 4-member discriminant union for mapping raw input sources to actions.
 * The `type` field is the discriminant; consumers switch on it with no `default`
 * branch (AC-08b: TypeScript checks exhaustiveness at compile time).
 */
export type ActionBinding =
  | { readonly type: 'key'; readonly key: string }
  | { readonly type: 'mouseButton'; readonly button: 0 | 1 | 2 }
  | { readonly type: 'gamepadButton'; readonly button: GamepadButtonIndex }
  | {
      readonly type: 'gamepadAxis';
      readonly axis: GamepadAxisIndex;
      /**
       * Sign applied to the raw axis value before aggregation.
       * - Omitted: contributes |value| (trigger semantics, e.g. right trigger on axis 2).
       * - `1`: contributes max(0, value) (positive direction).
       * - `-1`: contributes max(0, -value) (negative direction, e.g. left stick).
       */
      readonly sign?: 1 | -1;
    };

/**
 * An action definition in the InputMap: a semantic name + one or more bindings
 * to raw input sources, plus an optional per-action deadzone override.
 */
export interface ActionConfig {
  /** Semantic action name (e.g. 'jump', 'moveRight'). Referenced by snap.action(name). */
  readonly action: string;
  /** Raw input bindings that contribute to this action. Aggregated via OR/MAX. */
  readonly bindings: readonly ActionBinding[];
  /**
   * Per-action deadzone applied to analog strength remapping.
   * Default: 0.2 (Godot prior-art, F2). Analog values with |raw| < deadzone
   * produce strength=0. Values >= deadzone are linearly remapped into [0,1].
   */
  readonly deadzone?: number;
}

/**
 * Per-frame derived action state. Returned by deriveActionStates(); consumed
 * by snap.action(name) readpoints. All fields are frame-frozen (AC-11).
 */
export interface ActionState {
  readonly action: string;
  /** Resolved at frame sampling; radial vector reads use this value. */
  readonly deadzone: number;
  /** true when ANY binding contributes a press (OR aggregation). */
  readonly pressed: boolean;
  /**
   * true only on the frame when pressed transitions false→true.
   * One-frame lifetime; held state does not re-fire (AC-03).
   */
  readonly justPressed: boolean;
  /**
   * true only on the frame when pressed transitions true→false.
   * One-frame lifetime (AC-03).
   */
  readonly justReleased: boolean;
  /**
   * Deadzone-remapped analog strength in [0, 1]. Digital press → 1.0.
   * Analog values < deadzone → 0. Aggregate: MAX across bindings.
   */
  readonly strength: number;
  /**
   * Raw un-deadzoned magnitude in [0, 1]. Used by getVector (which applies its
   * own single radial deadzone to avoid per-axis deadzone stacking, F2).
   * Aggregate: MAX across bindings.
   */
  readonly raw: number;
}

// ─── Constants ───────────────────────────────────────────────────

/**
 * Resource key for the immutable InputMap (ActionConfig[]) inserted into
 * the World. Canvas-form createApp does this automatically; assemble-form
 * hosts insert it directly (D-7).
 */
export const INPUT_MAP_KEY = 'InputMap';

/** Default per-action deadzone (Godot prior-art, F2). */
const DEFAULT_DEADZONE = 0.2;

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Inverse lerp: maps a value from [a, b] to [0, 1] linearly.
 * Returns 0 when val <= a, 1 when val >= b.
 */
function inverseLerp(a: number, b: number, val: number): number {
  if (val <= a) return 0;
  if (val >= b) return 1;
  return (val - a) / (b - a);
}

/**
 * Deadzone remap: maps |raw| from [deadzone, 1] to [0, 1].
 * |raw| < deadzone → 0. |raw| >= deadzone → inverse_lerp(deadzone, 1, |raw|).
 */
function applyDeadzone(rawAbs: number, deadzone: number): number {
  return rawAbs < deadzone ? 0 : inverseLerp(deadzone, 1, rawAbs);
}

/**
 * Extract the raw contribution from a single binding against the sample.
 * Returns the raw magnitude before the action-level deadzone.
 *
 * - Digital types (key/mouseButton/gamepadButton): rawAbs = 1.0 if pressed, 0 otherwise.
 * - Analog type (gamepadAxis): rawAbs = max(0, |value| or max(0, value*sign)).
 *   For gamepadAxis, aggregates across ALL connected standardMapping slots (D-9).
 */
function bindingContribution(binding: ActionBinding, sample: InputBackendSample): number {
  switch (binding.type) {
    case 'key': {
      const down = sample.downKeys.has(binding.key);
      return down ? 1 : 0;
    }
    case 'mouseButton': {
      const down = sample.buttons[binding.button] === true;
      return down ? 1 : 0;
    }
    case 'gamepadButton': {
      // D-9: aggregate across ALL connected standardMapping slots.
      const slots = sample.gamepads ?? [];
      let anyPressed = false;
      for (const slot of slots) {
        if (!slot.standardMapping) continue;
        if (slot.pressed.has(binding.button)) {
          anyPressed = true;
          break;
        }
      }
      return anyPressed ? 1 : 0;
    }
    case 'gamepadAxis': {
      // D-9: aggregate across ALL connected standardMapping slots (MAX).
      const slots = sample.gamepads ?? [];
      let maxRawAbs = 0;
      for (const slot of slots) {
        if (!slot.standardMapping) continue;
        const rawAxis = slot.axes[binding.axis];
        const sign = binding.sign;
        if (sign === undefined) {
          // Trigger semantics: contribute |value|
          const abs = Math.abs(rawAxis);
          if (abs > maxRawAbs) maxRawAbs = abs;
        } else if (sign === 1) {
          const v = Math.max(0, rawAxis);
          if (v > maxRawAbs) maxRawAbs = v;
        } else {
          // sign === -1
          const v = Math.max(0, -rawAxis);
          if (v > maxRawAbs) maxRawAbs = v;
        }
      }
      return maxRawAbs;
    }
  }
}

// ─── deriveActionStates ──────────────────────────────────────────

/**
 * Derive per-frame action states from a backend sample and an InputMap.
 *
 * Pure function with no side effects. Called once per frame by the
 * frame-start scan system. The result is frozen into the InputSnapshot
 * so all snap.action() calls in the same frame see identical state (AC-11).
 *
 * @param sample - One frame's raw input backend sample (POD).
 * @param inputMap - ActionConfig array; duplicate action names → last-wins (D-8).
 * @param prevActionStates - Previous frame's action states for edge diff
 *   (justPressed/justReleased derivation). Omitted on the first frame or
 *   when actions are not being tracked across frames.
 * @returns ActionState[] with one entry per action name in inputMap (last-wins dedup).
 */
export function deriveActionStates(
  sample: InputBackendSample,
  inputMap: readonly ActionConfig[],
  prevActionStates?: readonly ActionState[],
): ActionState[] {
  // D-8: last-wins dedup — later configs overwrite earlier for same action name.
  const deduped = new Map<string, ActionConfig>();
  for (const config of inputMap) {
    deduped.set(config.action, config);
  }

  // Build prev lookup for edge diff.
  const prevByAction = new Map<string, boolean>();
  if (prevActionStates) {
    for (const s of prevActionStates) {
      prevByAction.set(s.action, s.pressed);
    }
  }

  const results: ActionState[] = [];

  for (const config of deduped.values()) {
    const deadzone = config.deadzone ?? DEFAULT_DEADZONE;

    // Aggregate across all bindings: OR for pressed, MAX for strength/raw.
    let aggregatedPressed = false;
    let aggregatedStrength = 0;
    let aggregatedRaw = 0;

    for (const binding of config.bindings) {
      const rawAbs = bindingContribution(binding, sample);

      // Update raw: MAX aggregation.
      if (rawAbs > aggregatedRaw) aggregatedRaw = rawAbs;

      // Update pressed: need to consider analog deadzone threshold.
      if (rawAbs >= deadzone) {
        aggregatedPressed = true;
        const str = applyDeadzone(rawAbs, deadzone);
        if (str > aggregatedStrength) aggregatedStrength = str;
      }

      // Digital sources already contribute 1.0/0 rawAbs.
      // For digital, rawAbs=1.0 >= deadzone(0.2) → pressed=true, strength=applyDeadzone(1.0,0.2)=1.0.
    }

    // Edge detection: justPressed / justReleased from prev frame's pressed state.
    const prevPressed = prevByAction.get(config.action) ?? false;
    const justPressed = aggregatedPressed && !prevPressed;
    const justReleased = sample.focusReset !== true && !aggregatedPressed && prevPressed;

    results.push({
      action: config.action,
      deadzone,
      pressed: aggregatedPressed,
      justPressed,
      justReleased,
      strength: aggregatedStrength,
      raw: aggregatedRaw,
    });
  }

  return results;
}

// ─── getAxis / getVector ───────────────────────────────────────────

/**
 * Options for getVector deadzone override.
 */
export interface GetVectorOptions {
  /**
   * Override the default radial deadzone. When omitted, the deadzone is
   * computed as the average of the 4 per-action deadzones.
   */
  readonly deadzone?: number;
}

/**
 * Compose a 1D axis value from two opposing actions.
 *
 * Returns `strength(pos) - strength(neg)`, range [-1, 1].
 *
 * - Both registered: combines normally.
 * - One unregistered (E-3): contributes 0.
 * - Neither registered: returns 0.
 * - Same action for both ends (E-12): always 0.
 *
 * @param actionStates - Derived action states (from deriveActionStates).
 * @param neg - Action name for the negative direction (e.g. 'moveLeft').
 * @param pos - Action name for the positive direction (e.g. 'moveRight').
 */
export function getAxis(actionStates: readonly ActionState[], neg: string, pos: string): number {
  const posState = actionStates.find((s) => s.action === pos);
  const negState = actionStates.find((s) => s.action === neg);
  const posStrength = posState?.strength ?? 0;
  const negStrength = negState?.strength ?? 0;
  if (neg === pos) return 0;
  return posStrength - negStrength;
}

/**
 * Compose a 2D vector from four directional actions using a single radial
 * deadzone (Godot input.cpp three-branch formula, F2).
 *
 * Reads `raw` (not `strength`) from actionStates to avoid per-axis deadzone
 * stacking into a square deadzone. Applies one radial deadzone:
 *
 * - length <= deadzone → (0, 0)
 * - length > 1 → vector / length  (clamp to unit circle)
 * - otherwise → vector * inverse_lerp(deadzone, 1, length) / length
 *
 * Default deadzone = average of the 4 actions' per-action deadzones.
 * `opts.deadzone` overrides it.
 *
 * @param actionStates - Derived action states.
 * @param negX - Action name for negative X (e.g. 'moveLeft').
 * @param posX - Action name for positive X (e.g. 'moveRight').
 * @param negY - Action name for negative Y (e.g. 'moveUp').
 * @param posY - Action name for positive Y (e.g. 'moveDown').
 * @param opts - Optional override (deadzone).
 */
export function getVector(
  actionStates: readonly ActionState[],
  negX: string,
  posX: string,
  negY: string,
  posY: string,
  opts?: GetVectorOptions,
): { readonly x: number; readonly y: number } {
  // Look up raw values (not strength!) for each directional action.
  // getVector uses raw to avoid per-action deadzone stacking into a square
  // deadzone (F2: Godot getVector applies a SINGLE radial deadzone).
  const posXState = actionStates.find((s) => s.action === posX);
  const negXState = actionStates.find((s) => s.action === negX);
  const posYState = actionStates.find((s) => s.action === posY);
  const negYState = actionStates.find((s) => s.action === negY);

  const x = (posXState?.raw ?? 0) - (negXState?.raw ?? 0);
  const y = (posYState?.raw ?? 0) - (negYState?.raw ?? 0);

  // Compute radial deadzone.
  // Default = average of the 4 per-action deadzones, using only registered actions.
  const deadzone = opts?.deadzone ?? computeAverageDeadzone(actionStates, negX, posX, negY, posY);

  const length = Math.sqrt(x * x + y * y);

  // Three-branch formula (Godot input.cpp, F2):
  if (length <= deadzone) {
    // Below deadzone → zero vector (deadzone applied).
    return { x: 0, y: 0 };
  }
  if (length > 1) {
    // Clamp to unit circle.
    return { x: x / length, y: y / length };
  }
  // Intermediate zone: smoothly remap from deadzone→1 to 0→unit.
  // vec * inverse_lerp(deadzone, 1, length) / length
  const factor = inverseLerp(deadzone, 1, length) / length;
  return { x: x * factor, y: y * factor };
}

/**
 * Compute the average deadzone for 4 action names from the input map.
 * Actions not registered contribute DEFAULT_DEADZONE.
 */
function computeAverageDeadzone(
  actionStates: readonly ActionState[],
  negX: string,
  posX: string,
  negY: string,
  posY: string,
): number {
  const map = new Map(actionStates.map((state) => [state.action, state.deadzone]));
  const dzNegX = map.get(negX) ?? DEFAULT_DEADZONE;
  const dzPosX = map.get(posX) ?? DEFAULT_DEADZONE;
  const dzNegY = map.get(negY) ?? DEFAULT_DEADZONE;
  const dzPosY = map.get(posY) ?? DEFAULT_DEADZONE;
  return (dzNegX + dzPosX + dzNegY + dzPosY) / 4;
}

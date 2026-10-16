// virtual-joystick.ts -- pure-function virtual joystick derivation (M3).
//
// No DOM dependency; backend closure holds per-joystick bindState
// and calls deriveVirtualAxes each sample() frame.
//
// @internal -- only the browser backend calls these functions; the
// barrel does not re-export them.

import type { VirtualAxisSample, VirtualJoystickConfig } from './input-snapshot';

/**
 * Per-joystick binding state. The backend closure owns a
 * Map<string, BindState> keyed by joystick config name.
 */
export interface BindState {
  /** bound pointerId, or undefined if unbound */
  pointerId?: number | undefined;
  /** origin in canvas pixels (anchor for fixed, first-touch for floating) */
  originX: number;
  originY: number;
}

function computeVec(
  ptrX: number,
  ptrY: number,
  originX: number,
  originY: number,
  radius: number,
  deadzone: number,
): { x: number; y: number } {
  const rawX = (ptrX - originX) / radius;
  const rawY = (ptrY - originY) / radius;
  const mag = Math.sqrt(rawX * rawX + rawY * rawY);
  if (mag < deadzone) return { x: 0, y: 0 };
  if (mag > 1) {
    // Clamp to unit vector: normalize direction, magnitude = 1.
    return { x: rawX / mag, y: rawY / mag };
  }
  return { x: rawX, y: rawY };
}

/**
 * Derive one frame of virtual axis outputs from live pointer state and
 * per-joystick binding state.
 *
 * Pure function: no DOM access. The backend closure is the SSOT for
 * per-joystick state; binding + origin selection happens in
 * browser-backend.ts onPointerDown. This function only reads bindState
 * and computes per-frame vectors.
 *
 * Unbound joysticks always produce the zero vector.
 *
 * @param configs - configured virtual joysticks
 * @param pointerMap - live pointer positions keyed by pointerId
 * @param bindState - per-joystick binding state (read-only)
 * @returns one VirtualAxisSample per configured joystick
 */
export function deriveVirtualAxes(
  configs: readonly VirtualJoystickConfig[],
  pointerMap: Map<number, { readonly x: number; readonly y: number }>,
  bindState: Map<string, BindState>,
): VirtualAxisSample[] {
  const results: VirtualAxisSample[] = [];

  for (const cfg of configs) {
    const bs = bindState.get(cfg.name);

    if (bs?.pointerId !== undefined) {
      // Bound: compute vector from current pointer position.
      const ptr = pointerMap.get(bs.pointerId);
      if (ptr) {
        const vec = computeVec(ptr.x, ptr.y, bs.originX, bs.originY, cfg.radius, cfg.deadzone);
        results.push({ name: cfg.name, x: vec.x, y: vec.y });
      } else {
        // Pointer disappeared (up/cancel handled by backend unbind,
        // but this guards against pointer removal without unbind).
        bs.pointerId = undefined;
        results.push({ name: cfg.name, x: 0, y: 0 });
      }
    } else {
      // Unbound: zero vector. Binding is the backend's responsibility.
      results.push({ name: cfg.name, x: 0, y: 0 });
    }
  }

  return results;
}

/**
 * Unbind a joystick when its bound pointer goes up or is cancelled.
 * Sets pointerId to undefined; the next deriveVirtualAxes call will
 * produce a zero vector for the unbound joystick.
 */
export function handleVirtualJoystickUnbind(
  bindState: Map<string, BindState>,
  pointerId: number,
): void {
  for (const bs of bindState.values()) {
    if (bs.pointerId === pointerId) {
      bs.pointerId = undefined;
    }
  }
}

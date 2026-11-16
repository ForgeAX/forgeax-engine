/**
 * Plans a stream keeps tick slots it no longer fills before releasing them.
 * Long enough that a run of hitches reuses one graph shape; short enough that
 * one slow load does not leave every stream planning empty slots afterwards.
 */
export const TICK_CAPACITY_RETENTION_PLANS = 120;

export interface TickCapacityState {
  /** Tick slots the stream declares every plan. */
  tickCapacity: number;
  /** Largest admitted tick count since `tickWindowStart`. */
  tickWindowPeak: number;
  /** Plan serial that opened the current demand window. */
  tickWindowStart: number;
}

/**
 * Tick capacity follows recent demand. It grows in the plan that needs more
 * slots, and a plan that fills the capacity renews it. After a full window
 * below capacity it drops to that window's peak, so a steady multi-tick stream
 * keeps its slots while a single catch-up burst stops costing declarations.
 */
export function retainTickCapacity(
  state: TickCapacityState,
  admittedTicks: number,
  planSerial: number,
): void {
  const needed = Math.max(admittedTicks, 1);
  if (needed >= state.tickCapacity) {
    state.tickCapacity = needed;
    state.tickWindowPeak = 1;
    state.tickWindowStart = planSerial;
    return;
  }
  state.tickWindowPeak = Math.max(state.tickWindowPeak, needed);
  if (planSerial - state.tickWindowStart < TICK_CAPACITY_RETENTION_PLANS) return;
  state.tickCapacity = state.tickWindowPeak;
  state.tickWindowPeak = 1;
  state.tickWindowStart = planSerial;
}

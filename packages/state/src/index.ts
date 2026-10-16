// @forgeax/engine-state -- public barrel
//
// Single-entry surface for typed state definitions, transitions, lifecycle, and inspection.

export { inState } from './conditions';
export type {
  StateToken,
  StateTokenName,
  StateTokenVariant,
} from './define-state';
export { defineState } from './define-state';
export type {
  InvalidVariantDetail,
  StateAlreadyDefinedDetail,
  StateDefaultRequiredDetail,
  StateError,
  StateErrorCode,
  StateErrorDetail,
  StateNotRegisteredDetail,
} from './errors';
export type {
  StateCallback,
  UnsubscribeHandle,
} from './on-enter-on-exit';
export {
  addOnEnter,
  addOnExit,
  OnEnter,
  OnExit,
} from './on-enter-on-exit';
export { statePlugin } from './plugin-factory';
export { registerStatesPlugin, StateSet } from './register-plugin';
export {
  despawnOnEnter,
  despawnOnExit,
} from './scoped-component';
export {
  getPreviousState,
  getState,
  setNextState,
  setNextStateForce,
} from './set-next-state';

// @forgeax/engine-input -- public surface (charter F2 minimal surface).
//
// AI users:
//   - Insert the `InputBackend` producer as a World resource under
//     `INPUT_BACKEND_KEY`, then add the `InputFrameStartScan` system token to
//     the schedule. After `world.update()` runs, read the snapshot through
//     `world.getResource<InputSnapshot>('InputSnapshot')` (or the
//     re-exported `INPUT_SNAPSHOT_RESOURCE_KEY` constant).
//   - In a browser context, attach a PointerLock-aware producer with
//     `attachBrowserInputBackend(canvas)`; the returned callable is
//     both a detach handle and an `InputBackend`.
//   - For headless tests / pre-start fixtures, `createInputSnapshot()`
//     returns an empty snapshot whose accessors all evaluate to false /
//     `{ x: 0, y: 0 }` (charter P3: empty signal is the signal).
//
// Single import path:
//   import {
//     attachBrowserInputBackend,
//     INPUT_BACKEND_KEY,
//     InputFrameStartScan,
//     createInputSnapshot,
//     INPUT_SNAPSHOT_RESOURCE_KEY,
//     type InputSnapshot,
//     type InputBackend,
//   } from '@forgeax/engine-input';

export type {
  ActionBinding,
  ActionConfig,
  ActionState,
  GetVectorOptions,
} from './action-state';
export {
  deriveActionStates,
  getAxis,
  getVector,
  INPUT_MAP_KEY,
} from './action-state';
export {
  attachBrowserInputBackend,
  type BrowserInputBackendOptions,
  type PointerLockProvider,
} from './browser-backend';
export {
  type CanvasInputBoundary,
  createCanvasInputBoundary,
} from './canvas-input-boundary';
export {
  type CompositeBackendOptions,
  type CompositeInputBackend,
  type CompositeInputLease,
  makeCompositeBackend,
} from './composite-backend';
export {
  FRAME_START_SCAN_SYSTEM_NAME,
  INPUT_BACKEND_KEY,
  InputFrameStartScan,
  InputSet,
} from './frame-start-scan-system';
export type {
  GamepadFeedback,
  GamepadFeedbackAdmission,
  GamepadFeedbackIntent,
  GamepadFeedbackResult,
  GamepadFeedbackStatus,
  GamepadFeedbackTarget,
  GamepadRumble,
} from './gamepad-feedback';
export {
  createGamepadFeedback,
  GAMEPAD_FEEDBACK_CAPACITY,
  GAMEPAD_FEEDBACK_KEY,
  GAMEPAD_FEEDBACK_MAX_DURATION_MS,
} from './gamepad-feedback';
export type {
  GestureEvent,
  GestureState,
  SwipeDirection,
} from './gesture-recognizer';
export {
  DOUBLE_TAP_DISTANCE,
  DOUBLE_TAP_INTERVAL_MS,
  IDENTITY_GESTURE,
  LONG_PRESS_DURATION_MS,
  LONG_PRESS_SLOP,
  SWIPE_VELOCITY_THRESHOLD,
  SWIPE_WINDOW_MS,
} from './gesture-recognizer';
export type {
  Capabilities,
  GamepadAxisIndex,
  GamepadButtonIndex,
  GamepadSlotSample,
  InputBackend,
  InputBackendSample,
  InputSnapshot,
  MouseButtonIndex,
  PointerPhaseEvent,
  PointerSample,
  PointerType,
  VirtualAxisSample,
  VirtualJoystickConfig,
} from './input-snapshot';
export {
  createInputSnapshot,
  INPUT_SNAPSHOT_RESOURCE_KEY,
  snapshotFromSample,
} from './input-snapshot';
export { inputBackendPlugin, ownedInputBackendPlugin } from './plugin-service';
export {
  createUiInputResetBoundary,
  isUiOwnedEvent,
  resolveUiOwnership,
  type UiInputResetBoundary,
  type UiInputResetBoundaryOptions,
  type UiOwnershipResult,
} from './ui-ownership';

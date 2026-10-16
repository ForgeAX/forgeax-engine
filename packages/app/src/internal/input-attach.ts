import {
  attachBrowserInputBackend,
  type BrowserInputBackendOptions,
  type CompositeInputBackend,
  makeCompositeBackend,
  type PointerLockProvider,
  type VirtualJoystickConfig,
} from '@forgeax/engine-input';

import { APP_ERROR_HINTS, APP_EXPECTED, AppError } from '../errors';

/**
 * Handle returned by attachInputAuto. Captures the backend (exposed via
 * App.input), the detach callable, and a cleanup() funnel that the
 * frame-loop / app-stop / device-lost paths share (R-4).
 */
export interface InputAttachHandle {
  /** Browser backend decorated with the owner-scoped synthetic input lease. */
  readonly backend: CompositeInputBackend;
  cleanup(): void;
  /**
   * M2: install the error dispatch callback for onLockError events.
   * Must be called by createApp after the ErrorFanoutRegistry is created
   * (the dispatch function is created after attachInputAuto returns).
   * Idempotent — subsequent calls replace the previous callback.
   */
  setOnErrorDispatch(fn: (err: AppError) => void): void;
}

/**
 * Acquire a browser input backend. This Host helper owns only DOM listeners;
 * the Cordis input plugin owns every World resource and system contribution.
 */
/**
 * Options forwarded to attachBrowserInputBackend at attach time. Currently only
 * the neutral PointerLock gate (host decides whether a canvas click captures the
 * cursor); the backend stays host-opaque. Optional so existing call sites are
 * unchanged.
 */
export interface InputAttachOptions {
  /** Host-owned UI root used to route Shadow DOM events away from gameplay. */
  readonly uiRoot?: Node;
  readonly pointerLockAllowed?: () => boolean;
  /** M3: virtual joystick configurations passed through to browser backend. */
  readonly virtualJoysticks?: readonly VirtualJoystickConfig[];
  /**
   * M2: pointer-lock provider injected by the host (e.g. editor play-runtime).
   * Forwarded to BrowserInputBackendOptions.lockProvider. When absent, the
   * backend falls back to the W3C requestPointerLock() path.
   * Type SSOT is @forgeax/engine-input's PointerLockProvider.
   */
  readonly lockProvider?: PointerLockProvider;
}

export function attachInputAuto(
  canvas: HTMLCanvasElement,
  options: InputAttachOptions = {},
): InputAttachHandle {
  // Mutable slot for error dispatch. The dispatch function is created by
  // createApp AFTER the ErrorFanoutRegistry is set up, so we need an
  // indirection: the backend's onLockError callback fires synchronously
  // inside the click handler, but the fan-out is ready by then because
  // createApp wires it before calling app.start().
  let onLockErrorDispatch: ((err: AppError) => void) | undefined;

  const backendOpts: BrowserInputBackendOptions = {
    ...(options.uiRoot ? { uiRoot: options.uiRoot } : {}),
    ...(options.pointerLockAllowed ? { pointerLockAllowed: options.pointerLockAllowed } : {}),
    ...(options.virtualJoysticks ? { virtualJoysticks: options.virtualJoysticks } : {}),
    ...(options.lockProvider ? { lockProvider: options.lockProvider } : {}),
    onLockError: (detail: { path: 'w3c' | 'provider'; cause: unknown }) => {
      // D-4: wrap the backend's onLockError signal into a structured AppError
      // and fan-out through createApp's onError channel. The dispatch function
      // is installed by setOnErrorDispatch after createApp creates the
      // ErrorFanoutRegistry. If no dispatch is set yet (e.g. during unit tests
      // that don't call setOnErrorDispatch), the error is silently dropped.
      if (onLockErrorDispatch) {
        const err = new AppError({
          code: 'app-pointer-lock-failed',
          expected: APP_EXPECTED['app-pointer-lock-failed'],
          hint: APP_ERROR_HINTS['app-pointer-lock-failed'],
          detail,
        });
        onLockErrorDispatch(err);
      }
    },
  };
  const detach = attachBrowserInputBackend(canvas, backendOpts);
  // Keep one input boundary for both physical and programmatic controls. The
  // composite owns only injected state; the browser backend remains the
  // physical listener owner and is still detached by this handle.
  const backend = makeCompositeBackend(detach.backend);

  let cleanedUp = false;

  return {
    backend,
    setOnErrorDispatch(fn: (err: AppError) => void): void {
      onLockErrorDispatch = fn;
    },
    cleanup(): void {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      backend.revokeInjectedLease();
      detach();
    },
  };
}

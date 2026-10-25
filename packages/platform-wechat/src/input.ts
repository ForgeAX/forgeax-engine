import type { InputBackend, PointerPhaseEvent, PointerSample } from '@forgeax/engine-input';
import {
  type Platform,
  type PlatformError,
  type PlatformRelease,
  platformError,
  releasePlatformResources,
} from '@forgeax/engine-platform';
import { ok, type Result } from '@forgeax/engine-types';
import type { BlitzUiInput } from '@forgeax/engine-ui-blitz';
import { attachWechatKeyboard, type WechatKeyboardSource } from './keyboard.js';

export interface WechatTouch {
  readonly identifier: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly force?: number;
}

export interface WechatTouchEvent {
  readonly changedTouches: readonly WechatTouch[];
}

/** Native touch acquisition only. Keyboard/IME and UI ownership remain separate capabilities. */
export interface WechatTouchSource {
  onTouchStart(listener: (event: WechatTouchEvent) => void): void;
  offTouchStart(listener: (event: WechatTouchEvent) => void): void;
  onTouchMove(listener: (event: WechatTouchEvent) => void): void;
  offTouchMove(listener: (event: WechatTouchEvent) => void): void;
  onTouchEnd(listener: (event: WechatTouchEvent) => void): void;
  offTouchEnd(listener: (event: WechatTouchEvent) => void): void;
  onTouchCancel(listener: (event: WechatTouchEvent) => void): void;
  offTouchCancel(listener: (event: WechatTouchEvent) => void): void;
}

export interface WechatInputOptions {
  readonly ui?: BlitzUiInput;
  readonly keyboard?: WechatKeyboardSource;
  readonly onError?: (error: PlatformError) => void;
}

/** Borrow the platform; the returned InputBackend owns only its native input listeners. */
export function createWechatInputBackend(
  source: WechatTouchSource,
  platform: Platform,
  options: WechatInputOptions = {},
): Result<InputBackend, PlatformError> {
  const pointers = new Map<number, PointerSample>();
  let events: PointerPhaseEvent[] = [];
  let allowed = true;
  let disposed = false;
  let focusReset = false;
  const releases: PlatformRelease[] = [];
  const ui = options.ui;
  let uiOwned = ui?.ownsInput() ?? false;
  const synchronizeOwnership = () => {
    const next = ui?.ownsInput() ?? false;
    if (next !== uiOwned) {
      uiOwned = next;
      clear();
    }
  };

  function clear(): void {
    pointers.clear();
    events = [];
    focusReset = true;
  }

  function accept(phase: PointerPhaseEvent['phase'], event: WechatTouchEvent): void {
    if (disposed || !platform.visible()) return;
    const display = platform.display().unwrap();
    if (display.width === 0 || display.height === 0) {
      clear();
      return;
    }
    // InputSnapshot coordinates use drawing-buffer pixels, matching browser acquisition.
    // Validate the entire native batch before changing any acquired state.
    const batch = event.changedTouches.map((touch) => {
      if (
        !Number.isSafeInteger(touch.identifier) ||
        !Number.isFinite(touch.clientX) ||
        !Number.isFinite(touch.clientY) ||
        (touch.force !== undefined && (!Number.isFinite(touch.force) || touch.force < 0))
      ) {
        throw platformError('platform-operation-failed', {
          operation: 'touch',
          cause: new Error('Native touch identity, position and force must be finite'),
        }).error;
      }
      return {
        pointerId: touch.identifier,
        phase,
        x: (touch.clientX * display.drawingWidth) / display.width,
        y: (touch.clientY * display.drawingHeight) / display.height,
        pressure: phase === 'up' || phase === 'cancel' ? 0 : Math.min(touch.force ?? 0.5, 1),
        pointerType: 'touch' as const,
      };
    });
    for (const [index, point] of batch.entries()) {
      const touch = event.changedTouches[index];
      if (!touch) continue;
      const consumed =
        ui?.pointer({
          phase,
          pointerId: touch.identifier,
          x: touch.clientX,
          y: touch.clientY,
          pointerType: 'touch',
          pressure: point.pressure,
        }) ?? false;
      synchronizeOwnership();
      if (consumed || uiOwned) {
        clear();
        continue;
      }
      if (!allowed) continue;
      const previous = pointers.get(point.pointerId);
      // A contact revoked by hide, UI ownership, or clear cannot re-enter on move/up.
      if (phase !== 'down' && previous === undefined) continue;
      if (phase === 'down' && previous !== undefined) continue;
      events.push(point);
      if (phase === 'up' || phase === 'cancel') {
        pointers.delete(point.pointerId);
      } else {
        pointers.set(point.pointerId, {
          pointerId: point.pointerId,
          pointerType: point.pointerType,
          x: point.x,
          y: point.y,
          pressure: point.pressure,
          active: true,
          delta: {
            x: previous === undefined ? 0 : previous.delta.x + point.x - previous.x,
            y: previous === undefined ? 0 : previous.delta.y + point.y - previous.y,
          },
        });
      }
    }
  }

  const down = (event: WechatTouchEvent) => accept('down', event);
  const move = (event: WechatTouchEvent) => accept('move', event);
  const up = (event: WechatTouchEvent) => accept('up', event);
  const cancel = (event: WechatTouchEvent) => accept('cancel', event);
  try {
    const subscribed = platform.subscribe((event) => {
      if (
        event.kind === 'visibility' ||
        event.kind === 'display' ||
        event.kind === 'surface-lost'
      ) {
        clear();
        // Native keyboard opening also emits resize. Revoke old coordinates,
        // but keep its editor focused instead of immediately hiding the keyboard.
        ui?.cancel({ preserveFocus: event.kind === 'display' });
        synchronizeOwnership();
      }
    });
    if (!subscribed.ok) return subscribed;
    releases.push(subscribed.value);
    if (ui) {
      releases.push(ui.subscribeFocus(synchronizeOwnership));
      if (options.keyboard)
        releases.push(
          attachWechatKeyboard(
            ui,
            options.keyboard,
            options.onError ??
              ((error) => {
                throw error;
              }),
          ),
        );
    }
    releases.push(() => source.offTouchStart(down));
    source.onTouchStart(down);
    releases.push(() => source.offTouchMove(move));
    source.onTouchMove(move);
    releases.push(() => source.offTouchEnd(up));
    source.onTouchEnd(up);
    releases.push(() => source.offTouchCancel(cancel));
    source.onTouchCancel(cancel);
  } catch (cause) {
    disposed = true;
    let cleanupCause: unknown;
    try {
      releasePlatformResources(releases.reverse());
    } catch (failure) {
      cleanupCause = failure;
    }
    return platformError('platform-operation-failed', {
      operation: 'touch.subscribe',
      cause,
      ...(cleanupCause === undefined ? {} : { cleanupCause }),
    });
  }

  return ok({
    sample() {
      if (!disposed) synchronizeOwnership();
      const focused = !disposed && allowed && !uiOwned && platform.visible();
      if (!focused) clear();
      const sample = {
        downKeys: new Set<string>(),
        upKeys: new Set<string>(),
        buttons: [false, false, false] as const,
        movementX: 0,
        movementY: 0,
        wheelDelta: 0,
        pointerLocked: false,
        focused,
        focusReset,
        capabilities: { gamepad: false, pointer: true },
        pointers: [...pointers.values()],
        pointerEvents: events,
      };
      events = [];
      focusReset = false;
      for (const [id, point] of pointers) {
        pointers.set(id, { ...point, delta: { x: 0, y: 0 } });
      }
      return sample;
    },
    clear,
    setInputAllowed(value) {
      if (allowed === value) return;
      allowed = value;
      clear();
    },
    detach() {
      if (disposed) return;
      disposed = true;
      clear();
      releasePlatformResources([() => ui?.cancel(), ...releases.reverse()]);
    },
  });
}

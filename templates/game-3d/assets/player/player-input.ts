import type { InputSnapshot } from '@forgeax/engine/input';

export const PLAYER_CONTROL_CHANNEL = 'game-3d/player-controls';
export type PlayerControl =
  | { readonly kind: 'move'; readonly horizontal: number; readonly vertical: number }
  | { readonly kind: 'look'; readonly x: number; readonly y: number }
  | { readonly kind: 'jump' }
  | { readonly kind: 'run'; readonly held: boolean }
  | { readonly kind: 'reset' };

export interface PlayerInput {
  readonly horizontal: number;
  readonly vertical: number;
  readonly lookX: number;
  readonly lookY: number;
  readonly run: boolean;
}

const bounded = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));

/** UI owns touch gestures; the existing World Update samples bounded semantic intent. */
export function createPlayerInput() {
  let horizontal = 0, vertical = 0, lookX = 0, lookY = 0;
  let run = false, jumpQueued = false, jumpPending = false;
  let previousWidth = 0, previousHeight = 0;
  const reset = () => {
    horizontal = vertical = lookX = lookY = 0;
    run = jumpQueued = jumpPending = false;
  };
  return {
    reset,
    receive(value: unknown): void {
      if (!value || typeof value !== 'object' || !('channel' in value) || value.channel !== PLAYER_CONTROL_CHANNEL) return;
      const message = value as Record<string, unknown>;
      switch (message.kind) {
        case 'move': {
          if (typeof message.horizontal !== 'number' || typeof message.vertical !== 'number' ||
            !Number.isFinite(message.horizontal) || !Number.isFinite(message.vertical)) return;
          const length = Math.max(1, Math.hypot(message.horizontal, message.vertical));
          horizontal = message.horizontal / length;
          vertical = message.vertical / length;
          break;
        }
        case 'look':
          if (typeof message.x !== 'number' || typeof message.y !== 'number' ||
            !Number.isFinite(message.x) || !Number.isFinite(message.y)) return;
          lookX = bounded(lookX + bounded(message.x, 250), 250);
          lookY = bounded(lookY + bounded(message.y, 250), 250);
          break;
        case 'jump': jumpQueued = true; break;
        case 'run': if (typeof message.held === 'boolean') run = message.held; break;
        case 'reset': reset(); break;
      }
    },
    sample(input: InputSnapshot, width: number, height: number): PlayerInput {
      if (previousWidth > 0 && (width !== previousWidth || height !== previousHeight)) reset();
      previousWidth = width;
      previousHeight = height;
      jumpPending ||= jumpQueued || input.keyboard.justPressedCode('Space');
      jumpQueued = false;
      const mouseLook = input.mouse.pointerLocked || input.mouse.button(2);
      const result = {
        horizontal: horizontal + Number(input.keyboard.downCode('KeyD') || input.keyboard.downCode('ArrowRight')) -
          Number(input.keyboard.downCode('KeyA') || input.keyboard.downCode('ArrowLeft')),
        vertical: vertical + Number(input.keyboard.downCode('KeyW') || input.keyboard.downCode('ArrowUp')) -
          Number(input.keyboard.downCode('KeyS') || input.keyboard.downCode('ArrowDown')),
        lookX: lookX + (mouseLook ? input.mouse.movementDelta.x : 0),
        lookY: lookY + (mouseLook ? input.mouse.movementDelta.y : 0),
        run: run || input.keyboard.downCode('ShiftLeft') || input.keyboard.downCode('ShiftRight'),
      };
      lookX = lookY = 0;
      return result;
    },
    takeJump(): boolean {
      const jump = jumpPending;
      jumpPending = false;
      return jump;
    },
  };
}
